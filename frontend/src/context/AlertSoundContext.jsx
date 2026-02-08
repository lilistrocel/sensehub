import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useWebSocket } from './WebSocketContext';
import { useAuth } from './AuthContext';

const AlertSoundContext = createContext(null);

// Sound frequencies for different alert severities
const ALERT_SOUNDS = {
  critical: { frequency: 880, duration: 400, pattern: [1, 0.2, 1, 0.2, 1] }, // Urgent pattern
  warning: { frequency: 660, duration: 300, pattern: [1, 0.3, 1] }, // Two beeps
  info: { frequency: 523, duration: 200, pattern: [1] } // Single chime
};

export function AlertSoundProvider({ children }) {
  const { subscribe } = useWebSocket();
  const { token } = useAuth();
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [volume, setVolume] = useState(0.5);
  const audioContextRef = useRef(null);

  // Load preferences from localStorage on mount
  useEffect(() => {
    const enabled = localStorage.getItem('soundAlertsEnabled') === 'true';
    const vol = parseFloat(localStorage.getItem('soundVolume')) || 0.5;
    setSoundEnabled(enabled);
    setVolume(vol);
  }, []);

  // Fetch preferences from server when token changes
  useEffect(() => {
    const fetchPreferences = async () => {
      if (!token) return;

      try {
        const response = await fetch('/api/users/me/preferences', {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        if (response.ok) {
          const data = await response.json();
          setSoundEnabled(data.sound_alerts_enabled);
          setVolume(data.sound_volume);
          // Also update localStorage
          localStorage.setItem('soundAlertsEnabled', data.sound_alerts_enabled);
          localStorage.setItem('soundVolume', data.sound_volume);
        }
      } catch (err) {
        console.error('Failed to load sound preferences:', err);
      }
    };

    fetchPreferences();
  }, [token]);

  // Play alert sound based on severity
  const playAlertSound = useCallback((severity = 'info') => {
    if (!soundEnabled || volume === 0) return;

    // Initialize audio context on first use (must be after user interaction)
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }

    const audioContext = audioContextRef.current;
    const soundConfig = ALERT_SOUNDS[severity] || ALERT_SOUNDS.info;

    let time = audioContext.currentTime;

    soundConfig.pattern.forEach((item, index) => {
      if (typeof item === 'number' && item === 1) {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.frequency.value = soundConfig.frequency;
        oscillator.type = 'sine';
        gainNode.gain.value = volume * 0.3; // Scale volume

        oscillator.start(time);
        oscillator.stop(time + soundConfig.duration / 1000);

        time += soundConfig.duration / 1000 + 0.1;
      } else if (typeof item === 'number') {
        time += item; // Add pause
      }
    });
  }, [soundEnabled, volume]);

  // Subscribe to new alert WebSocket events
  useEffect(() => {
    if (!subscribe) return;

    const unsubscribe = subscribe('new_alert', (alertData) => {
      console.log('New alert received:', alertData);
      playAlertSound(alertData?.severity || 'info');
    });

    return () => unsubscribe();
  }, [subscribe, playAlertSound]);

  // Update preferences
  const updatePreferences = useCallback((enabled, vol) => {
    setSoundEnabled(enabled);
    setVolume(vol);
    localStorage.setItem('soundAlertsEnabled', enabled);
    localStorage.setItem('soundVolume', vol);
  }, []);

  const value = {
    soundEnabled,
    volume,
    playAlertSound,
    updatePreferences
  };

  return (
    <AlertSoundContext.Provider value={value}>
      {children}
    </AlertSoundContext.Provider>
  );
}

export function useAlertSound() {
  const context = useContext(AlertSoundContext);
  if (!context) {
    throw new Error('useAlertSound must be used within an AlertSoundProvider');
  }
  return context;
}

export default AlertSoundContext;
