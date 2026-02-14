import React, { useState } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Users from './settings/Users';
import Profile from './settings/Profile';

const API_BASE = '/api';

// Settings navigation tabs
const settingsTabs = [
  { name: 'Profile', path: 'profile', adminOnly: false, icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
    </svg>
  )},
  { name: 'Users', path: 'users', adminOnly: true, icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  )},
  { name: 'System', path: 'system', adminOnly: true, icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )},
  { name: 'Cloud', path: 'cloud', adminOnly: true, icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
    </svg>
  )},
  { name: 'Backup', path: 'backup', adminOnly: true, icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
    </svg>
  )},
];

function SystemSettings() {
  const { token } = useAuth();
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState(null);
  const [timezone, setTimezone] = useState('UTC');
  const [locale, setLocale] = useState('en-US');
  const [dataRetention, setDataRetention] = useState(30);
  const [storageInfo, setStorageInfo] = useState(null);
  const [storageLoading, setStorageLoading] = useState(true);
  const [systemInfo, setSystemInfo] = useState(null);
  const [systemInfoLoading, setSystemInfoLoading] = useState(true);
  const [systemLogs, setSystemLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [logsFilter, setLogsFilter] = useState('all');
  const [networkInfo, setNetworkInfo] = useState(null);
  const [networkLoading, setNetworkLoading] = useState(true);

  // Common timezones grouped by region
  const timezones = [
    { group: 'Americas', options: [
      { value: 'America/New_York', label: 'Eastern Time (US & Canada)' },
      { value: 'America/Chicago', label: 'Central Time (US & Canada)' },
      { value: 'America/Denver', label: 'Mountain Time (US & Canada)' },
      { value: 'America/Los_Angeles', label: 'Pacific Time (US & Canada)' },
      { value: 'America/Anchorage', label: 'Alaska' },
      { value: 'America/Phoenix', label: 'Arizona (no DST)' },
      { value: 'Pacific/Honolulu', label: 'Hawaii' },
      { value: 'America/Toronto', label: 'Eastern Time (Canada)' },
      { value: 'America/Vancouver', label: 'Pacific Time (Canada)' },
      { value: 'America/Mexico_City', label: 'Mexico City' },
      { value: 'America/Sao_Paulo', label: 'São Paulo' },
      { value: 'America/Buenos_Aires', label: 'Buenos Aires' },
    ]},
    { group: 'Europe', options: [
      { value: 'Europe/London', label: 'London (GMT/BST)' },
      { value: 'Europe/Paris', label: 'Paris (CET)' },
      { value: 'Europe/Berlin', label: 'Berlin (CET)' },
      { value: 'Europe/Amsterdam', label: 'Amsterdam (CET)' },
      { value: 'Europe/Madrid', label: 'Madrid (CET)' },
      { value: 'Europe/Rome', label: 'Rome (CET)' },
      { value: 'Europe/Zurich', label: 'Zurich (CET)' },
      { value: 'Europe/Stockholm', label: 'Stockholm (CET)' },
      { value: 'Europe/Warsaw', label: 'Warsaw (CET)' },
      { value: 'Europe/Athens', label: 'Athens (EET)' },
      { value: 'Europe/Moscow', label: 'Moscow (MSK)' },
    ]},
    { group: 'Asia', options: [
      { value: 'Asia/Dubai', label: 'Dubai (GST)' },
      { value: 'Asia/Kolkata', label: 'India (IST)' },
      { value: 'Asia/Singapore', label: 'Singapore (SGT)' },
      { value: 'Asia/Hong_Kong', label: 'Hong Kong (HKT)' },
      { value: 'Asia/Shanghai', label: 'China (CST)' },
      { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
      { value: 'Asia/Seoul', label: 'Seoul (KST)' },
      { value: 'Asia/Bangkok', label: 'Bangkok (ICT)' },
      { value: 'Asia/Jakarta', label: 'Jakarta (WIB)' },
    ]},
    { group: 'Pacific & Oceania', options: [
      { value: 'Australia/Sydney', label: 'Sydney (AEST/AEDT)' },
      { value: 'Australia/Melbourne', label: 'Melbourne (AEST/AEDT)' },
      { value: 'Australia/Brisbane', label: 'Brisbane (AEST)' },
      { value: 'Australia/Perth', label: 'Perth (AWST)' },
      { value: 'Australia/Adelaide', label: 'Adelaide (ACST/ACDT)' },
      { value: 'Pacific/Auckland', label: 'Auckland (NZST/NZDT)' },
      { value: 'Pacific/Fiji', label: 'Fiji' },
    ]},
    { group: 'Africa', options: [
      { value: 'Africa/Cairo', label: 'Cairo (EET)' },
      { value: 'Africa/Johannesburg', label: 'Johannesburg (SAST)' },
      { value: 'Africa/Lagos', label: 'Lagos (WAT)' },
      { value: 'Africa/Nairobi', label: 'Nairobi (EAT)' },
    ]},
    { group: 'Other', options: [
      { value: 'UTC', label: 'UTC (Coordinated Universal Time)' },
    ]},
  ];

  // Locale options
  const locales = [
    { value: 'en-US', label: 'English (US)' },
    { value: 'en-GB', label: 'English (UK)' },
    { value: 'de-DE', label: 'German' },
    { value: 'fr-FR', label: 'French' },
    { value: 'es-ES', label: 'Spanish' },
    { value: 'pt-BR', label: 'Portuguese (Brazil)' },
    { value: 'ja-JP', label: 'Japanese' },
    { value: 'zh-CN', label: 'Chinese (Simplified)' },
    { value: 'ko-KR', label: 'Korean' },
  ];

  const fetchSettings = async () => {
    try {
      const response = await fetch(`${API_BASE}/settings`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Failed to fetch settings');
      const data = await response.json();
      setSettings(data);

      // Extract timezone from settings
      if (data.timezone?.timezone) {
        setTimezone(data.timezone.timezone);
      }
      if (data.locale) {
        setLocale(data.locale);
      }
      if (data.dataRetention) {
        setDataRetention(data.dataRetention);
      }

      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchStorage = async () => {
    try {
      const response = await fetch(`${API_BASE}/settings/storage`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Failed to fetch storage info');
      const data = await response.json();
      setStorageInfo(data);
    } catch (err) {
      console.error('Error fetching storage:', err);
    } finally {
      setStorageLoading(false);
    }
  };

  const fetchSystemInfo = async () => {
    try {
      const response = await fetch(`${API_BASE}/system/info`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Failed to fetch system info');
      const data = await response.json();
      setSystemInfo(data);
    } catch (err) {
      console.error('Error fetching system info:', err);
    } finally {
      setSystemInfoLoading(false);
    }
  };

  const fetchNetwork = async () => {
    try {
      const response = await fetch(`${API_BASE}/settings/network`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Failed to fetch network info');
      const data = await response.json();
      setNetworkInfo(data);
    } catch (err) {
      console.error('Error fetching network info:', err);
    } finally {
      setNetworkLoading(false);
    }
  };

  const fetchLogs = async (filterLevel = logsFilter) => {
    setLogsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/system/logs?level=${filterLevel}&limit=100`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Failed to fetch logs');
      const data = await response.json();
      setSystemLogs(data.logs || []);
    } catch (err) {
      console.error('Error fetching logs:', err);
    } finally {
      setLogsLoading(false);
    }
  };

  // Helper function to format bytes
  const formatBytes = (bytes, decimals = 2) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  };

  // Helper function to format uptime in human-readable format
  const formatUptime = (seconds) => {
    if (!seconds) return 'N/A';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

    return parts.join(' ');
  };

  React.useEffect(() => {
    fetchSettings();
    fetchStorage();
    fetchSystemInfo();
    fetchLogs();
    fetchNetwork();
  }, [token]);

  const handleSave = async () => {
    setSaving(true);
    setSuccessMessage(null);
    setError(null);

    try {
      const response = await fetch(`${API_BASE}/settings`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          timezone: { timezone, updatedAt: new Date().toISOString() },
          locale,
          dataRetention
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to save settings');
      }

      setSuccessMessage('Settings saved successfully!');
      fetchSettings(); // Refresh settings
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // Get current time in selected timezone
  const getCurrentTime = () => {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short'
      }).format(new Date());
    } catch {
      return 'Invalid timezone';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <svg className="animate-spin h-8 w-8 text-primary-600" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-4">System Settings</h2>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
          {error}
        </div>
      )}

      {successMessage && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-800 text-sm flex items-center">
          <svg className="h-5 w-5 mr-2 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {successMessage}
        </div>
      )}

      {/* Timezone Settings */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h3 className="text-md font-medium text-gray-900 mb-4 flex items-center">
          <svg className="h-5 w-5 mr-2 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Timezone Configuration
        </h3>

        <p className="text-sm text-gray-500 mb-4">
          Select the timezone for all system timestamps and scheduled automations.
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor="timezone" className="block text-sm font-medium text-gray-700 mb-1">
              System Timezone
            </label>
            <select
              id="timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
            >
              {timezones.map((group) => (
                <optgroup key={group.group} label={group.group}>
                  {group.options.map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {tz.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {/* Time Preview */}
          <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
            <p className="text-sm text-gray-500 mb-1">Current time in selected timezone:</p>
            <p className="text-lg font-medium text-gray-900">{getCurrentTime()}</p>
          </div>
        </div>
      </div>

      {/* Locale Settings */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h3 className="text-md font-medium text-gray-900 mb-4 flex items-center">
          <svg className="h-5 w-5 mr-2 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
          </svg>
          Locale & Language
        </h3>

        <p className="text-sm text-gray-500 mb-4">
          Select the language and regional format for dates and numbers.
        </p>

        <div>
          <label htmlFor="locale" className="block text-sm font-medium text-gray-700 mb-1">
            Language / Locale
          </label>
          <select
            id="locale"
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
          >
            {locales.map((loc) => (
              <option key={loc.value} value={loc.value}>
                {loc.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Data Retention Settings */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h3 className="text-md font-medium text-gray-900 mb-4 flex items-center">
          <svg className="h-5 w-5 mr-2 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
          </svg>
          Data Retention
        </h3>

        <p className="text-sm text-gray-500 mb-4">
          Configure how long sensor readings and historical data are retained locally.
        </p>

        <div>
          <label htmlFor="dataRetention" className="block text-sm font-medium text-gray-700 mb-1">
            Retention Period (days)
          </label>
          <select
            id="dataRetention"
            value={dataRetention}
            onChange={(e) => setDataRetention(parseInt(e.target.value))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
          >
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days (default)</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={365}>365 days (1 year)</option>
          </select>
          <p className="mt-1 text-xs text-gray-500">
            Data older than this will be automatically purged to save storage space.
          </p>
        </div>
      </div>

      {/* Network Configuration Section */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-gray-900 flex items-center">
            <svg className="h-5 w-5 mr-2 text-teal-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
            Network Configuration
          </h3>
          <button
            onClick={fetchNetwork}
            disabled={networkLoading}
            className="text-gray-400 hover:text-gray-600"
            title="Refresh network info"
          >
            <svg className={`h-5 w-5 ${networkLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-500 mb-4">
          View current network configuration for this SenseHub device.
        </p>

        {networkLoading ? (
          <div className="flex items-center justify-center py-8">
            <svg className="animate-spin h-6 w-6 text-primary-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
        ) : networkInfo ? (
          <div className="space-y-4">
            {/* Primary Network Info */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-teal-50 rounded-lg p-4 border border-teal-200">
                <div className="flex items-center mb-2">
                  <svg className="h-5 w-5 mr-2 text-teal-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span className="text-sm font-medium text-teal-700">IP Address</span>
                </div>
                <p className="text-xl font-bold text-teal-900 font-mono">{networkInfo.ipAddress}</p>
              </div>

              <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                <div className="flex items-center mb-2">
                  <svg className="h-5 w-5 mr-2 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 14v3m4-3v3m4-3v3M3 21h18M3 10h18M3 7l9-4 9 4M4 10h16v11H4V10z" />
                  </svg>
                  <span className="text-sm font-medium text-blue-700">Gateway</span>
                </div>
                <p className="text-xl font-bold text-blue-900 font-mono">{networkInfo.gateway}</p>
              </div>

              <div className="bg-purple-50 rounded-lg p-4 border border-purple-200">
                <div className="flex items-center mb-2">
                  <svg className="h-5 w-5 mr-2 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
                  </svg>
                  <span className="text-sm font-medium text-purple-700">DNS Servers</span>
                </div>
                <div className="space-y-1">
                  {networkInfo.dns && networkInfo.dns.map((dns, index) => (
                    <p key={index} className="text-lg font-bold text-purple-900 font-mono">{dns}</p>
                  ))}
                </div>
              </div>
            </div>

            {/* Network Interfaces */}
            {networkInfo.interfaces && networkInfo.interfaces.length > 0 && (
              <div className="border-t border-gray-200 pt-4">
                <h4 className="text-sm font-medium text-gray-700 mb-3">Network Interfaces</h4>
                <div className="space-y-3">
                  {networkInfo.interfaces.map((iface, index) => (
                    <div key={index} className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-semibold text-gray-900">{iface.name}</span>
                        <span className="px-2 py-1 bg-green-100 text-green-800 text-xs font-medium rounded-full">Active</span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
                        <div>
                          <span className="text-gray-500">IP Address: </span>
                          <span className="font-mono text-gray-900">{iface.address}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Netmask: </span>
                          <span className="font-mono text-gray-900">{iface.netmask}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">MAC: </span>
                          <span className="font-mono text-gray-900">{iface.mac}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
            <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
            <p className="mt-2 text-gray-500">Unable to load network information</p>
          </div>
        )}
      </div>

      {/* Firmware/Version Section */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-gray-900 flex items-center">
            <svg className="h-5 w-5 mr-2 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
            Firmware / Version
          </h3>
          <button
            onClick={fetchSystemInfo}
            disabled={systemInfoLoading}
            className="text-gray-400 hover:text-gray-600"
            title="Refresh system info"
          >
            <svg className={`h-5 w-5 ${systemInfoLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-500 mb-4">
          View current firmware version and system information.
        </p>

        {systemInfoLoading ? (
          <div className="flex items-center justify-center py-8">
            <svg className="animate-spin h-6 w-6 text-primary-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
        ) : systemInfo ? (
          <div className="space-y-4">
            {/* Version Info */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-indigo-50 rounded-lg p-4 border border-indigo-200">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-indigo-700">Version</span>
                  <span className="px-2 py-1 bg-indigo-100 text-indigo-800 text-xs font-medium rounded-full">
                    {systemInfo.releaseType || 'stable'}
                  </span>
                </div>
                <p className="text-2xl font-bold text-indigo-900">v{systemInfo.version}</p>
                {systemInfo.codename && (
                  <p className="text-sm text-indigo-600 mt-1">"{systemInfo.codename}"</p>
                )}
              </div>

              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <span className="text-sm font-medium text-gray-700">Build Date</span>
                <p className="text-lg font-semibold text-gray-900 mt-2">
                  {systemInfo.buildDate ? new Date(systemInfo.buildDate).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                  }) : 'N/A'}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {systemInfo.buildDate ? new Date(systemInfo.buildDate).toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZoneName: 'short'
                  }) : ''}
                </p>
              </div>
            </div>

            {/* System Details */}
            <div className="border-t border-gray-200 pt-4">
              <h4 className="text-sm font-medium text-gray-700 mb-3">System Details</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                  <p className="text-xs text-gray-500">Platform</p>
                  <p className="text-sm font-semibold text-gray-900 capitalize">{systemInfo.platform}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                  <p className="text-xs text-gray-500">Architecture</p>
                  <p className="text-sm font-semibold text-gray-900">{systemInfo.arch}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                  <p className="text-xs text-gray-500">Node.js</p>
                  <p className="text-sm font-semibold text-gray-900">{systemInfo.node_version}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                  <p className="text-xs text-gray-500">CPUs</p>
                  <p className="text-sm font-semibold text-gray-900">{systemInfo.cpus} cores</p>
                </div>
              </div>
            </div>

            {/* Runtime Info */}
            <div className="border-t border-gray-200 pt-4">
              <h4 className="text-sm font-medium text-gray-700 mb-3">Runtime</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                  <p className="text-xs text-gray-500">Hostname</p>
                  <p className="text-sm font-semibold text-gray-900">{systemInfo.hostname}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                  <p className="text-xs text-gray-500">Uptime</p>
                  <p className="text-sm font-semibold text-gray-900">{formatUptime(systemInfo.uptime)}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                  <p className="text-xs text-gray-500">Started At</p>
                  <p className="text-sm font-semibold text-gray-900">
                    {systemInfo.startedAt ? new Date(systemInfo.startedAt).toLocaleString() : 'N/A'}
                  </p>
                </div>
              </div>
            </div>

            {/* Memory Info */}
            {systemInfo.memory && (
              <div className="border-t border-gray-200 pt-4">
                <h4 className="text-sm font-medium text-gray-700 mb-3">Memory Usage</h4>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-gray-600">
                    {formatBytes(systemInfo.memory.used)} / {formatBytes(systemInfo.memory.total)}
                  </span>
                  <span className="text-sm text-gray-500">
                    {((systemInfo.memory.used / systemInfo.memory.total) * 100).toFixed(1)}% used
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-3">
                  <div
                    className="h-3 rounded-full bg-indigo-500 transition-all"
                    style={{ width: `${(systemInfo.memory.used / systemInfo.memory.total) * 100}%` }}
                  ></div>
                </div>
              </div>
            )}

            {/* Database Status */}
            {systemInfo.database && (
              <div className="border-t border-gray-200 pt-4">
                <h4 className="text-sm font-medium text-gray-700 mb-3">Database</h4>
                <div className="flex items-center space-x-4">
                  <div className="flex items-center">
                    <div className={`w-3 h-3 rounded-full mr-2 ${systemInfo.database.connected ? 'bg-green-500' : 'bg-red-500'}`}></div>
                    <span className="text-sm text-gray-900">
                      {systemInfo.database.connected ? 'Connected' : 'Disconnected'}
                    </span>
                  </div>
                  <span className="text-sm text-gray-500">{systemInfo.database.path}</span>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
            <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
            <p className="mt-2 text-gray-500">Unable to load system information</p>
          </div>
        )}
      </div>

      {/* Storage Usage Section */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-gray-900 flex items-center">
            <svg className="h-5 w-5 mr-2 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
            </svg>
            Storage Usage
          </h3>
          <button
            onClick={fetchStorage}
            disabled={storageLoading}
            className="text-gray-400 hover:text-gray-600"
            title="Refresh storage info"
          >
            <svg className={`h-5 w-5 ${storageLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-500 mb-4">
          View system storage usage and database statistics.
        </p>

        {storageLoading ? (
          <div className="flex items-center justify-center py-8">
            <svg className="animate-spin h-6 w-6 text-primary-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
        ) : storageInfo ? (
          <div className="space-y-6">
            {/* Disk Usage Overview */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">Disk Usage</span>
                <span className="text-sm text-gray-500">
                  {formatBytes(storageInfo.disk.used)} / {formatBytes(storageInfo.disk.total)}
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-4 overflow-hidden">
                <div
                  className={`h-4 rounded-full transition-all ${
                    storageInfo.disk.percentUsed > 90 ? 'bg-red-500' :
                    storageInfo.disk.percentUsed > 70 ? 'bg-amber-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${storageInfo.disk.percentUsed}%` }}
                ></div>
              </div>
              <div className="flex justify-between mt-1 text-xs text-gray-500">
                <span>{storageInfo.disk.percentUsed}% used</span>
                <span>{formatBytes(storageInfo.disk.available)} available</span>
              </div>
            </div>

            {/* Storage Breakdown */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <div className="flex items-center mb-2">
                  <svg className="h-5 w-5 mr-2 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                  </svg>
                  <span className="text-sm font-medium text-gray-700">Database</span>
                </div>
                <p className="text-2xl font-bold text-gray-900">{formatBytes(storageInfo.database.size)}</p>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <div className="flex items-center mb-2">
                  <svg className="h-5 w-5 mr-2 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  <span className="text-sm font-medium text-gray-700">Data Directory</span>
                </div>
                <p className="text-2xl font-bold text-gray-900">{formatBytes(storageInfo.dataDirectory.size)}</p>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <div className="flex items-center mb-2">
                  <svg className="h-5 w-5 mr-2 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span className="text-sm font-medium text-gray-700">Logs</span>
                </div>
                <p className="text-2xl font-bold text-gray-900">{formatBytes(storageInfo.logsDirectory.size)}</p>
              </div>
            </div>

            {/* Database Table Statistics */}
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-3">Database Records</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {storageInfo.tableStats && Object.entries(storageInfo.tableStats).map(([table, count]) => (
                  <div key={table} className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                    <p className="text-xs text-gray-500 capitalize">{table.replace('_', ' ')}</p>
                    <p className="text-lg font-semibold text-gray-900">{count.toLocaleString()}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Last Updated */}
            <p className="text-xs text-gray-400 text-right">
              Last updated: {new Date(storageInfo.timestamp).toLocaleString()}
            </p>
          </div>
        ) : (
          <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
            <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
            </svg>
            <p className="mt-2 text-gray-500">Unable to load storage information</p>
          </div>
        )}
      </div>

      {/* System Logs Section */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-gray-900 flex items-center">
            <svg className="h-5 w-5 mr-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            System Logs
          </h3>
          <div className="flex items-center space-x-3">
            {/* Log Level Filter */}
            <select
              value={logsFilter}
              onChange={(e) => {
                setLogsFilter(e.target.value);
                fetchLogs(e.target.value);
              }}
              className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:ring-primary-500 focus:border-primary-500"
            >
              <option value="all">All Levels</option>
              <option value="error">Error & Above</option>
              <option value="warning">Warning & Above</option>
              <option value="info">Info & Above</option>
              <option value="debug">Debug</option>
            </select>
            {/* Refresh Button */}
            <button
              onClick={() => fetchLogs()}
              disabled={logsLoading}
              className="text-gray-400 hover:text-gray-600"
              title="Refresh logs"
            >
              <svg className={`h-5 w-5 ${logsLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        </div>

        <p className="text-sm text-gray-500 mb-4">
          View system event logs, alerts, and automation activity.
        </p>

        {logsLoading ? (
          <div className="flex items-center justify-center py-8">
            <svg className="animate-spin h-6 w-6 text-primary-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
        ) : systemLogs.length > 0 ? (
          <div className="space-y-2">
            {/* Logs Container with Scroll */}
            <div className="bg-gray-900 rounded-lg p-4 max-h-96 overflow-y-auto font-mono text-sm">
              {systemLogs.map((log, index) => (
                <div key={index} className="flex items-start space-x-3 py-1 border-b border-gray-800 last:border-0">
                  {/* Timestamp */}
                  <span className="text-gray-500 text-xs whitespace-nowrap">
                    {new Date(log.timestamp).toLocaleString()}
                  </span>
                  {/* Log Level Badge */}
                  <span className={`px-2 py-0.5 text-xs font-medium rounded uppercase ${
                    log.level === 'error' ? 'bg-red-900 text-red-200' :
                    log.level === 'warning' ? 'bg-amber-900 text-amber-200' :
                    log.level === 'debug' ? 'bg-purple-900 text-purple-200' :
                    'bg-blue-900 text-blue-200'
                  }`}>
                    {log.level}
                  </span>
                  {/* Source Badge */}
                  {log.source && (
                    <span className="px-2 py-0.5 text-xs font-medium rounded bg-gray-700 text-gray-300">
                      {log.source}
                    </span>
                  )}
                  {/* Message */}
                  <span className={`flex-1 ${
                    log.level === 'error' ? 'text-red-400' :
                    log.level === 'warning' ? 'text-amber-400' :
                    'text-gray-300'
                  }`}>
                    {log.message}
                  </span>
                </div>
              ))}
            </div>
            {/* Log Count */}
            <p className="text-xs text-gray-400 text-right">
              Showing {systemLogs.length} log entries
            </p>
          </div>
        ) : (
          <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
            <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="mt-2 text-gray-500">No log entries found</p>
          </div>
        )}
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
        >
          {saving ? (
            <>
              <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Saving...
            </>
          ) : (
            <>
              <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Save Settings
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function CloudSettings() {
  const { token } = useAuth();
  const [cloudStatus, setCloudStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [connectLoading, setConnectLoading] = useState(false);
  const [connectForm, setConnectForm] = useState({ url: '', apiKey: '' });
  const [connectError, setConnectError] = useState(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncMessage, setSyncMessage] = useState(null);
  const [suggestedPrograms, setSuggestedPrograms] = useState([]);
  const [suggestedLoading, setSuggestedLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [programMessage, setProgramMessage] = useState(null);
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [syncHistory, setSyncHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [pendingQueue, setPendingQueue] = useState([]);
  const [queueLoading, setQueueLoading] = useState(false);

  const fetchPendingQueue = async () => {
    setQueueLoading(true);
    try {
      const response = await fetch(`${API_BASE}/cloud/pending`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Failed to fetch pending queue');
      const data = await response.json();
      setPendingQueue(data);
    } catch (err) {
      console.error('Error fetching pending queue:', err);
    } finally {
      setQueueLoading(false);
    }
  };

  const fetchSyncHistory = async () => {
    setHistoryLoading(true);
    try {
      const response = await fetch(`${API_BASE}/cloud/sync-history?limit=10`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Failed to fetch sync history');
      const data = await response.json();
      setSyncHistory(data);
    } catch (err) {
      console.error('Error fetching sync history:', err);
    } finally {
      setHistoryLoading(false);
    }
  };

  const fetchCloudStatus = async () => {
    try {
      const response = await fetch(`${API_BASE}/cloud/status`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Failed to fetch cloud status');
      const data = await response.json();
      setCloudStatus(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchSuggestedPrograms = async () => {
    setSuggestedLoading(true);
    try {
      const response = await fetch(`${API_BASE}/cloud/suggested-programs?status=pending`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Failed to fetch suggested programs');
      const data = await response.json();
      setSuggestedPrograms(data);
    } catch (err) {
      console.error('Error fetching suggested programs:', err);
    } finally {
      setSuggestedLoading(false);
    }
  };

  const handleApproveProgram = async (programId) => {
    setActionLoading(programId);
    setProgramMessage(null);
    try {
      const response = await fetch(`${API_BASE}/cloud/suggested-programs/${programId}/approve`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to approve program');
      }
      const data = await response.json();
      setProgramMessage({ type: 'success', text: `Program approved! Automation #${data.automationId} created.` });
      fetchSuggestedPrograms();
    } catch (err) {
      setProgramMessage({ type: 'error', text: err.message });
    } finally {
      setActionLoading(null);
    }
  };

  const handleRejectProgram = async (programId) => {
    setActionLoading(programId);
    setProgramMessage(null);
    try {
      const response = await fetch(`${API_BASE}/cloud/suggested-programs/${programId}/reject`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to reject program');
      }
      setProgramMessage({ type: 'success', text: 'Program rejected.' });
      fetchSuggestedPrograms();
    } catch (err) {
      setProgramMessage({ type: 'error', text: err.message });
    } finally {
      setActionLoading(null);
    }
  };

  const handleTestConnection = async () => {
    setTestLoading(true);
    setTestResult(null);

    try {
      const response = await fetch(`${API_BASE}/cloud/test`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        setTestResult({
          success: false,
          message: data.message || 'Connection test failed'
        });
      } else {
        setTestResult({
          success: true,
          message: data.message,
          details: data.details
        });
      }
    } catch (err) {
      setTestResult({
        success: false,
        message: err.message || 'Failed to test connection'
      });
    } finally {
      setTestLoading(false);
    }
  };

  // Initial fetch and refresh every 30 seconds
  React.useEffect(() => {
    fetchCloudStatus();
    fetchSuggestedPrograms();
    fetchSyncHistory();
    fetchPendingQueue();
    const interval = setInterval(() => {
      fetchCloudStatus();
      fetchPendingQueue();
    }, 30000);
    return () => clearInterval(interval);
  }, [token]);

  const handleConnect = async () => {
    if (!connectForm.url || !connectForm.apiKey) {
      setConnectError('Both URL and API key are required');
      return;
    }

    setConnectLoading(true);
    setConnectError(null);

    try {
      const response = await fetch(`${API_BASE}/cloud/connect`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(connectForm)
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to connect');
      }

      setShowConnectModal(false);
      setConnectForm({ url: '', apiKey: '' });
      fetchCloudStatus();
    } catch (err) {
      setConnectError(err.message);
    } finally {
      setConnectLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Are you sure you want to disconnect from the cloud?')) return;

    try {
      const response = await fetch(`${API_BASE}/cloud/disconnect`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) throw new Error('Failed to disconnect');
      fetchCloudStatus();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSync = async () => {
    setSyncLoading(true);
    setSyncMessage(null);

    try {
      const response = await fetch(`${API_BASE}/cloud/sync`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) throw new Error('Sync failed');
      const data = await response.json();
      setSyncMessage({ type: 'success', text: `Sync triggered at ${new Date(data.timestamp).toLocaleString()}` });
      fetchCloudStatus();
      fetchSyncHistory(); // Refresh sync history
    } catch (err) {
      setSyncMessage({ type: 'error', text: err.message });
    } finally {
      setSyncLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <svg className="animate-spin h-8 w-8 text-primary-600" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Cloud Connection</h2>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
          {error}
        </div>
      )}

      {/* Connection Status Card */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-gray-900">Connection Status</h3>
          <button
            onClick={fetchCloudStatus}
            className="text-gray-400 hover:text-gray-600"
            title="Refresh status"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        {/* Status Indicator */}
        <div className="flex items-center mb-6">
          <div className={`h-4 w-4 rounded-full mr-3 ${
            cloudStatus?.connected
              ? 'bg-green-500'
              : cloudStatus?.configured
                ? 'bg-amber-500'
                : 'bg-gray-400'
          }`}></div>
          <div>
            <p className="font-medium text-gray-900">
              {cloudStatus?.connected
                ? 'Connected'
                : cloudStatus?.configured
                  ? 'Configured (Disconnected)'
                  : 'Not Configured'}
            </p>
            <p className="text-sm text-gray-500">
              {cloudStatus?.connected
                ? 'Cloud sync is active'
                : cloudStatus?.configured
                  ? 'Unable to reach cloud server'
                  : 'No cloud connection configured'}
            </p>
          </div>
        </div>

        {/* Large Status Display */}
        <div className={`rounded-lg p-6 mb-6 border-2 ${
          cloudStatus?.connected
            ? 'bg-green-50 border-green-200'
            : cloudStatus?.configured
              ? 'bg-amber-50 border-amber-200'
              : 'bg-gray-50 border-gray-200'
        }`}>
          <div className="flex items-center">
            <div className={`h-12 w-12 rounded-full flex items-center justify-center ${
              cloudStatus?.connected
                ? 'bg-green-100'
                : cloudStatus?.configured
                  ? 'bg-amber-100'
                  : 'bg-gray-200'
            }`}>
              {cloudStatus?.connected ? (
                <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : cloudStatus?.configured ? (
                <svg className="h-6 w-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              ) : (
                <svg className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
                </svg>
              )}
            </div>
            <div className="ml-4">
              <h4 className={`text-lg font-semibold ${
                cloudStatus?.connected
                  ? 'text-green-800'
                  : cloudStatus?.configured
                    ? 'text-amber-800'
                    : 'text-gray-700'
              }`}>
                {cloudStatus?.connected
                  ? 'Cloud Connected'
                  : cloudStatus?.configured
                    ? 'Cloud Disconnected'
                    : 'Offline Mode'}
              </h4>
              <p className={`text-sm ${
                cloudStatus?.connected
                  ? 'text-green-700'
                  : cloudStatus?.configured
                    ? 'text-amber-700'
                    : 'text-gray-500'
              }`}>
                {cloudStatus?.connected
                  ? 'All systems syncing normally'
                  : cloudStatus?.configured
                    ? 'Reconnection will be attempted automatically'
                    : 'System operating independently'}
              </p>
            </div>
          </div>
        </div>

        {/* Status Details */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-gray-50 rounded-lg p-4">
            <p className="text-sm text-gray-500">Last Sync</p>
            <p className="font-medium text-gray-900">
              {cloudStatus?.lastSync
                ? new Date(cloudStatus.lastSync.timestamp).toLocaleString()
                : 'Never'}
            </p>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <p className="text-sm text-gray-500">Pending Items</p>
            <p className="font-medium text-gray-900">
              {cloudStatus?.pendingItems || 0} items
            </p>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <p className="text-sm text-gray-500">Configuration</p>
            <p className="font-medium text-gray-900">
              {cloudStatus?.configured ? 'Configured' : 'Not configured'}
            </p>
          </div>
        </div>

        {/* Sync Message */}
        {syncMessage && (
          <div className={`mb-4 p-3 rounded text-sm ${
            syncMessage.type === 'success'
              ? 'bg-green-50 text-green-800 border border-green-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}>
            {syncMessage.text}
          </div>
        )}

        {/* Test Connection Result */}
        {testResult && (
          <div className={`mb-4 p-3 rounded text-sm ${
            testResult.success
              ? 'bg-green-50 text-green-800 border border-green-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}>
            <div className="flex items-center">
              {testResult.success ? (
                <svg className="h-5 w-5 mr-2 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="h-5 w-5 mr-2 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              )}
              <span className="font-medium">{testResult.message}</span>
            </div>
            {testResult.success && testResult.details && (
              <div className="mt-2 text-xs grid grid-cols-2 gap-2">
                <span>Latency: {testResult.details.latency}ms</span>
                <span>Server: v{testResult.details.serverVersion}</span>
              </div>
            )}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3">
          {cloudStatus?.configured ? (
            <>
              <button
                onClick={handleTestConnection}
                disabled={testLoading}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center"
              >
                {testLoading ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Testing...
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Test Connection
                  </>
                )}
              </button>
              <button
                onClick={handleSync}
                disabled={syncLoading}
                className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 flex items-center"
              >
                {syncLoading ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Syncing...
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Sync Now
                  </>
                )}
              </button>
              <button
                onClick={handleDisconnect}
                className="px-4 py-2 text-red-600 bg-red-50 rounded-lg hover:bg-red-100 flex items-center"
              >
                <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                Disconnect
              </button>
            </>
          ) : (
            <button
              onClick={() => setShowConnectModal(true)}
              className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 flex items-center"
            >
              <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
              </svg>
              Configure Cloud Connection
            </button>
          )}
        </div>
      </div>

      {/* Pending Sync Queue Section */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-gray-900 flex items-center">
            <svg className="h-5 w-5 mr-2 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Pending Sync Queue
            {pendingQueue.length > 0 && (
              <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 rounded-full">
                {pendingQueue.length}
              </span>
            )}
          </h3>
          <button
            onClick={fetchPendingQueue}
            disabled={queueLoading}
            className="text-gray-400 hover:text-gray-600"
            title="Refresh pending queue"
          >
            <svg className={`h-5 w-5 ${queueLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-500 mb-4">
          Items waiting to be synchronized with the Cloud. Changes made while offline are queued here.
        </p>

        {queueLoading ? (
          <div className="flex items-center justify-center py-8">
            <svg className="animate-spin h-6 w-6 text-primary-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
        ) : pendingQueue.length === 0 ? (
          <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
            <svg className="mx-auto h-10 w-10 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <p className="mt-2 text-gray-500">No pending items</p>
            <p className="text-sm text-gray-400">All changes have been synchronized</p>
          </div>
        ) : (
          <div className="overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Entity</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {pendingQueue.map((item) => {
                  const payload = item.payload ? JSON.parse(item.payload) : {};
                  return (
                    <tr key={item.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center">
                          <span className="px-2 py-1 text-xs font-medium bg-blue-100 text-blue-700 rounded mr-2">
                            {item.entity_type}
                          </span>
                          <span className="text-sm text-gray-900">
                            {payload.name || `#${item.entity_id}`}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                          item.action === 'create' ? 'bg-green-100 text-green-700' :
                          item.action === 'update' ? 'bg-blue-100 text-blue-700' :
                          'bg-red-100 text-red-700'
                        }`}>
                          {item.action}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                          item.status === 'pending' ? 'bg-amber-100 text-amber-700' :
                          item.status === 'syncing' ? 'bg-blue-100 text-blue-700' :
                          item.status === 'failed' ? 'bg-red-100 text-red-700' :
                          'bg-green-100 text-green-700'
                        }`}>
                          {item.status}
                        </span>
                        {item.retry_count > 0 && (
                          <span className="ml-1 text-xs text-gray-500">
                            (retry #{item.retry_count})
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                        {new Date(item.created_at).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Sync History Section */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-gray-900 flex items-center">
            <svg className="h-5 w-5 mr-2 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Sync History
          </h3>
          <button
            onClick={fetchSyncHistory}
            disabled={historyLoading}
            className="text-gray-400 hover:text-gray-600"
            title="Refresh sync history"
          >
            <svg className={`h-5 w-5 ${historyLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-500 mb-4">
          View the history of Cloud synchronization operations.
        </p>

        {historyLoading ? (
          <div className="flex items-center justify-center py-8">
            <svg className="animate-spin h-6 w-6 text-primary-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
        ) : syncHistory.length === 0 ? (
          <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
            <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="mt-2 text-gray-500">No sync history yet</p>
            <p className="text-sm text-gray-400">Sync operations will be recorded here</p>
          </div>
        ) : (
          <div className="overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Items</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Triggered By</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {syncHistory.map((sync) => (
                  <tr key={sync.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900">
                      {new Date(sync.started_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                        sync.sync_type === 'manual' ? 'bg-blue-100 text-blue-700' :
                        sync.sync_type === 'automatic' ? 'bg-purple-100 text-purple-700' :
                        'bg-gray-100 text-gray-700'
                      }`}>
                        {sync.sync_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`px-2 py-1 text-xs font-medium rounded-full flex items-center w-fit ${
                        sync.status === 'success' ? 'bg-green-100 text-green-700' :
                        sync.status === 'partial' ? 'bg-amber-100 text-amber-700' :
                        'bg-red-100 text-red-700'
                      }`}>
                        {sync.status === 'success' ? (
                          <svg className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        ) : sync.status === 'partial' ? (
                          <svg className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                          </svg>
                        ) : (
                          <svg className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        )}
                        {sync.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                      {sync.items_synced} synced
                      {sync.items_failed > 0 && (
                        <span className="text-red-500 ml-1">({sync.items_failed} failed)</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                      {sync.triggered_by_name || 'System'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Suggested Programs Section */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-gray-900 flex items-center">
            <svg className="h-5 w-5 mr-2 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            Suggested Programs from Cloud
          </h3>
          <button
            onClick={fetchSuggestedPrograms}
            disabled={suggestedLoading}
            className="text-gray-400 hover:text-gray-600"
            title="Refresh suggested programs"
          >
            <svg className={`h-5 w-5 ${suggestedLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-500 mb-4">
          When connected to the Cloud, automation programs may be suggested for your review. You can approve them to add to your local automations or reject them.
        </p>

        {programMessage && (
          <div className={`mb-4 p-3 rounded text-sm ${
            programMessage.type === 'success'
              ? 'bg-green-50 text-green-800 border border-green-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}>
            {programMessage.text}
          </div>
        )}

        {suggestedLoading ? (
          <div className="flex items-center justify-center py-8">
            <svg className="animate-spin h-6 w-6 text-primary-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
        ) : suggestedPrograms.length === 0 ? (
          <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
            <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            <p className="mt-2 text-gray-500">No pending suggested programs</p>
            <p className="text-sm text-gray-400">Suggested automations from the Cloud will appear here</p>
          </div>
        ) : (
          <div className="space-y-4">
            {suggestedPrograms.map((program) => (
              <div key={program.id} className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="font-medium text-gray-900">{program.name}</h4>
                      <span className="px-2 py-0.5 text-xs font-medium bg-purple-100 text-purple-700 rounded-full">
                        Cloud Suggested
                      </span>
                    </div>
                    <p className="text-sm text-gray-500 mb-2">{program.description || 'No description'}</p>

                    {/* Trigger Info */}
                    {program.trigger_config && (
                      <div className="flex items-center gap-2 text-xs text-gray-600 mb-1">
                        <span className="font-medium">Trigger:</span>
                        <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded">
                          {program.trigger_config.type === 'schedule' ? `Schedule (${program.trigger_config.schedule || 'custom'})` : program.trigger_config.type}
                        </span>
                      </div>
                    )}

                    {/* Actions Info */}
                    {program.actions && program.actions.length > 0 && (
                      <div className="flex items-center gap-2 text-xs text-gray-600">
                        <span className="font-medium">Actions:</span>
                        <span>{program.actions.length} action{program.actions.length !== 1 ? 's' : ''}</span>
                      </div>
                    )}

                    <p className="text-xs text-gray-400 mt-2">
                      Cloud ID: {program.cloud_id} | Received: {new Date(program.created_at).toLocaleString()}
                    </p>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex gap-2 ml-4">
                    <button
                      onClick={() => handleApproveProgram(program.id)}
                      disabled={actionLoading === program.id}
                      className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center"
                    >
                      {actionLoading === program.id ? (
                        <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                      ) : (
                        <>
                          <svg className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          Approve
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => handleRejectProgram(program.id)}
                      disabled={actionLoading === program.id}
                      className="px-3 py-1.5 text-sm bg-red-100 text-red-700 rounded-lg hover:bg-red-200 disabled:opacity-50 flex items-center"
                    >
                      <svg className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                      Reject
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Connect Modal */}
      {showConnectModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75" onClick={() => setShowConnectModal(false)}></div>
            <div className="inline-block w-full max-w-md p-4 sm:p-6 my-8 mx-4 overflow-hidden text-left align-middle transition-all transform bg-white shadow-xl rounded-lg relative">
              <button onClick={() => setShowConnectModal(false)} className="absolute top-4 right-4 text-gray-400 hover:text-gray-600">
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              <h3 className="text-lg font-semibold text-gray-900 mb-4">Configure Cloud Connection</h3>

              {connectError && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
                  {connectError}
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Cloud Server URL</label>
                  <input
                    type="url"
                    value={connectForm.url}
                    onChange={(e) => setConnectForm({ ...connectForm, url: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                    placeholder="https://cloud.sensehub.io"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
                  <input
                    type="password"
                    value={connectForm.apiKey}
                    onChange={(e) => setConnectForm({ ...connectForm, apiKey: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Enter your API key"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={() => setShowConnectModal(false)}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConnect}
                  disabled={connectLoading}
                  className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 flex items-center"
                >
                  {connectLoading ? (
                    <>
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Connecting...
                    </>
                  ) : (
                    'Connect'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BackupSettings() {
  const { token, logout } = useAuth();
  const navigate = useNavigate();
  const [showFactoryResetModal, setShowFactoryResetModal] = useState(false);
  const [resetPassword, setResetPassword] = useState('');
  const [resetError, setResetError] = useState(null);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupMessage, setBackupMessage] = useState(null);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [restoreFile, setRestoreFile] = useState(null);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreError, setRestoreError] = useState(null);
  const [restoreSuccess, setRestoreSuccess] = useState(false);

  const handleCreateBackup = async () => {
    setBackupLoading(true);
    setBackupMessage(null);
    try {
      const response = await fetch(`${API_BASE}/settings/backup`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to create backup');
      }

      const data = await response.json();
      setBackupMessage({ type: 'success', text: `Backup created successfully (ID: ${data.id})` });
    } catch (err) {
      setBackupMessage({ type: 'error', text: err.message });
    } finally {
      setBackupLoading(false);
    }
  };

  const handleFactoryReset = async () => {
    if (!resetPassword) {
      setResetError('Password is required');
      return;
    }

    setResetLoading(true);
    setResetError(null);

    try {
      const response = await fetch(`${API_BASE}/settings/factory-reset`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          password: resetPassword,
          confirm: 'FACTORY_RESET'
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Factory reset failed');
      }

      setResetSuccess(true);
      // Clear local auth state and redirect to setup wizard after a brief delay
      setTimeout(() => {
        logout();
        navigate('/setup');
      }, 2000);
    } catch (err) {
      setResetError(err.message);
    } finally {
      setResetLoading(false);
    }
  };

  const closeFactoryResetModal = () => {
    setShowFactoryResetModal(false);
    setResetPassword('');
    setResetError(null);
    setResetSuccess(false);
  };

  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    if (file) {
      setRestoreFile(file);
      setRestoreError(null);
    }
  };

  const handleRestore = async () => {
    if (!restoreFile) {
      setRestoreError('Please select a backup file');
      return;
    }

    setRestoreLoading(true);
    setRestoreError(null);

    try {
      // In a real implementation, we would upload the file
      // For now, simulate reading the file and calling the restore API
      const response = await fetch(`${API_BASE}/settings/restore`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          backup_id: restoreFile.name,
          confirm: true
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Restore failed');
      }

      setRestoreSuccess(true);
      // In production, the system would restart here
    } catch (err) {
      setRestoreError(err.message);
    } finally {
      setRestoreLoading(false);
    }
  };

  const closeRestoreModal = () => {
    setShowRestoreModal(false);
    setRestoreFile(null);
    setRestoreError(null);
    setRestoreSuccess(false);
    // Reset file input
    const fileInput = document.getElementById('backup-file-input');
    if (fileInput) fileInput.value = '';
  };

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Backup & Restore</h2>

      {/* Backup Section */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h3 className="text-md font-medium text-gray-900 mb-4">Create Backup</h3>
        <p className="text-sm text-gray-500 mb-4">
          Create a backup of your system configuration, including equipment, zones, automations, and settings.
        </p>

        {backupMessage && (
          <div className={`mb-4 p-3 rounded text-sm ${
            backupMessage.type === 'success'
              ? 'bg-green-50 text-green-800 border border-green-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}>
            {backupMessage.text}
          </div>
        )}

        <button
          onClick={handleCreateBackup}
          disabled={backupLoading}
          className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
        >
          {backupLoading ? (
            <>
              <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Creating Backup...
            </>
          ) : (
            <>
              <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              Create Backup
            </>
          )}
        </button>
      </div>

      {/* Restore Section */}
      <div className="bg-white rounded-lg shadow p-6 mb-6 border-2 border-amber-200">
        <h3 className="text-md font-medium text-amber-700 mb-4 flex items-center">
          <svg className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Restore from Backup
        </h3>
        <p className="text-sm text-gray-500 mb-4">
          Restore your system from a previously created backup file. <strong className="text-amber-600">This will replace all current data with the backup data.</strong>
        </p>
        <button
          onClick={() => setShowRestoreModal(true)}
          className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 flex items-center"
        >
          <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Restore
        </button>
      </div>

      {/* Factory Reset Section */}
      <div className="bg-white rounded-lg shadow p-6 border-2 border-red-200">
        <h3 className="text-md font-medium text-red-600 mb-4 flex items-center">
          <svg className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          Factory Reset
        </h3>
        <p className="text-sm text-gray-500 mb-4">
          Reset the system to factory defaults. <strong className="text-red-600">This will erase all data including equipment, zones, automations, users, and settings.</strong> This action cannot be undone.
        </p>
        <button
          onClick={() => setShowFactoryResetModal(true)}
          className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 flex items-center"
        >
          <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          Factory Reset
        </button>
      </div>

      {/* Factory Reset Confirmation Modal */}
      {showFactoryResetModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
            {/* Backdrop */}
            <div
              className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
              onClick={closeFactoryResetModal}
            ></div>

            {/* Modal */}
            <div className="inline-block w-full max-w-md p-4 sm:p-6 my-8 mx-4 overflow-hidden text-left align-middle transition-all transform bg-white shadow-xl rounded-lg relative">
              {/* Close button */}
              <button
                onClick={closeFactoryResetModal}
                className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
              >
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              {resetSuccess ? (
                <div className="text-center py-6">
                  <svg className="mx-auto h-12 w-12 text-green-500 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">Factory Reset Initiated</h3>
                  <p className="text-sm text-gray-500">The system will restart shortly...</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center mb-4">
                    <div className="flex-shrink-0 h-10 w-10 bg-red-100 rounded-full flex items-center justify-center mr-3">
                      <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                    </div>
                    <h3 className="text-lg font-semibold text-gray-900">Confirm Factory Reset</h3>
                  </div>

                  <p className="text-sm text-gray-500 mb-4">
                    This will permanently delete all data. Enter your password to confirm.
                  </p>

                  {resetError && (
                    <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                      <div className="flex items-center">
                        <svg className="h-5 w-5 text-red-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span className="text-red-800 text-sm">{resetError}</span>
                      </div>
                    </div>
                  )}

                  <div className="mb-4">
                    <label htmlFor="reset-password" className="block text-sm font-medium text-gray-700 mb-1">
                      Enter your password to confirm
                    </label>
                    <input
                      type="password"
                      id="reset-password"
                      value={resetPassword}
                      onChange={(e) => setResetPassword(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-red-500 focus:border-red-500"
                      placeholder="Enter your password"
                      autoFocus
                    />
                  </div>

                  <div className="flex justify-end gap-3">
                    <button
                      onClick={closeFactoryResetModal}
                      className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
                      disabled={resetLoading}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleFactoryReset}
                      disabled={resetLoading || !resetPassword}
                      className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                    >
                      {resetLoading ? (
                        <>
                          <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          Processing...
                        </>
                      ) : (
                        'Confirm Factory Reset'
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Restore Confirmation Modal */}
      {showRestoreModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
            {/* Backdrop */}
            <div
              className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
              onClick={closeRestoreModal}
            ></div>

            {/* Modal */}
            <div className="inline-block w-full max-w-md p-4 sm:p-6 my-8 mx-4 overflow-hidden text-left align-middle transition-all transform bg-white shadow-xl rounded-lg relative">
              {/* Close button */}
              <button
                onClick={closeRestoreModal}
                className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
              >
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              {restoreSuccess ? (
                <div className="text-center py-6">
                  <svg className="mx-auto h-12 w-12 text-green-500 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">Restore Initiated</h3>
                  <p className="text-sm text-gray-500">The system is being restored from backup...</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center mb-4">
                    <div className="flex-shrink-0 h-10 w-10 bg-amber-100 rounded-full flex items-center justify-center mr-3">
                      <svg className="h-6 w-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </div>
                    <h3 className="text-lg font-semibold text-gray-900">Restore from Backup</h3>
                  </div>

                  <p className="text-sm text-gray-500 mb-4">
                    Select a backup file to restore your system. This will replace all current data.
                  </p>

                  {restoreError && (
                    <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                      <div className="flex items-center">
                        <svg className="h-5 w-5 text-red-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span className="text-red-800 text-sm">{restoreError}</span>
                      </div>
                    </div>
                  )}

                  <div className="mb-4">
                    <label htmlFor="backup-file-input" className="block text-sm font-medium text-gray-700 mb-1">
                      Select Backup File
                    </label>
                    <input
                      type="file"
                      id="backup-file-input"
                      accept=".json,.zip,.backup"
                      onChange={handleFileSelect}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-amber-500 focus:border-amber-500 text-sm"
                    />
                    {restoreFile && (
                      <p className="mt-2 text-sm text-green-600 flex items-center">
                        <svg className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        Selected: {restoreFile.name}
                      </p>
                    )}
                  </div>

                  <div className="flex justify-end gap-3">
                    <button
                      onClick={closeRestoreModal}
                      className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
                      disabled={restoreLoading}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleRestore}
                      disabled={restoreLoading || !restoreFile}
                      className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                    >
                      {restoreLoading ? (
                        <>
                          <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          Restoring...
                        </>
                      ) : (
                        'Confirm Restore'
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Settings() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  // Filter tabs based on user role
  const visibleTabs = settingsTabs.filter(tab => !tab.adminOnly || isAdmin);

  // Non-admin users can only access Profile settings
  if (!isAdmin) {
    return (
      <div className="max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Settings</h1>

        <div className="flex flex-col md:flex-row gap-6">
          {/* Sidebar navigation */}
          <nav className="w-full md:w-48 flex-shrink-0">
            <div className="bg-white rounded-lg shadow overflow-hidden">
              {visibleTabs.map((tab) => (
                <NavLink
                  key={tab.path}
                  to={`/settings/${tab.path}`}
                  className={({ isActive }) =>
                    `flex items-center px-4 py-3 text-sm font-medium border-l-4 transition-colors ${
                      isActive
                        ? 'bg-primary-50 border-primary-600 text-primary-700'
                        : 'border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                    }`
                  }
                >
                  <span className="mr-3 text-gray-400">{tab.icon}</span>
                  {tab.name}
                </NavLink>
              ))}
            </div>
          </nav>

          {/* Main content area */}
          <div className="flex-1 min-w-0">
            <Routes>
              <Route index element={<Navigate to="profile" replace />} />
              <Route path="profile" element={<Profile />} />
              <Route path="*" element={<Navigate to="profile" replace />} />
            </Routes>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Settings</h1>

      <div className="flex flex-col md:flex-row gap-6">
        {/* Sidebar navigation */}
        <nav className="w-full md:w-48 flex-shrink-0">
          <div className="bg-white rounded-lg shadow overflow-hidden">
            {visibleTabs.map((tab) => (
              <NavLink
                key={tab.path}
                to={`/settings/${tab.path}`}
                className={({ isActive }) =>
                  `flex items-center px-4 py-3 text-sm font-medium border-l-4 transition-colors ${
                    isActive
                      ? 'bg-primary-50 border-primary-600 text-primary-700'
                      : 'border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                  }`
                }
              >
                <span className="mr-3 text-gray-400">{tab.icon}</span>
                {tab.name}
              </NavLink>
            ))}
          </div>
        </nav>

        {/* Main content area */}
        <div className="flex-1 min-w-0">
          <Routes>
            <Route index element={<Navigate to="profile" replace />} />
            <Route path="profile" element={<Profile />} />
            <Route path="users" element={<Users />} />
            <Route path="system" element={<SystemSettings />} />
            <Route path="cloud" element={<CloudSettings />} />
            <Route path="backup" element={<BackupSettings />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
