import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { useAuth } from './AuthContext';

const WebSocketContext = createContext(null);

// Heartbeat interval in milliseconds (30 seconds)
const HEARTBEAT_INTERVAL = 30000;
// Pong timeout - if no pong received within this time, consider connection dead
const PONG_TIMEOUT = 10000;

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

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    // Get WebSocket URL - use same host as current page
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.hostname}:3000/ws`;

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('WebSocket connected');
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
        console.log('WebSocket disconnected');
        setConnected(false);
        wsRef.current = null;
        stopHeartbeat();

        // Attempt to reconnect after 3 seconds
        if (isAuthenticated) {
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, 3000);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('WebSocket connection error:', error);
    }
  }, [isAuthenticated, notifyListeners, startHeartbeat, stopHeartbeat]);

  // Disconnect from WebSocket
  const disconnect = useCallback(() => {
    stopHeartbeat();
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnected(false);
  }, [stopHeartbeat]);

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
