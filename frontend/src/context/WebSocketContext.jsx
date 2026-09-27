import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { useAuth } from './AuthContext';
import { onResume, isTransientNow } from '../utils/connectivity';

const WebSocketContext = createContext(null);

// Heartbeat interval in milliseconds (30 seconds)
const HEARTBEAT_INTERVAL = 30000;
// Pong timeout - if no pong received within this time, consider connection dead
const PONG_TIMEOUT = 10000;
// Reconnect backoff: 3 s (the previous fixed delay), doubling to a 30 s cap, with jitter.
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 30000;
// On resume an "open" socket may be half-open (phone froze the tab, the tunnel
// dropped it). Probe it: no pong within this window -> reconnect now.
const RESUME_PROBE_TIMEOUT_MS = 3500;
// A socket stuck CONNECTING this long on resume is abandoned and retried.
const CONNECTING_STALE_MS = 5000;

export function WebSocketProvider({ children }) {
  const { isAuthenticated } = useAuth();
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState(null);
  const wsRef = useRef(null);
  const listenersRef = useRef({});
  const reconnectTimeoutRef = useRef(null);
  const heartbeatIntervalRef = useRef(null);
  const pongTimeoutRef = useRef(null);
  const missedPongsRef = useRef(0);
  const reconnectAttemptsRef = useRef(0);
  const resumeProbeRef = useRef(null);
  const connectStartedAtRef = useRef(0);
  const isAuthRef = useRef(isAuthenticated);
  isAuthRef.current = isAuthenticated;

  // Subscribe to specific event types
  const subscribe = useCallback((eventType, callback) => {
    if (!listenersRef.current[eventType]) {
      listenersRef.current[eventType] = [];
    }
    listenersRef.current[eventType].push(callback);

    // Return unsubscribe function
    return () => {
      listenersRef.current[eventType] = listenersRef.current[eventType].filter(
        cb => cb !== callback
      );
    };
  }, []);

  // Notify all listeners of a specific event type
  const notifyListeners = useCallback((eventType, data) => {
    const listeners = listenersRef.current[eventType] || [];
    listeners.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    });
  }, []);

  // Start heartbeat mechanism
  const startHeartbeat = useCallback(() => {
    // Clear any existing intervals
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }
    if (pongTimeoutRef.current) {
      clearTimeout(pongTimeoutRef.current);
    }

    missedPongsRef.current = 0;

    heartbeatIntervalRef.current = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        // Send ping
        wsRef.current.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));

        // Set timeout for pong response
        pongTimeoutRef.current = setTimeout(() => {
          missedPongsRef.current++;
          console.warn(`WebSocket: Missed pong response (${missedPongsRef.current})`);

          // If we've missed 2 pongs, force reconnect
          if (missedPongsRef.current >= 2) {
            console.warn('WebSocket: Connection appears stale, forcing reconnect');
            if (wsRef.current) {
              wsRef.current.close();
            }
          }
        }, PONG_TIMEOUT);
      }
    }, HEARTBEAT_INTERVAL);
  }, []);

  // Stop heartbeat mechanism
  const stopHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (pongTimeoutRef.current) {
      clearTimeout(pongTimeoutRef.current);
      pongTimeoutRef.current = null;
    }
    missedPongsRef.current = 0;
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  // Connect to WebSocket
  const connect = useCallback(() => {
    // Never run two sockets: an OPEN or CONNECTING one is left alone.
    const rs = wsRef.current?.readyState;
    if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) {
      return;
    }
    clearReconnectTimer();

    // Get WebSocket URL - use same host and port as current page (works with Tailscale, reverse proxy, etc.)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host; // includes port if non-standard
    const wsUrl = `${protocol}//${host}/ws`;

    try {
      const ws = new WebSocket(wsUrl);
      connectStartedAtRef.current = Date.now();

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        console.log('WebSocket connected');
        reconnectAttemptsRef.current = 0;
        setConnected(true);
        startHeartbeat();
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          // Handle pong response - clear the timeout and reset missed count
          if (message.type === 'pong') {
            if (pongTimeoutRef.current) {
              clearTimeout(pongTimeoutRef.current);
              pongTimeoutRef.current = null;
            }
            if (resumeProbeRef.current) {
              clearTimeout(resumeProbeRef.current);
              resumeProbeRef.current = null;
            }
            missedPongsRef.current = 0;
            return; // Don't process pong as a regular message
          }

          setLastMessage(message);

          // Notify listeners based on message type
          if (message.type) {
            notifyListeners(message.type, message.data);
            // Also notify generic 'message' listeners
            notifyListeners('message', message);
          }
        } catch (error) {
          console.error('WebSocket message parse error:', error);
        }
      };

      ws.onclose = () => {
        // A socket we already replaced (resume probe) must not tear down its successor.
        if (wsRef.current !== ws) return;
        console.log('WebSocket disconnected');
        setConnected(false);
        wsRef.current = null;
        stopHeartbeat();
        if (resumeProbeRef.current) {
          clearTimeout(resumeProbeRef.current);
          resumeProbeRef.current = null;
        }

        // Reconnect with backoff (3 s, 6 s, 12 s ... 30 s, jittered). A resume
        // (tab visible again / back online) reconnects immediately instead.
        if (isAuthRef.current) {
          const n = reconnectAttemptsRef.current++;
          const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** n) * (0.8 + Math.random() * 0.4);
          clearReconnectTimer();
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null;
            connect();
          }, delay);
        }
      };

      ws.onerror = (error) => {
        // Expected while a phone resumes (socket died in the background): not an error then.
        if (isTransientNow()) console.warn('WebSocket error (transient, will reconnect)');
        else console.error('WebSocket error:', error);
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('WebSocket connection error:', error);
    }
  }, [notifyListeners, startHeartbeat, stopHeartbeat, clearReconnectTimer]);

  // Disconnect from WebSocket
  const disconnect = useCallback(() => {
    stopHeartbeat();
    clearReconnectTimer();
    if (resumeProbeRef.current) {
      clearTimeout(resumeProbeRef.current);
      resumeProbeRef.current = null;
    }
    if (wsRef.current) {
      const ws = wsRef.current;
      wsRef.current = null; // onclose sees a replaced socket and does not reconnect
      ws.close();
    }
    setConnected(false);
  }, [stopHeartbeat, clearReconnectTimer]);

  // Drop the current socket (dead or half-open) and connect a fresh one now.
  const reconnectNow = useCallback(() => {
    const old = wsRef.current;
    if (old) {
      wsRef.current = null;
      stopHeartbeat();
      setConnected(false);
      try { old.close(); } catch { /* ignore */ }
    }
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect, stopHeartbeat]);

  // Tab visible again / back online: the socket probably died in the background.
  // Reconnect at once if it is closed; if it claims to be open, prove it with a
  // ping and reconnect when no pong comes back. Listeners live in listenersRef,
  // so every subscription carries over to the new socket unchanged.
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    return onResume(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        reconnectNow();
        return;
      }
      if (ws.readyState === WebSocket.CONNECTING) {
        if (Date.now() - connectStartedAtRef.current > CONNECTING_STALE_MS) reconnectNow();
        return;
      }
      try {
        ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      } catch {
        reconnectNow();
        return;
      }
      if (resumeProbeRef.current) clearTimeout(resumeProbeRef.current);
      resumeProbeRef.current = setTimeout(() => {
        resumeProbeRef.current = null;
        if (wsRef.current === ws) {
          console.warn('WebSocket: no pong after resume, reconnecting');
          reconnectNow();
        }
      }, RESUME_PROBE_TIMEOUT_MS);
    });
  }, [isAuthenticated, reconnectNow]);

  // Send a message through WebSocket
  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  // Connect when authenticated, disconnect when not
  useEffect(() => {
    if (isAuthenticated) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      disconnect();
    };
  }, [isAuthenticated, connect, disconnect]);

  const value = {
    connected,
    lastMessage,
    subscribe,
    send
  };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket() {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
}

export default WebSocketContext;
