import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useAuth } from './AuthContext';

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
      const response = await fetch('/api/settings', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        // Extract timezone from settings
        if (data.timezone?.timezone) {
          setTimezone(data.timezone.timezone);
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

  /**
   * Format a date/timestamp in the configured timezone
   * @param {string|Date} dateValue - The date to format
   * @param {object} options - Optional Intl.DateTimeFormat options
   * @returns {string} Formatted date string
   */
  const formatDateTime = useCallback((dateValue, options = {}) => {
    if (!dateValue) return '-';

    try {
      const date = new Date(dateValue);
      if (isNaN(date.getTime())) return '-';

      const defaultOptions = {
        timeZone: timezone,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        ...options,
      };

      return new Intl.DateTimeFormat('en-US', defaultOptions).format(date);
    } catch (error) {
      console.error('Error formatting date:', error);
      return new Date(dateValue).toLocaleString();
    }
  }, [timezone]);

  /**
   * Format a date only (no time) in the configured timezone
   * @param {string|Date} dateValue - The date to format
   * @returns {string} Formatted date string
   */
  const formatDate = useCallback((dateValue) => {
    return formatDateTime(dateValue, {
      hour: undefined,
      minute: undefined,
      second: undefined,
    });
  }, [formatDateTime]);

  /**
   * Format a time only (no date) in the configured timezone
   * @param {string|Date} dateValue - The date to format
   * @returns {string} Formatted time string
   */
  const formatTime = useCallback((dateValue) => {
    return formatDateTime(dateValue, {
      year: undefined,
      month: undefined,
      day: undefined,
    });
  }, [formatDateTime]);

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
