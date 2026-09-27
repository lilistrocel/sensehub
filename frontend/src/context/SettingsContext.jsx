import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from './AuthContext';
import {
  formatDateTime as fmtDateTime,
  formatDate as fmtDate,
  formatTime as fmtTime,
  formatClock as fmtClock,
  formatRelativeTime as fmtRelative,
} from '../i18n/format';

const SettingsContext = createContext(null);

export function SettingsProvider({ children }) {
  const { token, isAuthenticated } = useAuth();
  const [timezone, setTimezone] = useState('UTC');
  const [loading, setLoading] = useState(true);

  const fetchSettings = useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }

    try {
      // Use the public timezone endpoint (accessible to all authenticated users)
      const response = await fetch('/api/auth/setup/timezone', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        if (data.timezone) {
          setTimezone(data.timezone);
        }
      }
    } catch (error) {
      console.error('Failed to fetch settings:', error);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (isAuthenticated) {
      fetchSettings();
    } else {
      setLoading(false);
    }
  }, [isAuthenticated, fetchSettings]);

  // Formatters: the configured farm timezone + the active UI language
  // (src/i18n/format.js). English output is unchanged (en-US); tr/ar get
  // localized month names, 24 h clocks and Western digits.
  const { i18n } = useTranslation(undefined, { useSuspense: false });
  const lng = i18n.language;

  /**
   * Format a date/timestamp in the configured timezone
   * @param {string|Date} dateValue - The date to format
   * @param {object} options - Optional Intl.DateTimeFormat options (a field set to undefined is dropped)
   * @returns {string} Formatted date string ('-' when missing)
   */
  const formatDateTime = useCallback(
    (dateValue, options = {}) => fmtDateTime(dateValue, { ...options, timeZone: timezone, lng }),
    [timezone, lng],
  );

  /** Date only (no time) in the configured timezone. */
  const formatDate = useCallback((dateValue) => fmtDate(dateValue, { timeZone: timezone, lng }), [timezone, lng]);

  /** Time only (with seconds) in the configured timezone. */
  const formatTime = useCallback((dateValue) => fmtTime(dateValue, { timeZone: timezone, lng }), [timezone, lng]);

  /** Time without seconds ("14:05" / "02:05 PM"). */
  const formatClock = useCallback((dateValue) => fmtClock(dateValue, { timeZone: timezone, lng }), [timezone, lng]);

  /**
   * Relative time ("5 minutes ago", localized) for timestamps younger than
   * `threshold` hours, otherwise the full date-time.
   */
  const formatRelativeTime = useCallback(
    (dateValue, threshold = 24) => fmtRelative(dateValue, { thresholdHours: threshold, timeZone: timezone, lng }),
    [timezone, lng],
  );

  /**
   * Refresh settings from the server
   */
  const refreshSettings = useCallback(() => {
    fetchSettings();
  }, [fetchSettings]);

  const value = {
    timezone,
    loading,
    formatDateTime,
    formatDate,
    formatTime,
    formatClock,
    formatRelativeTime,
    refreshSettings,
  };

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}

export default SettingsContext;
