import React, { useState } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import { useTranslation, Trans } from 'react-i18next';
import { useFormat } from '../i18n/useFormat';
import Users from './settings/Users';
import Profile from './settings/Profile';
import { LANGUAGES, intlLocale } from '../i18n/languages';

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
  { name: 'Notifications', path: 'notifications', adminOnly: true, icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
    </svg>
  )},
  { name: 'Backup', path: 'backup', adminOnly: true, icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
    </svg>
  )},
  { name: 'Watchdog', path: 'watchdog', adminOnly: true, icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  )},
  { name: 'Network', path: 'network', adminOnly: true, icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  )},
  { name: 'Data', path: 'data', adminOnly: true, icon: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  )},
];

function SystemSettings() {
  const { token } = useAuth();
  const { formatDateTime } = useSettings();
  const { t } = useTranslation('settings');
  const fmt = useFormat();
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
    { group: 'americas', options: [
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
    { group: 'europe', options: [
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
    { group: 'asia', options: [
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
    { group: 'pacific', options: [
      { value: 'Australia/Sydney', label: 'Sydney (AEST/AEDT)' },
      { value: 'Australia/Melbourne', label: 'Melbourne (AEST/AEDT)' },
      { value: 'Australia/Brisbane', label: 'Brisbane (AEST)' },
      { value: 'Australia/Perth', label: 'Perth (AWST)' },
      { value: 'Australia/Adelaide', label: 'Adelaide (ACST/ACDT)' },
      { value: 'Pacific/Auckland', label: 'Auckland (NZST/NZDT)' },
      { value: 'Pacific/Fiji', label: 'Fiji' },
    ]},
    { group: 'africa', options: [
      { value: 'Africa/Cairo', label: 'Cairo (EET)' },
      { value: 'Africa/Johannesburg', label: 'Johannesburg (SAST)' },
      { value: 'Africa/Lagos', label: 'Lagos (WAT)' },
      { value: 'Africa/Nairobi', label: 'Nairobi (EAT)' },
    ]},
    { group: 'other', options: [
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

  // English keeps the hand-written labels; other languages get the zone's
  // localized generic name from Intl plus the IANA id (an identifier).
  const timezoneLabel = (tz) => {
    if (fmt.lng === 'en' || fmt.lng === 'pseudo') return tz.label;
    try {
      const part = new Intl.DateTimeFormat(intlLocale(fmt.lng), { timeZone: tz.value, timeZoneName: 'longGeneric' })
        .formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
      return part ? `${part.value} (${tz.value})` : tz.value;
    } catch {
      return tz.label;
    }
  };

  // Locale names: English keeps its labels; other languages use Intl.DisplayNames.
  const localeLabel = (loc) => {
    if (fmt.lng === 'en' || fmt.lng === 'pseudo') return loc.label;
    try {
      return new Intl.DisplayNames([intlLocale(fmt.lng)], { type: 'language' }).of(loc.value) || loc.label;
    } catch {
      return loc.label;
    }
  };

  const fetchSettings = async () => {
    try {
      const response = await fetch(`${API_BASE}/settings`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
      setError(t('system.errors.loadFailed', { error: err.message }));
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
    if (bytes === 0) return fmt.withUnit(0, 'B', { decimals: 0 });
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return fmt.withUnit(bytes / Math.pow(k, i), sizes[i], { maxDecimals: dm });
  };

  // Helper function to format uptime in human-readable format
  const formatUptime = (seconds) => {
    if (!seconds) return t('na');
    const days = Math.floor(seconds / 86400);
    const rest = fmt.duration(seconds % 86400);
    return days > 0 ? t('system.firmware.uptimeDays', { count: days, rest }) : rest;
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
        throw new Error(data.message || `HTTP ${response.status}`);
      }

      setSuccessMessage(t('system.saved'));
      fetchSettings(); // Refresh settings
    } catch (err) {
      setError(t('system.errors.saveFailed', { error: err.message }));
    } finally {
      setSaving(false);
    }
  };

  // Get current time in selected timezone
  const getCurrentTime = () => {
    try {
      return new Intl.DateTimeFormat(intlLocale(fmt.lng), {
        timeZone: timezone,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
        hour12: fmt.lng === 'en' ? undefined : false
      }).format(new Date());
    } catch {
      return t('system.timezone.invalid');
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
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('system.title')}</h2>

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-800 dark:text-red-200 text-sm">
          {error}
        </div>
      )}

      {successMessage && (
        <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-green-800 dark:text-green-200 text-sm flex items-center">
          <svg className="h-5 w-5 me-2 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {successMessage}
        </div>
      )}

      {/* Timezone Settings */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
        <h3 className="text-md font-medium text-gray-900 dark:text-white mb-4 flex items-center">
          <svg className="h-5 w-5 me-2 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {t('system.timezone.title')}
        </h3>

        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('system.timezone.help')}
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor="timezone" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('system.timezone.label')}
            </label>
            <select
              id="timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:text-white"
            >
              {timezones.map((group) => (
                <optgroup key={group.group} label={t(`system.timezone.groups.${group.group}`)}>
                  {group.options.map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {timezoneLabel(tz)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {/* Time Preview */}
          <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">{t('system.timezone.preview')}</p>
            <p className="text-lg font-medium text-gray-900 dark:text-white">{getCurrentTime()}</p>
          </div>
        </div>
      </div>

      {/* Locale Settings */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
        <h3 className="text-md font-medium text-gray-900 dark:text-white mb-4 flex items-center">
          <svg className="h-5 w-5 me-2 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
          </svg>
          {t('system.locale.title')}
        </h3>

        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('system.locale.help')}
        </p>

        <div>
          <label htmlFor="locale" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('system.locale.label')}
          </label>
          <select
            id="locale"
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:text-white"
          >
            {locales.map((loc) => (
              <option key={loc.value} value={loc.value}>
                {localeLabel(loc)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Data Retention Settings */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
        <h3 className="text-md font-medium text-gray-900 dark:text-white mb-4 flex items-center">
          <svg className="h-5 w-5 me-2 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
          </svg>
          {t('system.retention.title')}
        </h3>

        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('system.retention.help')}
        </p>

        <div>
          <label htmlFor="dataRetention" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('system.retention.label')}
          </label>
          <select
            id="dataRetention"
            value={dataRetention}
            onChange={(e) => setDataRetention(parseInt(e.target.value))}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:text-white"
          >
            <option value={7}>{t('system.retention.days', { count: 7 })}</option>
            <option value={14}>{t('system.retention.days', { count: 14 })}</option>
            <option value={30}>{t('system.retention.optionDefault', { days: t('system.retention.days', { count: 30 }) })}</option>
            <option value={60}>{t('system.retention.days', { count: 60 })}</option>
            <option value={90}>{t('system.retention.days', { count: 90 })}</option>
            <option value={180}>{t('system.retention.days', { count: 180 })}</option>
            <option value={365}>{t('system.retention.optionYear', { days: t('system.retention.days', { count: 365 }) })}</option>
          </select>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('system.retention.purgeHelp')}
          </p>
        </div>
      </div>

      {/* Network Configuration Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-gray-900 dark:text-white flex items-center">
            <svg className="h-5 w-5 me-2 text-teal-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
            {t('system.network.title')}
          </h3>
          <button
            onClick={fetchNetwork}
            disabled={networkLoading}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            title={t('refreshTitle.network')}
            aria-label={t('refreshTitle.network')}
          >
            <svg className={`h-5 w-5 ${networkLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('system.network.help')}
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
                  <svg className="h-5 w-5 me-2 text-teal-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span className="text-sm font-medium text-teal-700">{t('system.network.ipAddress')}</span>
                </div>
                <p className="text-xl font-bold text-teal-900 font-mono"><bdi dir="ltr">{networkInfo.ipAddress}</bdi></p>
              </div>

              <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
                <div className="flex items-center mb-2">
                  <svg className="h-5 w-5 me-2 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 14v3m4-3v3m4-3v3M3 21h18M3 10h18M3 7l9-4 9 4M4 10h16v11H4V10z" />
                  </svg>
                  <span className="text-sm font-medium text-blue-700">{t('system.network.gateway')}</span>
                </div>
                <p className="text-xl font-bold text-blue-900 font-mono"><bdi dir="ltr">{networkInfo.gateway}</bdi></p>
              </div>

              <div className="bg-purple-50 rounded-lg p-4 border border-purple-200">
                <div className="flex items-center mb-2">
                  <svg className="h-5 w-5 me-2 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
                  </svg>
                  <span className="text-sm font-medium text-purple-700">{t('system.network.dns')}</span>
                </div>
                <div className="space-y-1">
                  {networkInfo.dns && networkInfo.dns.map((dns, index) => (
                    <p key={index} className="text-lg font-bold text-purple-900 font-mono"><bdi dir="ltr">{dns}</bdi></p>
                  ))}
                </div>
              </div>
            </div>

            {/* Network Interfaces */}
            {networkInfo.interfaces && networkInfo.interfaces.length > 0 && (
              <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">{t('system.network.interfaces')}</h4>
                <div className="space-y-3">
                  {networkInfo.interfaces.map((iface, index) => (
                    <div key={index} className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-semibold text-gray-900 dark:text-white">{iface.name}</span>
                        <span className="px-2 py-1 bg-green-100 text-green-800 text-xs font-medium rounded-full">{t('system.network.active')}</span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
                        <div>
                          <span className="text-gray-500 dark:text-gray-400">{t('system.network.field', { label: t('system.network.ipAddress') })} </span>
                          <span className="font-mono text-gray-900 dark:text-white" dir="ltr">{iface.address}</span>
                        </div>
                        <div>
                          <span className="text-gray-500 dark:text-gray-400">{t('system.network.field', { label: t('system.network.netmask') })} </span>
                          <span className="font-mono text-gray-900 dark:text-white" dir="ltr">{iface.netmask}</span>
                        </div>
                        <div>
                          <span className="text-gray-500 dark:text-gray-400">{t('system.network.field', { label: t('system.network.mac') })} </span>
                          <span className="font-mono text-gray-900 dark:text-white" dir="ltr">{iface.mac}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-8 bg-gray-50 dark:bg-gray-900 rounded-lg border-2 border-dashed border-gray-200 dark:border-gray-700">
            <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
            <p className="mt-2 text-gray-500 dark:text-gray-400">{t('system.network.unavailable')}</p>
          </div>
        )}
      </div>

      {/* Firmware/Version Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-gray-900 dark:text-white flex items-center">
            <svg className="h-5 w-5 me-2 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
            {t('system.firmware.title')}
          </h3>
          <button
            onClick={fetchSystemInfo}
            disabled={systemInfoLoading}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            title={t('refreshTitle.system')}
            aria-label={t('refreshTitle.system')}
          >
            <svg className={`h-5 w-5 ${systemInfoLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('system.firmware.help')}
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
                  <span className="text-sm font-medium text-indigo-700">{t('system.firmware.version')}</span>
                  <span className="px-2 py-1 bg-indigo-100 text-indigo-800 text-xs font-medium rounded-full">
                    {t(`system.firmware.release.${systemInfo.releaseType || 'stable'}`, { defaultValue: systemInfo.releaseType || 'stable' })}
                  </span>
                </div>
                <p className="text-2xl font-bold text-indigo-900"><bdi dir="ltr">v{systemInfo.version}</bdi></p>
                {systemInfo.codename && (
                  <p className="text-sm text-indigo-600 mt-1">"{systemInfo.codename}"</p>
                )}
              </div>

              <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('system.firmware.buildDate')}</span>
                <p className="text-lg font-semibold text-gray-900 dark:text-white mt-2">
                  {systemInfo.buildDate ? formatDateTime(systemInfo.buildDate, {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    hour: undefined,
                    minute: undefined,
                    second: undefined
                  }) : t('na')}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {systemInfo.buildDate ? formatDateTime(systemInfo.buildDate, {
                    year: undefined,
                    month: undefined,
                    day: undefined,
                    hour: '2-digit',
                    minute: '2-digit',
                    second: undefined,
                    timeZoneName: 'short'
                  }) : ''}
                </p>
              </div>
            </div>

            {/* System Details */}
            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">{t('system.firmware.details')}</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                  <p className="text-xs text-gray-500 dark:text-gray-400">{t('system.firmware.platform')}</p>
                  <p className="text-sm font-semibold text-gray-900 dark:text-white capitalize">{systemInfo.platform}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                  <p className="text-xs text-gray-500 dark:text-gray-400">{t('system.firmware.architecture')}</p>
                  <p className="text-sm font-semibold text-gray-900 dark:text-white">{systemInfo.arch}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                  <p className="text-xs text-gray-500 dark:text-gray-400">Node.js</p>
                  <p className="text-sm font-semibold text-gray-900 dark:text-white">{systemInfo.node_version}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                  <p className="text-xs text-gray-500 dark:text-gray-400">{t('system.firmware.cpus')}</p>
                  <p className="text-sm font-semibold text-gray-900 dark:text-white">{t('system.firmware.cores', { count: systemInfo.cpus })}</p>
                </div>
              </div>
            </div>

            {/* Runtime Info */}
            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">{t('system.firmware.runtime')}</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                  <p className="text-xs text-gray-500 dark:text-gray-400">{t('system.firmware.hostname')}</p>
                  <p className="text-sm font-semibold text-gray-900 dark:text-white"><bdi dir="ltr">{systemInfo.hostname}</bdi></p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                  <p className="text-xs text-gray-500 dark:text-gray-400">{t('system.firmware.uptime')}</p>
                  <p className="text-sm font-semibold text-gray-900 dark:text-white">{formatUptime(systemInfo.uptime)}</p>
                </div>
                <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                  <p className="text-xs text-gray-500 dark:text-gray-400">{t('system.firmware.startedAt')}</p>
                  <p className="text-sm font-semibold text-gray-900 dark:text-white">
                    {systemInfo.startedAt ? formatDateTime(systemInfo.startedAt) : t('na')}
                  </p>
                </div>
              </div>
            </div>

            {/* Memory Info */}
            {systemInfo.memory && (
              <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">{t('system.firmware.memory')}</h4>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-gray-600 dark:text-gray-400">
                    {formatBytes(systemInfo.memory.used)} / {formatBytes(systemInfo.memory.total)}
                  </span>
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {t('system.firmware.percentUsed', { percent: fmt.percent((systemInfo.memory.used / systemInfo.memory.total) * 100, { decimals: 1 }) })}
                  </span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3">
                  <div
                    className="h-3 rounded-full bg-indigo-500 transition-all"
                    style={{ width: `${(systemInfo.memory.used / systemInfo.memory.total) * 100}%` }}
                  ></div>
                </div>
              </div>
            )}

            {/* Database Status */}
            {systemInfo.database && (
              <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">{t('system.firmware.database')}</h4>
                <div className="flex items-center gap-4">
                  <div className="flex items-center">
                    <div className={`w-3 h-3 rounded-full me-2 ${systemInfo.database.connected ? 'bg-green-500' : 'bg-red-500'}`}></div>
                    <span className="text-sm text-gray-900 dark:text-white">
                      {systemInfo.database.connected ? t('system.firmware.connected') : t('system.firmware.disconnected')}
                    </span>
                  </div>
                  <span className="text-sm text-gray-500 dark:text-gray-400" dir="ltr">{systemInfo.database.path}</span>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-8 bg-gray-50 dark:bg-gray-900 rounded-lg border-2 border-dashed border-gray-200 dark:border-gray-700">
            <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
            <p className="mt-2 text-gray-500 dark:text-gray-400">{t('system.firmware.unavailable')}</p>
          </div>
        )}
      </div>

      {/* Storage Usage Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-gray-900 dark:text-white flex items-center">
            <svg className="h-5 w-5 me-2 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
            </svg>
            {t('system.storage.title')}
          </h3>
          <button
            onClick={fetchStorage}
            disabled={storageLoading}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            title={t('refreshTitle.storage')}
            aria-label={t('refreshTitle.storage')}
          >
            <svg className={`h-5 w-5 ${storageLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('system.storage.help')}
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
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('system.storage.disk')}</span>
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  {formatBytes(storageInfo.disk.used)} / {formatBytes(storageInfo.disk.total)}
                </span>
              </div>
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-4 overflow-hidden">
                <div
                  className={`h-4 rounded-full transition-all ${
                    storageInfo.disk.percentUsed > 90 ? 'bg-red-500' :
                    storageInfo.disk.percentUsed > 70 ? 'bg-amber-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${storageInfo.disk.percentUsed}%` }}
                ></div>
              </div>
              <div className="flex justify-between mt-1 text-xs text-gray-500 dark:text-gray-400">
                <span>{t('system.firmware.percentUsed', { percent: fmt.percent(storageInfo.disk.percentUsed, { maxDecimals: 1 }) })}</span>
                <span>{t('system.storage.available', { size: formatBytes(storageInfo.disk.available) })}</span>
              </div>
            </div>

            {/* Storage Breakdown */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
                <div className="flex items-center mb-2">
                  <svg className="h-5 w-5 me-2 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                  </svg>
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('system.storage.database')}</span>
                </div>
                <p className="text-2xl font-bold text-gray-900 dark:text-white">{formatBytes(storageInfo.database.size)}</p>
              </div>

              <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
                <div className="flex items-center mb-2">
                  <svg className="h-5 w-5 me-2 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('system.storage.dataDirectory')}</span>
                </div>
                <p className="text-2xl font-bold text-gray-900 dark:text-white">{formatBytes(storageInfo.dataDirectory.size)}</p>
              </div>

              <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
                <div className="flex items-center mb-2">
                  <svg className="h-5 w-5 me-2 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('system.storage.logs')}</span>
                </div>
                <p className="text-2xl font-bold text-gray-900 dark:text-white">{formatBytes(storageInfo.logsDirectory.size)}</p>
              </div>
            </div>

            {/* Database Table Statistics */}
            <div>
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">{t('system.storage.records')}</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {storageInfo.tableStats && Object.entries(storageInfo.tableStats).map(([table, count]) => (
                  <div key={table} className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                    <p className="text-xs text-gray-500 dark:text-gray-400 capitalize"><bdi dir="ltr">{table.replace('_', ' ')}</bdi></p>
                    <p className="text-lg font-semibold text-gray-900 dark:text-white">{fmt.int(count)}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Last Updated */}
            <p className="text-xs text-gray-400 text-end">
              {t('system.storage.lastUpdated', { time: formatDateTime(storageInfo.timestamp) })}
            </p>
          </div>
        ) : (
          <div className="text-center py-8 bg-gray-50 dark:bg-gray-900 rounded-lg border-2 border-dashed border-gray-200 dark:border-gray-700">
            <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
            </svg>
            <p className="mt-2 text-gray-500 dark:text-gray-400">{t('system.storage.unavailable')}</p>
          </div>
        )}
      </div>

      {/* System Logs Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-gray-900 dark:text-white flex items-center">
            <svg className="h-5 w-5 me-2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {t('system.logs.title')}
          </h3>
          <div className="flex items-center gap-3">
            {/* Log Level Filter */}
            <select
              value={logsFilter}
              aria-label={t('system.logs.levelFilter')}
              onChange={(e) => {
                setLogsFilter(e.target.value);
                fetchLogs(e.target.value);
              }}
              className="text-sm border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:text-white"
            >
              <option value="all">{t('system.logs.filter.all')}</option>
              <option value="error">{t('system.logs.filter.error')}</option>
              <option value="warning">{t('system.logs.filter.warning')}</option>
              <option value="info">{t('system.logs.filter.info')}</option>
              <option value="debug">{t('system.logs.filter.debug')}</option>
            </select>
            {/* Refresh Button */}
            <button
              onClick={() => fetchLogs()}
              disabled={logsLoading}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              title={t('refreshTitle.logs')}
              aria-label={t('refreshTitle.logs')}
            >
              <svg className={`h-5 w-5 ${logsLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        </div>

        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('system.logs.help')}
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
                <div key={index} className="flex items-start gap-3 py-1 border-b border-gray-800 last:border-0">
                  {/* Timestamp */}
                  <span className="text-gray-500 text-xs whitespace-nowrap">
                    {formatDateTime(log.timestamp)}
                  </span>
                  {/* Log Level Badge */}
                  <span className={`px-2 py-0.5 text-xs font-medium rounded uppercase ${
                    log.level === 'error' ? 'bg-red-900 text-red-200' :
                    log.level === 'warning' ? 'bg-amber-900 text-amber-200' :
                    log.level === 'debug' ? 'bg-purple-900 text-purple-200' :
                    'bg-blue-900 text-blue-200'
                  }`}>
                    {t(`system.logs.level.${log.level}`, { defaultValue: log.level })}
                  </span>
                  {/* Source Badge */}
                  {log.source && (
                    <span className="px-2 py-0.5 text-xs font-medium rounded bg-gray-700 text-gray-300">
                      {log.source}
                    </span>
                  )}
                  {/* Message */}
                  <span dir="auto" className={`flex-1 ${
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
            <p className="text-xs text-gray-400 text-end">
              {t('system.logs.showing', { count: systemLogs.length })}
            </p>
          </div>
        ) : (
          <div className="text-center py-8 bg-gray-50 dark:bg-gray-900 rounded-lg border-2 border-dashed border-gray-200 dark:border-gray-700">
            <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="mt-2 text-gray-500 dark:text-gray-400">{t('system.logs.empty')}</p>
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
              <svg className="animate-spin -ms-1 me-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {t('common:actions.saving')}
            </>
          ) : (
            <>
              <svg className="h-4 w-4 me-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {t('system.save')}
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function CloudSettings() {
  const { token } = useAuth();
  const { formatDateTime } = useSettings();
  const { t } = useTranslation('settings');
  const fmt = useFormat();
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
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setCloudStatus(data);
      setError(null);
    } catch (err) {
      setError(t('cloud.errors.loadFailed', { error: err.message }));
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
        throw new Error(data.message || `HTTP ${response.status}`);
      }
      const data = await response.json();
      setProgramMessage({ type: 'success', text: t('cloud.suggested.approved', { id: data.automationId }) });
      fetchSuggestedPrograms();
    } catch (err) {
      setProgramMessage({ type: 'error', text: t('cloud.errors.approveFailed', { error: err.message }) });
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
        throw new Error(data.message || `HTTP ${response.status}`);
      }
      setProgramMessage({ type: 'success', text: t('cloud.suggested.rejected') });
      fetchSuggestedPrograms();
    } catch (err) {
      setProgramMessage({ type: 'error', text: t('cloud.errors.rejectFailed', { error: err.message }) });
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
          message: data.message || t('cloud.errors.testFailed')
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
        message: err.message ? `${t('cloud.errors.testFailed')} (${err.message})` : t('cloud.errors.testFailed')
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
      setConnectError(t('cloud.errors.fieldsRequired'));
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
        throw new Error(data.message || `HTTP ${response.status}`);
      }

      setShowConnectModal(false);
      setConnectForm({ url: '', apiKey: '' });
      fetchCloudStatus();
    } catch (err) {
      setConnectError(t('cloud.errors.connectFailed', { error: err.message }));
    } finally {
      setConnectLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm(t('cloud.confirmDisconnect'))) return;

    try {
      const response = await fetch(`${API_BASE}/cloud/disconnect`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      fetchCloudStatus();
    } catch (err) {
      setError(t('cloud.errors.disconnectFailed', { error: err.message }));
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

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setSyncMessage({ type: 'success', text: t('cloud.sync.triggered', { time: formatDateTime(data.timestamp) }) });
      fetchCloudStatus();
      fetchSyncHistory(); // Refresh sync history
    } catch (err) {
      setSyncMessage({ type: 'error', text: t('cloud.errors.syncFailed', { error: err.message }) });
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
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('cloud.title')}</h2>

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-800 dark:text-red-200 text-sm">
          {error}
        </div>
      )}

      {/* Connection Status Card */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-gray-900 dark:text-white">{t('cloud.status.title')}</h3>
          <button
            onClick={fetchCloudStatus}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            title={t('refreshTitle.status')}
            aria-label={t('refreshTitle.status')}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        {/* Status Indicator */}
        <div className="flex items-center mb-6">
          <div className={`h-4 w-4 rounded-full me-3 ${
            cloudStatus?.connected
              ? 'bg-green-500'
              : cloudStatus?.configured
                ? 'bg-amber-500'
                : 'bg-gray-400'
          }`}></div>
          <div>
            <p className="font-medium text-gray-900 dark:text-white">
              {cloudStatus?.connected
                ? t('cloud.status.connected')
                : cloudStatus?.configured
                  ? t('cloud.status.configuredDisconnected')
                  : t('cloud.status.notConfigured')}
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {cloudStatus?.connected
                ? t('cloud.status.syncActive')
                : cloudStatus?.configured
                  ? t('cloud.status.unreachable')
                  : t('cloud.status.noConnection')}
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
            <div className="ms-4">
              <h4 className={`text-lg font-semibold ${
                cloudStatus?.connected
                  ? 'text-green-800'
                  : cloudStatus?.configured
                    ? 'text-amber-800'
                    : 'text-gray-700'
              }`}>
                {cloudStatus?.connected
                  ? t('cloud.status.cloudConnected')
                  : cloudStatus?.configured
                    ? t('cloud.status.cloudDisconnected')
                    : t('cloud.status.offlineMode')}
              </h4>
              <p className={`text-sm ${
                cloudStatus?.connected
                  ? 'text-green-700'
                  : cloudStatus?.configured
                    ? 'text-amber-700'
                    : 'text-gray-500'
              }`}>
                {cloudStatus?.connected
                  ? t('cloud.status.syncingNormally')
                  : cloudStatus?.configured
                    ? t('cloud.status.willReconnect')
                    : t('cloud.status.independent')}
              </p>
            </div>
          </div>
        </div>

        {/* Status Details */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('cloud.status.lastSync')}</p>
            <p className="font-medium text-gray-900 dark:text-white">
              {cloudStatus?.lastSync
                ? formatDateTime(cloudStatus.lastSync.timestamp)
                : t('cloud.status.never')}
            </p>
          </div>
          <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('cloud.status.pendingItems')}</p>
            <p className="font-medium text-gray-900 dark:text-white">
              {t('cloud.status.items', { count: cloudStatus?.pendingItems || 0 })}
            </p>
          </div>
          <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('cloud.status.configuration')}</p>
            <p className="font-medium text-gray-900 dark:text-white">
              {cloudStatus?.configured ? t('cloud.status.configured') : t('cloud.status.notConfiguredLower')}
            </p>
          </div>
        </div>

        {/* Sync Message */}
        {syncMessage && (
          <div className={`mb-4 p-3 rounded text-sm ${
            syncMessage.type === 'success'
              ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 border border-green-200 dark:border-green-800'
              : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 border border-red-200 dark:border-red-800'
          }`}>
            {syncMessage.text}
          </div>
        )}

        {/* Test Connection Result */}
        {testResult && (
          <div className={`mb-4 p-3 rounded text-sm ${
            testResult.success
              ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 border border-green-200 dark:border-green-800'
              : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 border border-red-200 dark:border-red-800'
          }`}>
            <div className="flex items-center">
              {testResult.success ? (
                <svg className="h-5 w-5 me-2 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="h-5 w-5 me-2 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              )}
              <span className="font-medium">{testResult.message}</span>
            </div>
            {testResult.success && testResult.details && (
              <div className="mt-2 text-xs grid grid-cols-2 gap-2">
                <span>{t('cloud.test.latency', { value: fmt.withUnit(testResult.details.latency, 'ms', { decimals: 0 }) })}</span>
                <span>{t('cloud.test.server', { version: testResult.details.serverVersion })}</span>
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
                    <svg className="animate-spin -ms-1 me-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    {t('cloud.test.testing')}
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4 me-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {t('cloud.test.button')}
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
                    <svg className="animate-spin -ms-1 me-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    {t('cloud.sync.syncing')}
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4 me-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    {t('cloud.sync.now')}
                  </>
                )}
              </button>
              <button
                onClick={handleDisconnect}
                className="px-4 py-2 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/40 flex items-center"
              >
                <svg className="h-4 w-4 me-2 rtl:-scale-x-100" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                {t('cloud.disconnect')}
              </button>
            </>
          ) : (
            <button
              onClick={() => setShowConnectModal(true)}
              className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 flex items-center"
            >
              <svg className="h-4 w-4 me-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
              </svg>
              {t('cloud.configure')}
            </button>
          )}
        </div>
      </div>

      {/* Pending Sync Queue Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-gray-900 dark:text-white flex items-center">
            <svg className="h-5 w-5 me-2 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {t('cloud.queue.title')}
            {pendingQueue.length > 0 && (
              <span className="ms-2 px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 rounded-full">
                {pendingQueue.length}
              </span>
            )}
          </h3>
          <button
            onClick={fetchPendingQueue}
            disabled={queueLoading}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            title={t('refreshTitle.queue')}
            aria-label={t('refreshTitle.queue')}
          >
            <svg className={`h-5 w-5 ${queueLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('cloud.queue.help')}
        </p>

        {queueLoading ? (
          <div className="flex items-center justify-center py-8">
            <svg className="animate-spin h-6 w-6 text-primary-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
        ) : pendingQueue.length === 0 ? (
          <div className="text-center py-8 bg-gray-50 dark:bg-gray-900 rounded-lg border-2 border-dashed border-gray-200 dark:border-gray-700">
            <svg className="mx-auto h-10 w-10 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <p className="mt-2 text-gray-500 dark:text-gray-400">{t('cloud.queue.empty')}</p>
            <p className="text-sm text-gray-400">{t('cloud.queue.emptyHelp')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900">
                <tr>
                  <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('cloud.queue.entity')}</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('cloud.queue.action')}</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('cloud.queue.status')}</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('cloud.queue.created')}</th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {pendingQueue.map((item) => {
                  const payload = item.payload ? JSON.parse(item.payload) : {};
                  return (
                    <tr key={item.id} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center">
                          <span className="px-2 py-1 text-xs font-medium bg-blue-100 text-blue-700 rounded me-2">
                            {t(`cloud.entity.${item.entity_type}`, { defaultValue: item.entity_type })}
                          </span>
                          <span className="text-sm text-gray-900 dark:text-white" dir="auto">
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
                          {t(`cloud.action.${item.action}`, { defaultValue: item.action })}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                          item.status === 'pending' ? 'bg-amber-100 text-amber-700' :
                          item.status === 'syncing' ? 'bg-blue-100 text-blue-700' :
                          item.status === 'failed' ? 'bg-red-100 text-red-700' :
                          'bg-green-100 text-green-700'
                        }`}>
                          {t(`cloud.queueStatus.${item.status}`, { defaultValue: item.status })}
                        </span>
                        {item.retry_count > 0 && (
                          <span className="ms-1 text-xs text-gray-500">
                            {t('cloud.queue.retry', { n: item.retry_count })}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600 dark:text-gray-400">
                        {formatDateTime(item.created_at)}
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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-gray-900 dark:text-white flex items-center">
            <svg className="h-5 w-5 me-2 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {t('cloud.history.title')}
          </h3>
          <button
            onClick={fetchSyncHistory}
            disabled={historyLoading}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            title={t('refreshTitle.history')}
            aria-label={t('refreshTitle.history')}
          >
            <svg className={`h-5 w-5 ${historyLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('cloud.history.help')}
        </p>

        {historyLoading ? (
          <div className="flex items-center justify-center py-8">
            <svg className="animate-spin h-6 w-6 text-primary-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
        ) : syncHistory.length === 0 ? (
          <div className="text-center py-8 bg-gray-50 dark:bg-gray-900 rounded-lg border-2 border-dashed border-gray-200 dark:border-gray-700">
            <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="mt-2 text-gray-500 dark:text-gray-400">{t('cloud.history.empty')}</p>
            <p className="text-sm text-gray-400">{t('cloud.history.emptyHelp')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900">
                <tr>
                  <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('cloud.history.time')}</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('cloud.history.type')}</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('cloud.history.status')}</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('cloud.history.items')}</th>
                  <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('cloud.history.triggeredBy')}</th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {syncHistory.map((sync) => (
                  <tr key={sync.id} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 dark:text-white">
                      {formatDateTime(sync.started_at)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                        sync.sync_type === 'manual' ? 'bg-blue-100 text-blue-700' :
                        sync.sync_type === 'automatic' ? 'bg-purple-100 text-purple-700' :
                        'bg-gray-100 text-gray-700'
                      }`}>
                        {t(`cloud.syncType.${sync.sync_type}`, { defaultValue: sync.sync_type })}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`px-2 py-1 text-xs font-medium rounded-full flex items-center w-fit ${
                        sync.status === 'success' ? 'bg-green-100 text-green-700' :
                        sync.status === 'partial' ? 'bg-amber-100 text-amber-700' :
                        'bg-red-100 text-red-700'
                      }`}>
                        {sync.status === 'success' ? (
                          <svg className="h-3 w-3 me-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        ) : sync.status === 'partial' ? (
                          <svg className="h-3 w-3 me-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                          </svg>
                        ) : (
                          <svg className="h-3 w-3 me-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        )}
                        {t(`cloud.syncStatus.${sync.status}`, { defaultValue: sync.status })}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600 dark:text-gray-400">
                      {t('cloud.history.synced', { n: sync.items_synced })}
                      {sync.items_failed > 0 && (
                        <span className="text-red-500 ms-1">{t('cloud.history.failed', { n: sync.items_failed })}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600 dark:text-gray-400" dir="auto">
                      {sync.triggered_by_name || t('cloud.history.system')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Suggested Programs Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-md font-medium text-gray-900 dark:text-white flex items-center">
            <svg className="h-5 w-5 me-2 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            {t('cloud.suggested.title')}
          </h3>
          <button
            onClick={fetchSuggestedPrograms}
            disabled={suggestedLoading}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            title={t('refreshTitle.suggested')}
            aria-label={t('refreshTitle.suggested')}
          >
            <svg className={`h-5 w-5 ${suggestedLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('cloud.suggested.help')}
        </p>

        {programMessage && (
          <div className={`mb-4 p-3 rounded text-sm ${
            programMessage.type === 'success'
              ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 border border-green-200 dark:border-green-800'
              : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 border border-red-200 dark:border-red-800'
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
          <div className="text-center py-8 bg-gray-50 dark:bg-gray-900 rounded-lg border-2 border-dashed border-gray-200 dark:border-gray-700">
            <svg className="mx-auto h-10 w-10 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            <p className="mt-2 text-gray-500 dark:text-gray-400">{t('cloud.suggested.empty')}</p>
            <p className="text-sm text-gray-400">{t('cloud.suggested.emptyHelp')}</p>
          </div>
        ) : (
          <div className="space-y-4">
            {suggestedPrograms.map((program) => (
              <div key={program.id} className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-900">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="font-medium text-gray-900 dark:text-white" dir="auto">{program.name}</h4>
                      <span className="px-2 py-0.5 text-xs font-medium bg-purple-100 text-purple-700 rounded-full">
                        {t('cloud.suggested.badge')}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mb-2" dir="auto">{program.description || t('cloud.suggested.noDescription')}</p>

                    {/* Trigger Info */}
                    {program.trigger_config && (
                      <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 mb-1">
                        <span className="font-medium">{t('cloud.suggested.trigger')}</span>
                        <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded">
                          {program.trigger_config.type === 'schedule' ? t('cloud.suggested.schedule', { schedule: program.trigger_config.schedule || t('cloud.suggested.custom') }) : program.trigger_config.type}
                        </span>
                      </div>
                    )}

                    {/* Actions Info */}
                    {program.actions && program.actions.length > 0 && (
                      <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                        <span className="font-medium">{t('cloud.suggested.actions')}</span>
                        <span>{t('cloud.suggested.actionCount', { count: program.actions.length })}</span>
                      </div>
                    )}

                    <p className="text-xs text-gray-400 mt-2">
                      {t('cloud.suggested.meta', { id: program.cloud_id, time: formatDateTime(program.created_at) })}
                    </p>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex gap-2 ms-4">
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
                          <svg className="h-4 w-4 me-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          {t('cloud.suggested.approve')}
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => handleRejectProgram(program.id)}
                      disabled={actionLoading === program.id}
                      className="px-3 py-1.5 text-sm bg-red-100 text-red-700 rounded-lg hover:bg-red-200 disabled:opacity-50 flex items-center"
                    >
                      <svg className="h-4 w-4 me-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                      {t('cloud.suggested.reject')}
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
            <div className="inline-block w-full max-w-md p-4 sm:p-6 my-8 mx-4 overflow-hidden text-start align-middle transition-all transform bg-white dark:bg-gray-800 shadow-xl rounded-lg relative">
              <button onClick={() => setShowConnectModal(false)} aria-label={t('common:actions.close')} className="absolute top-4 end-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('cloud.modal.title')}</h3>

              {connectError && (
                <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-800 dark:text-red-200 text-sm">
                  {connectError}
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('cloud.modal.url')}</label>
                  <input
                    type="url"
                    dir="ltr"
                    value={connectForm.url}
                    onChange={(e) => setConnectForm({ ...connectForm, url: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
                    placeholder="https://cloud.sensehub.io"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('cloud.modal.apiKey')}</label>
                  <input
                    type="password"
                    value={connectForm.apiKey}
                    onChange={(e) => setConnectForm({ ...connectForm, apiKey: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
                    placeholder={t('cloud.modal.apiKeyPlaceholder')}
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={() => setShowConnectModal(false)}
                  className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600"
                >
                  {t('common:actions.cancel')}
                </button>
                <button
                  onClick={handleConnect}
                  disabled={connectLoading}
                  className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 flex items-center"
                >
                  {connectLoading ? (
                    <>
                      <svg className="animate-spin -ms-1 me-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      {t('cloud.modal.connecting')}
                    </>
                  ) : (
                    t('cloud.modal.connect')
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

/**
 * Bytes as "1.23 MB" through the i18n formatters: unit abbreviations stay
 * untranslated, the number follows the active language (Turkish groups with a
 * narrow space, Arabic isolates value+unit). Same unit steps as before.
 */
function formatBytesI18n(fmt, bytes) {
  if (!bytes || bytes === 0) return fmt.withUnit(0, 'B', { decimals: 0 });
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return fmt.withUnit(bytes / Math.pow(1024, i), units[i], { decimals: i > 1 ? 2 : 0 });
}

// Example token format shown as the input placeholder (data, not text).
const TELEGRAM_TOKEN_PLACEHOLDER = '123456789:ABCdefGhIjKlMnOpQrStUvWxYz';
const TELEGRAM_GET_UPDATES_URL = 'https://api.telegram.org/bot<TOKEN>/getUpdates';
const TELEGRAM_CHAT_SNIPPET = '"chat":{"id":';

function NotificationSettings() {
  const { t } = useTranslation('settings');
  const { token } = useAuth();
  const { formatDateTime } = useSettings();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  // Language of the Telegram messages (server setting telegram_language), independent of the UI language.
  const [telegramLanguage, setTelegramLanguage] = useState('en');

  const [watchdogStatus, setWatchdogStatus] = useState(null);

  React.useEffect(() => {
    fetchConfig();
    fetchWatchdogStatus();
  }, []);

  const fetchConfig = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_BASE}/notifications/telegram`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) throw new Error(t('notifications.errors.loadFailed'));
      const data = await response.json();
      setBotToken(data.has_token ? '***configured***' : '');
      setChatId(data.chat_id || '');
      setEnabled(data.enabled);
      setHasToken(data.has_token);
      setTelegramLanguage(LANGUAGES.some((l) => l.code === data.language) ? data.language : 'en');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchWatchdogStatus = async () => {
    try {
      const response = await fetch(`${API_BASE}/notifications/watchdog`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.ok) {
        setWatchdogStatus(await response.json());
      }
    } catch (err) {
      // Non-critical
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const body = { enabled, language: telegramLanguage };
      if (botToken && botToken !== '***configured***') body.bot_token = botToken;
      if (chatId) body.chat_id = chatId;

      const response = await fetch(`${API_BASE}/notifications/telegram`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(t('notifications.errors.saveFailed'));
      setSuccessMessage(t('notifications.saved'));
      if (botToken && botToken !== '***configured***') {
        setHasToken(true);
        setBotToken('***configured***');
      }
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    setSuccessMessage(null);
    try {
      // The test message is sent in the selected Telegram language.
      const body = { language: telegramLanguage };
      if (botToken && botToken !== '***configured***') body.bot_token = botToken;
      if (chatId) body.chat_id = chatId;

      const response = await fetch(`${API_BASE}/notifications/telegram/test`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || t('notifications.errors.testFailed'));
      }
      setSuccessMessage(t('notifications.testSent'));
      setTimeout(() => setSuccessMessage(null), 5000);
    } catch (err) {
      setError(err.message);
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  const codeClass = 'bg-blue-100 dark:bg-blue-800 px-1 rounded';
  const stepComponents = {
    b: <strong />,
    code: <code className={codeClass} dir="ltr" />,
    url: <code className={`${codeClass} text-xs break-all`} dir="ltr" />,
    br: <br />,
  };

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('notifications.title')}</h2>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 mb-4 text-sm text-red-800 dark:text-red-400">
          {error}
        </div>
      )}
      {successMessage && (
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-3 mb-4 text-sm text-green-800 dark:text-green-400 flex items-center">
          <svg className="h-4 w-4 me-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {successMessage}
        </div>
      )}

      {/* Telegram Configuration */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
        <div className="flex items-center mb-4">
          <svg className="h-6 w-6 me-2 text-blue-500" viewBox="0 0 24 24" fill="currentColor">
            <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
          </svg>
          <h3 className="text-md font-medium text-gray-900 dark:text-white">{t('notifications.telegram.title')}</h3>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('notifications.telegram.intro')}
        </p>

        {/* Setup instructions */}
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-4">
          <h4 className="text-sm font-medium text-blue-800 dark:text-blue-400 mb-2">{t('notifications.telegram.setupTitle')}</h4>
          <ol className="text-sm text-blue-700 dark:text-blue-300 space-y-1 list-decimal list-inside">
            <li><Trans i18nKey="settings:notifications.telegram.steps.findBotFather" components={stepComponents} /></li>
            <li><Trans i18nKey="settings:notifications.telegram.steps.newBot" components={stepComponents} /></li>
            <li><Trans i18nKey="settings:notifications.telegram.steps.copyToken" components={stepComponents} /></li>
            <li>{t('notifications.telegram.steps.addToChat')}</li>
            <li>
              <Trans
                i18nKey="settings:notifications.telegram.steps.findChatId"
                values={{ url: TELEGRAM_GET_UPDATES_URL, snippet: TELEGRAM_CHAT_SNIPPET }}
                components={stepComponents}
              />
            </li>
            <li><Trans i18nKey="settings:notifications.telegram.steps.pasteAndTest" components={stepComponents} /></li>
          </ol>
        </div>

        <div className="space-y-4">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('notifications.telegram.enable')}</label>
            <button
              onClick={() => setEnabled(!enabled)}
              role="switch"
              aria-checked={enabled}
              aria-label={t('notifications.telegram.enable')}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                enabled ? 'bg-primary-600' : 'bg-gray-300 dark:bg-gray-600'
              }`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                enabled ? 'translate-x-6 rtl:-translate-x-6' : 'translate-x-1 rtl:-translate-x-1'
              }`} />
            </button>
          </div>

          {/* Bot Token */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('notifications.telegram.botToken')}</label>
            <input
              type={botToken === '***configured***' ? 'text' : 'password'}
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              onFocus={() => { if (botToken === '***configured***') setBotToken(''); }}
              placeholder={TELEGRAM_TOKEN_PLACEHOLDER}
              dir="ltr"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white font-mono"
            />
            {hasToken && botToken === '***configured***' && (
              <p className="text-xs text-green-600 dark:text-green-400 mt-1">{t('notifications.telegram.tokenConfigured')}</p>
            )}
          </div>

          {/* Chat ID */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('notifications.telegram.chatId')}</label>
            <input
              type="text"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="-1001234567890"
              dir="ltr"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white font-mono"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('notifications.telegram.chatIdHelp')}</p>
          </div>

          {/* Message language */}
          <div>
            <label htmlFor="telegram-language" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('notifications.telegram.language')}</label>
            <select
              id="telegram-language"
              value={telegramLanguage}
              onChange={(e) => setTelegramLanguage(e.target.value)}
              className="w-full sm:w-64 px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code} lang={l.code} dir={l.dir}>{l.name}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('notifications.telegram.languageHelp')}</p>
          </div>

          {/* Buttons */}
          <div className="flex flex-wrap gap-3 pt-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm hover:bg-primary-700 disabled:opacity-50"
            >
              {saving ? t('common:actions.saving') : t('notifications.telegram.save')}
            </button>
            <button
              onClick={handleTest}
              disabled={testing || (!hasToken && !botToken) || !chatId}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {testing ? t('notifications.telegram.sending') : t('notifications.telegram.test')}
            </button>
          </div>
        </div>
      </div>

      {/* Watchdog Status */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
        <h3 className="text-md font-medium text-gray-900 dark:text-white mb-4 flex items-center">
          <svg className="h-5 w-5 me-2 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
          {t('notifications.watchdog.title')}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('notifications.watchdog.intro')}
        </p>
        <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1 mb-4 list-disc list-inside">
          <li>{t('notifications.watchdog.reasons.missedSchedule')}</li>
          <li>{t('notifications.watchdog.reasons.thresholdNotExecuted')}</li>
          <li>{t('notifications.watchdog.reasons.equipmentOffline')}</li>
        </ul>

        {watchdogStatus && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('notifications.watchdog.monitoredAutomations')}</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white">{watchdogStatus.monitored_automations}</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('notifications.watchdog.offlineEquipment')}</p>
              <p className={`text-xl font-bold ${watchdogStatus.offline_equipment > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                {watchdogStatus.offline_equipment}
              </p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('notifications.watchdog.equipmentErrors')}</p>
              <p className={`text-xl font-bold ${watchdogStatus.error_equipment > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {watchdogStatus.error_equipment}
              </p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('notifications.watchdog.telegram')}</p>
              <p className={`text-xl font-bold ${watchdogStatus.telegram_configured ? 'text-green-600' : 'text-gray-400'}`}>
                {watchdogStatus.telegram_configured ? t('notifications.watchdog.telegramActive') : t('notifications.watchdog.telegramOff')}
              </p>
            </div>
          </div>
        )}

        {/* Recent watchdog alerts (server-generated text) */}
        {watchdogStatus?.recent_alerts?.length > 0 && (
          <div>
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('notifications.watchdog.recentAlerts')}</h4>
            <div className="max-h-60 overflow-y-auto space-y-2">
              {watchdogStatus.recent_alerts.map((alert) => (
                <div key={alert.id} className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800 rounded p-2 text-sm">
                  <div className="flex justify-between items-start">
                    <span className="text-amber-800 dark:text-amber-400" dir="auto">{alert.message?.replace('Watchdog: ', '')}</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 ms-2 flex-shrink-0">{formatDateTime(alert.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {watchdogStatus?.recent_alerts?.length === 0 && (
          <p className="text-sm text-green-600 dark:text-green-400 flex items-center">
            <svg className="h-4 w-4 me-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {t('notifications.watchdog.noAlerts')}
          </p>
        )}
      </div>
    </div>
  );
}

function BackupSettings() {
  const { t } = useTranslation('settings');
  const fmt = useFormat();
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
      // The backup endpoint streams the real SQLite DB file as an attachment.
      // Fetch it as a blob and trigger a browser download.
      const response = await fetch(`${API_BASE}/settings/backup`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        let msg = t('backup.errors.createFailed');
        try {
          const data = await response.json();
          msg = data.message || msg;
        } catch (e) { /* non-JSON error */ }
        throw new Error(msg);
      }

      // Derive filename from Content-Disposition, falling back to a timestamp.
      let filename = `sensehub-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
      const disposition = response.headers.get('Content-Disposition');
      if (disposition) {
        const match = /filename="?([^"]+)"?/.exec(disposition);
        if (match && match[1]) filename = match[1];
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      const size = fmt.withUnit(blob.size / (1024 * 1024), 'MB', { decimals: 2 });
      setBackupMessage({ type: 'success', text: t('backup.downloaded', { filename, size }) });
    } catch (err) {
      setBackupMessage({ type: 'error', text: err.message });
    } finally {
      setBackupLoading(false);
    }
  };

  const handleFactoryReset = async () => {
    if (!resetPassword) {
      setResetError(t('backup.factoryReset.passwordRequired'));
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
        throw new Error(data.message || t('backup.factoryReset.failed'));
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
      setRestoreError(t('backup.restore.fileRequired'));
      return;
    }

    setRestoreLoading(true);
    setRestoreError(null);

    try {
      // Upload the chosen SQLite backup file as the raw request body. The backend
      // validates it, safety-backs-up the current DB, swaps in the upload, and
      // restarts the process to load the restored database.
      const response = await fetch(`${API_BASE}/settings/restore`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/octet-stream'
        },
        body: restoreFile
      });

      if (!response.ok) {
        let msg = t('backup.restore.failed');
        try {
          const data = await response.json();
          msg = data.message || msg;
        } catch (e) { /* non-JSON error */ }
        throw new Error(msg);
      }

      // Success: backend is restarting. Log the user out shortly so they
      // re-authenticate against the restored database.
      setRestoreSuccess(true);
      setTimeout(() => {
        logout();
        navigate('/login');
      }, 6000);
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
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('backup.title')}</h2>

      {/* Backup Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
        <h3 className="text-md font-medium text-gray-900 dark:text-white mb-4">{t('backup.create.title')}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('backup.create.description')}
        </p>

        {backupMessage && (
          <div className={`mb-4 p-3 rounded text-sm break-words ${
            backupMessage.type === 'success'
              ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 border border-green-200 dark:border-green-800'
              : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 border border-red-200 dark:border-red-800'
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
              <svg className="animate-spin -ms-1 me-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {t('backup.create.creating')}
            </>
          ) : (
            <>
              <svg className="h-4 w-4 me-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              {t('backup.create.button')}
            </>
          )}
        </button>
      </div>

      {/* Restore Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6 border-2 border-amber-200 dark:border-amber-700">
        <h3 className="text-md font-medium text-amber-700 mb-4 flex items-center">
          <svg className="h-5 w-5 me-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {t('backup.restore.title')}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          <Trans i18nKey="settings:backup.restore.description" components={{ warn: <strong className="text-amber-600" /> }} />
        </p>
        <button
          onClick={() => setShowRestoreModal(true)}
          className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 flex items-center"
        >
          <svg className="h-4 w-4 me-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          {t('backup.restore.button')}
        </button>
      </div>

      {/* Factory Reset Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 border-2 border-red-200 dark:border-red-800">
        <h3 className="text-md font-medium text-red-600 mb-4 flex items-center">
          <svg className="h-5 w-5 me-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          {t('backup.factoryReset.title')}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          <Trans i18nKey="settings:backup.factoryReset.description" components={{ warn: <strong className="text-red-600" /> }} />
        </p>
        <button
          onClick={() => setShowFactoryResetModal(true)}
          className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 flex items-center"
        >
          <svg className="h-4 w-4 me-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          {t('backup.factoryReset.button')}
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
            <div className="inline-block w-full max-w-md p-4 sm:p-6 my-8 mx-4 overflow-hidden text-start align-middle transition-all transform bg-white dark:bg-gray-800 shadow-xl rounded-lg relative">
              {/* Close button */}
              <button
                onClick={closeFactoryResetModal}
                aria-label={t('common:actions.close')}
                className="absolute top-4 end-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
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
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">{t('backup.factoryReset.initiated')}</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400">{t('backup.factoryReset.restarting')}</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center mb-4 pe-8">
                    <div className="flex-shrink-0 h-10 w-10 bg-red-100 rounded-full flex items-center justify-center me-3">
                      <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                    </div>
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('backup.factoryReset.confirmTitle')}</h3>
                  </div>

                  <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                    {t('backup.factoryReset.confirmBody')}
                  </p>

                  {resetError && (
                    <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                      <div className="flex items-center">
                        <svg className="h-5 w-5 text-red-500 me-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span className="text-red-800 dark:text-red-200 text-sm">{resetError}</span>
                      </div>
                    </div>
                  )}

                  <div className="mb-4">
                    <label htmlFor="reset-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('backup.factoryReset.passwordLabel')}
                    </label>
                    <input
                      type="password"
                      id="reset-password"
                      value={resetPassword}
                      onChange={(e) => setResetPassword(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-red-500 focus:border-red-500 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
                      placeholder={t('backup.factoryReset.passwordPlaceholder')}
                      autoFocus
                    />
                  </div>

                  <div className="flex justify-end gap-3">
                    <button
                      onClick={closeFactoryResetModal}
                      className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600"
                      disabled={resetLoading}
                    >
                      {t('common:actions.cancel')}
                    </button>
                    <button
                      onClick={handleFactoryReset}
                      disabled={resetLoading || !resetPassword}
                      className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                    >
                      {resetLoading ? (
                        <>
                          <svg className="animate-spin -ms-1 me-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          {t('backup.processing')}
                        </>
                      ) : (
                        t('backup.factoryReset.confirmButton')
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
            <div className="inline-block w-full max-w-md p-4 sm:p-6 my-8 mx-4 overflow-hidden text-start align-middle transition-all transform bg-white dark:bg-gray-800 shadow-xl rounded-lg relative">
              {/* Close button */}
              <button
                onClick={closeRestoreModal}
                aria-label={t('common:actions.close')}
                className="absolute top-4 end-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
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
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">{t('backup.restore.completeTitle')}</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t('backup.restore.completeBody')}
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex items-center mb-4 pe-8">
                    <div className="flex-shrink-0 h-10 w-10 bg-amber-100 rounded-full flex items-center justify-center me-3">
                      <svg className="h-6 w-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </div>
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('backup.restore.title')}</h3>
                  </div>

                  <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                    {t('backup.restore.confirmBody')}
                  </p>

                  {restoreError && (
                    <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                      <div className="flex items-center">
                        <svg className="h-5 w-5 text-red-500 me-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span className="text-red-800 dark:text-red-200 text-sm">{restoreError}</span>
                      </div>
                    </div>
                  )}

                  <div className="mb-4">
                    <label htmlFor="backup-file-input" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {t('backup.restore.selectFile')}
                    </label>
                    <input
                      type="file"
                      id="backup-file-input"
                      accept=".db,.sqlite,.sqlite3"
                      onChange={handleFileSelect}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-amber-500 focus:border-amber-500 dark:bg-gray-700 dark:text-white text-sm"
                    />
                    {restoreFile && (
                      <p className="mt-2 text-sm text-green-600 flex items-center break-all">
                        <svg className="h-4 w-4 me-1 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        {t('backup.restore.selected', { name: restoreFile.name })}
                      </p>
                    )}
                  </div>

                  <div className="flex justify-end gap-3">
                    <button
                      onClick={closeRestoreModal}
                      className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600"
                      disabled={restoreLoading}
                    >
                      {t('common:actions.cancel')}
                    </button>
                    <button
                      onClick={handleRestore}
                      disabled={restoreLoading || !restoreFile}
                      className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                    >
                      {restoreLoading ? (
                        <>
                          <svg className="animate-spin -ms-1 me-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          {t('backup.restore.restoring')}
                        </>
                      ) : (
                        t('backup.restore.confirmButton')
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

function WatchdogHistory() {
  const { t } = useTranslation('settings');
  const fmt = useFormat();
  const { token } = useAuth();
  const { formatDateTime } = useSettings();
  const [connectivity, setConnectivity] = useState(null);
  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 50;

  const headers = { 'Authorization': `Bearer ${token}` };

  const fetchData = () => {
    setLoading(true);
    const params = new URLSearchParams({ limit: pageSize, offset: page * pageSize });
    if (filter) params.set('event_type', filter);

    Promise.all([
      fetch(`${API_BASE}/system/connectivity`, { headers }).then(r => r.json()),
      fetch(`${API_BASE}/system/watchdog-history?${params}`, { headers }).then(r => r.json()),
    ]).then(([conn, hist]) => {
      setConnectivity(conn);
      setEvents(hist.events);
      setTotal(hist.total);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  React.useEffect(fetchData, [page, filter]);

  // Auto-refresh every 30 seconds
  React.useEffect(() => {
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [page, filter]);

  const totalPages = Math.ceil(total / pageSize);

  const statusColor = (status) => {
    if (status === 'up' || status === 'online') return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
    if (status === 'down' || status === 'offline' || status === 'error') return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';
    return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400';
  };

  const statusDot = (status) => {
    if (status === 'up') return 'bg-green-500';
    if (status === 'down') return 'bg-red-500';
    return 'bg-gray-400';
  };

  // Status / event-type codes come from the server; unknown codes render as-is.
  const statusLabel = (status) => (status ? t(`watchdog.status.${status}`, { defaultValue: status }) : status);
  const eventTypeLabel = (type) => (type ? t(`watchdog.eventType.${type}`, { defaultValue: type }) : type);
  const serviceLabel = (target) => {
    if (target === 'go2rtc') return 'go2rtc';
    if (target === 'mcp') return t('watchdog.service.mcp');
    return t('watchdog.service.internet');
  };

  const formatDuration = (seconds) => {
    if (!seconds) return null;
    return fmt.duration(seconds);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{t('watchdog.title')}</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('watchdog.subtitle')}</p>
      </div>

      {/* Live Connectivity Status */}
      {connectivity?.current && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">{t('watchdog.liveStatus')}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {Object.entries(connectivity.current).filter(([k]) => k !== 'pendingNotifications').map(([target, info]) => (
              <div key={target} className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className={`w-3 h-3 rounded-full ${statusDot(info.status)} ${info.status === 'up' ? 'animate-pulse' : ''}`} />
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{serviceLabel(target)}</span>
                  </div>
                  <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${statusColor(info.status)}`}>
                    {statusLabel(info.status)}
                  </span>
                </div>
                {info.downSince && (
                  <p className="text-xs text-red-500 dark:text-red-400 mt-2">{t('watchdog.downSince', { time: formatDateTime(info.downSince) })}</p>
                )}
              </div>
            ))}
          </div>
          {connectivity.current.pendingNotifications > 0 && (
            <div className="mt-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
              <p className="text-sm text-amber-800 dark:text-amber-400">
                {t('watchdog.queued', { count: connectivity.current.pendingNotifications })}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Connectivity Timeline (last outages) */}
      {connectivity?.history && (() => {
        const outages = connectivity.history.filter(e => (e.status === 'up' || e.status === 'restart') && e.duration_seconds);
        if (outages.length === 0) return null;
        return (
          <div>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">{t('watchdog.recentOutages')}</h3>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900">
                  <tr>
                    <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{t('watchdog.columns.service')}</th>
                    <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{t('watchdog.columns.recoveredAt')}</th>
                    <th className="px-4 py-3 text-end text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{t('watchdog.columns.downtime')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {outages.slice(0, 20).map(e => (
                    <tr key={e.id}>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">{e.event_type === 'system' ? t('watchdog.systemRestart') : (e.target === 'go2rtc' || e.target === 'mcp' || e.target === 'internet') ? serviceLabel(e.target) : e.target}</td>
                      <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">{formatDateTime(e.created_at)}</td>
                      <td className="px-4 py-3 text-sm text-end">
                        <span className="inline-flex px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400 whitespace-nowrap">
                          {formatDuration(e.duration_seconds)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* Full Event History */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{t('watchdog.eventHistory')}</h3>
          <div className="flex gap-2">
            <select value={filter} onChange={e => { setFilter(e.target.value); setPage(0); }}
              aria-label={t('watchdog.filterType')}
              className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
              <option value="">{t('watchdog.allTypes')}</option>
              <option value="connectivity">{t('watchdog.eventType.connectivity')}</option>
              <option value="automation">{t('watchdog.eventType.automation')}</option>
              <option value="equipment">{t('watchdog.eventType.equipment')}</option>
            </select>
            <button onClick={fetchData} className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">
              {t('common:actions.refresh')}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto mb-2" />
            {t('watchdog.loadingEvents')}
          </div>
        ) : events.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('watchdog.noEvents')}</p>
        ) : (
          <>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900">
                  <tr>
                    <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{t('watchdog.columns.time')}</th>
                    <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{t('watchdog.columns.type')}</th>
                    <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{t('watchdog.columns.target')}</th>
                    <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{t('watchdog.columns.status')}</th>
                    <th className="px-4 py-3 text-start text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{t('watchdog.columns.message')}</th>
                    <th className="px-4 py-3 text-end text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{t('watchdog.columns.duration')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {events.map(e => (
                    <tr key={e.id}>
                      <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">{formatDateTime(e.created_at)}</td>
                      <td className="px-4 py-3 text-sm">
                        <span className="inline-flex px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                          {eventTypeLabel(e.event_type)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-900 dark:text-white capitalize" dir="auto">{e.target || '-'}</td>
                      <td className="px-4 py-3 text-sm">
                        <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${statusColor(e.status)}`}>
                          {statusLabel(e.status)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 max-w-xs truncate" title={e.message} dir="auto">{e.message}</td>
                      <td className="px-4 py-3 text-sm text-end text-gray-500 dark:text-gray-400 whitespace-nowrap">{e.duration_seconds ? formatDuration(e.duration_seconds) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('watchdog.totalEvents', { count: total, value: fmt.int(total) })}</p>
                <div className="flex gap-2">
                  <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                    className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-lg disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">{t('common:actions.previous')}</button>
                  <span className="px-3 py-1 text-sm text-gray-600 dark:text-gray-400">{t('watchdog.pageOf', { page: page + 1, total: totalPages })}</span>
                  <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                    className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-lg disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">{t('common:actions.next')}</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function NetworkUsage() {
  const { t } = useTranslation('settings');
  const fmt = useFormat();
  const { token } = useAuth();
  const { formatDateTime } = useSettings();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('daily');
  const [selectedInterface, setSelectedInterface] = useState('');

  const headers = { 'Authorization': `Bearer ${token}` };

  const formatBytes = (bytes) => formatBytesI18n(fmt, bytes);

  const fetchData = () => {
    setLoading(true);
    const params = new URLSearchParams({ period, days: period === 'monthly' ? 12 : 30 });
    if (selectedInterface) params.set('interface', selectedInterface);
    fetch(`${API_BASE}/system/network-usage?${params}`, { headers })
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  };

  React.useEffect(() => { fetchData(); }, [period, selectedInterface]);

  // Aggregate usage across interfaces for chart display
  const getAggregatedUsage = () => {
    if (!data?.usage) return [];
    const map = {};
    for (const row of data.usage) {
      if (!map[row.period]) map[row.period] = { period: row.period, rx: 0, tx: 0, total: 0 };
      map[row.period].rx += row.rx_bytes;
      map[row.period].tx += row.tx_bytes;
      map[row.period].total += row.total_bytes;
    }
    return Object.values(map).sort((a, b) => a.period.localeCompare(b.period));
  };

  const aggregated = data ? getAggregatedUsage() : [];
  const maxTotal = aggregated.length > 0 ? Math.max(...aggregated.map(r => r.total)) : 0;

  // Aggregate today/thisMonth across interfaces
  const todayTotal = data?.today?.reduce((acc, r) => ({ rx: acc.rx + r.rx_bytes, tx: acc.tx + r.tx_bytes, total: acc.total + r.total_bytes }), { rx: 0, tx: 0, total: 0 }) || { rx: 0, tx: 0, total: 0 };
  const monthTotal = data?.thisMonth?.reduce((acc, r) => ({ rx: acc.rx + r.rx_bytes, tx: acc.tx + r.tx_bytes, total: acc.total + r.total_bytes }), { rx: 0, tx: 0, total: 0 }) || { rx: 0, tx: 0, total: 0 };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{t('networkUsage.title')}</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('networkUsage.subtitle')}</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{t('networkUsage.todayDownload')}</p>
          <p className="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1">{formatBytes(todayTotal.rx)}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{t('networkUsage.todayUpload')}</p>
          <p className="text-2xl font-bold text-green-600 dark:text-green-400 mt-1">{formatBytes(todayTotal.tx)}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{t('networkUsage.monthDownload')}</p>
          <p className="text-2xl font-bold text-blue-600 dark:text-blue-400 mt-1">{formatBytes(monthTotal.rx)}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{t('networkUsage.monthUpload')}</p>
          <p className="text-2xl font-bold text-green-600 dark:text-green-400 mt-1">{formatBytes(monthTotal.tx)}</p>
        </div>
      </div>

      {/* Today / Month totals */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-5 flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
            <svg className="w-6 h-6 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
          </div>
          <div>
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('networkUsage.todayTotal')}</p>
            <p className="text-xl font-bold text-gray-900 dark:text-white">{formatBytes(todayTotal.total)}</p>
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-5 flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-purple-100 dark:bg-purple-900/40 flex items-center justify-center">
            <svg className="w-6 h-6 text-purple-600 dark:text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
          </div>
          <div>
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('networkUsage.monthTotal')}</p>
            <p className="text-xl font-bold text-gray-900 dark:text-white">{formatBytes(monthTotal.total)}</p>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg overflow-hidden border border-gray-300 dark:border-gray-600">
          <button
            onClick={() => setPeriod('daily')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${period === 'daily' ? 'bg-primary-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
          >{t('networkUsage.daily')}</button>
          <button
            onClick={() => setPeriod('monthly')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${period === 'monthly' ? 'bg-primary-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
          >{t('networkUsage.monthly')}</button>
        </div>
        {data?.interfaces?.length > 1 && (
          <select
            value={selectedInterface}
            onChange={(e) => setSelectedInterface(e.target.value)}
            aria-label={t('networkUsage.columns.interface')}
            className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
          >
            <option value="">{t('networkUsage.allInterfaces')}</option>
            {data.interfaces.map(i => <option key={i} value={i}>{i}</option>)}
          </select>
        )}
        <button onClick={fetchData} title={t('common:actions.refresh')} aria-label={t('common:actions.refresh')} className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
        </button>
      </div>

      {/* Chart */}
      {loading ? (
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto mb-2"></div>
          {t('networkUsage.loading')}
        </div>
      ) : aggregated.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-8 text-center">
          <svg className="w-12 h-12 text-gray-400 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
          <p className="text-gray-500 dark:text-gray-400">{t('networkUsage.empty')}</p>
          <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">{t('networkUsage.emptyHelp')}</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">
            {period === 'daily' ? t('networkUsage.dailyUsage') : t('networkUsage.monthlyUsage')}
          </h3>
          <div className="space-y-2">
            {aggregated.map((row) => (
              <div key={row.period} className="group">
                <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400 mb-1">
                  <span className="font-medium" dir="ltr">{row.period}</span>
                  <span>{formatBytes(row.total)}</span>
                </div>
                <div className="flex h-5 rounded-full overflow-hidden bg-gray-100 dark:bg-gray-700">
                  <div
                    className="bg-blue-500 transition-all duration-300"
                    style={{ width: maxTotal > 0 ? `${(row.rx / maxTotal) * 100}%` : '0%' }}
                    title={t('networkUsage.downloadValue', { value: formatBytes(row.rx) })}
                  />
                  <div
                    className="bg-green-500 transition-all duration-300"
                    style={{ width: maxTotal > 0 ? `${(row.tx / maxTotal) * 100}%` : '0%' }}
                    title={t('networkUsage.uploadValue', { value: formatBytes(row.tx) })}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-4 mt-4 pt-3 border-t border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              <div className="w-3 h-3 rounded-sm bg-blue-500"></div> {t('networkUsage.download')}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              <div className="w-3 h-3 rounded-sm bg-green-500"></div> {t('networkUsage.upload')}
            </div>
          </div>
        </div>
      )}

      {/* Per-interface breakdown */}
      {data?.summary && data.summary.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">{t('networkUsage.breakdownTitle')}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-start text-xs text-gray-500 dark:text-gray-400 uppercase border-b border-gray-200 dark:border-gray-700">
                  <th className="pb-2 pe-4 text-start">{t('networkUsage.columns.interface')}</th>
                  <th className="pb-2 pe-4 text-start">{t('networkUsage.columns.download')}</th>
                  <th className="pb-2 pe-4 text-start">{t('networkUsage.columns.upload')}</th>
                  <th className="pb-2 pe-4 text-start">{t('networkUsage.columns.total')}</th>
                  <th className="pb-2 text-start">{t('networkUsage.columns.since')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {data.summary.map(row => (
                  <tr key={row.interface} className="text-gray-700 dark:text-gray-300">
                    <td className="py-2 pe-4 font-mono text-xs"><bdi dir="ltr">{row.interface}</bdi></td>
                    <td className="py-2 pe-4 text-blue-600 dark:text-blue-400 whitespace-nowrap">{formatBytes(row.rx_bytes)}</td>
                    <td className="py-2 pe-4 text-green-600 dark:text-green-400 whitespace-nowrap">{formatBytes(row.tx_bytes)}</td>
                    <td className="py-2 pe-4 font-medium whitespace-nowrap">{formatBytes(row.total_bytes)}</td>
                    <td className="py-2 text-xs text-gray-500">{row.first_record ? formatDateTime(row.first_record) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Request Log - API traffic analysis */}
      <RequestLog />
    </div>
  );
}

// Request-log windows in minutes; the label comes from requestLog.window.<minutes>.
const REQUEST_LOG_WINDOWS = [5, 15, 60, 360, 1440];

function RequestLog() {
  const { t } = useTranslation('settings');
  const fmt = useFormat();
  const { token } = useAuth();
  const { formatDateTime } = useSettings();
  const [logData, setLogData] = useState(null);
  const [logLoading, setLogLoading] = useState(true);
  const [logMinutes, setLogMinutes] = useState(60);
  const [showRecent, setShowRecent] = useState(false);

  const headers = { 'Authorization': `Bearer ${token}` };

  const formatBytes = (bytes) => formatBytesI18n(fmt, bytes);
  const formatMs = (ms) => fmt.withUnit(Math.round(ms || 0), 'ms', { decimals: 0 });

  const fetchLog = () => {
    setLogLoading(true);
    fetch(`${API_BASE}/system/request-log?minutes=${logMinutes}`, { headers })
      .then(r => r.json())
      .then(d => { setLogData(d); setLogLoading(false); })
      .catch(() => setLogLoading(false));
  };

  React.useEffect(() => { fetchLog(); }, [logMinutes]);

  const b = <strong />;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{t('requestLog.title')}</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{t('requestLog.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={logMinutes}
            onChange={(e) => setLogMinutes(parseInt(e.target.value))}
            aria-label={t('requestLog.windowLabel')}
            className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300"
          >
            {REQUEST_LOG_WINDOWS.map((m) => (
              <option key={m} value={m}>{t(`requestLog.window.${m}`)}</option>
            ))}
          </select>
          <button onClick={fetchLog} title={t('common:actions.refresh')} aria-label={t('common:actions.refresh')} className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
          </button>
        </div>
      </div>

      {logLoading ? (
        <div className="text-center py-4 text-sm text-gray-500 dark:text-gray-400">{t('common:status.loading')}</div>
      ) : !logData?.byPath?.length ? (
        <div className="text-center py-4 text-sm text-gray-500 dark:text-gray-400">{t('requestLog.empty')}</div>
      ) : (
        <>
          {/* Totals bar */}
          {logData.totals && (
            <div className="flex flex-wrap gap-4 mb-4 text-xs text-gray-600 dark:text-gray-400">
              <span><Trans i18nKey="settings:requestLog.totals.requests" count={logData.totals.requests || 0} values={{ value: fmt.int(logData.totals.requests) }} components={{ b }} /></span>
              <span><Trans i18nKey="settings:requestLog.totals.data" values={{ value: formatBytes(logData.totals.total_bytes) }} components={{ b }} /></span>
              <span><Trans i18nKey="settings:requestLog.totals.avgSize" values={{ value: formatBytes(Math.round(logData.totals.avg_bytes || 0)) }} components={{ b }} /></span>
              <span><Trans i18nKey="settings:requestLog.totals.avgLatency" values={{ value: formatMs(logData.totals.avg_duration_ms) }} components={{ b }} /></span>
            </div>
          )}

          {/* By path table */}
          <div className="overflow-x-auto mb-4">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-start text-gray-500 dark:text-gray-400 uppercase border-b border-gray-200 dark:border-gray-700">
                  <th className="pb-2 pe-3 text-start">{t('requestLog.columns.endpoint')}</th>
                  <th className="pb-2 pe-3 text-end">{t('requestLog.columns.requests')}</th>
                  <th className="pb-2 pe-3 text-end">{t('requestLog.columns.totalData')}</th>
                  <th className="pb-2 pe-3 text-end">{t('requestLog.columns.avgSize')}</th>
                  <th className="pb-2 text-end">{t('requestLog.columns.avgLatency')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {logData.byPath.map((row, i) => (
                  <tr key={i} className="text-gray-700 dark:text-gray-300">
                    <td className="py-1.5 pe-3 font-mono max-w-[250px]">
                      <div dir="ltr" className="truncate text-start rtl:text-right"><span className={`inline-block w-10 text-center rounded text-[10px] font-medium me-1 ${row.method === 'GET' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'}`}>{row.method}</span>
                      {row.path}</div>
                    </td>
                    <td className="py-1.5 pe-3 text-end">{fmt.int(row.requests)}</td>
                    <td className="py-1.5 pe-3 text-end font-medium whitespace-nowrap">{formatBytes(row.total_bytes)}</td>
                    <td className="py-1.5 pe-3 text-end whitespace-nowrap">{formatBytes(Math.round(row.avg_bytes || 0))}</td>
                    <td className="py-1.5 text-end whitespace-nowrap">{formatMs(row.avg_duration_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* By IP */}
          {logData.byIp?.length > 0 && (
            <div className="mb-4">
              <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">{t('requestLog.byIp')}</h4>
              <div className="flex flex-wrap gap-2">
                {logData.byIp.map((row, i) => (
                  <div key={i} className="px-2 py-1 bg-gray-50 dark:bg-gray-700 rounded text-xs text-gray-600 dark:text-gray-400">
                    <span className="font-mono" dir="ltr">{row.ip || t('common:status.unknown')}</span>
                    <span className="ms-2 font-medium text-gray-900 dark:text-white">{formatBytes(row.total_bytes)}</span>
                    <span className="ms-1">({t('requestLog.ipRequests', { count: row.requests || 0, value: fmt.int(row.requests) })})</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Toggle recent requests */}
          <button
            onClick={() => setShowRecent(!showRecent)}
            className="text-xs text-primary-600 dark:text-primary-400 hover:underline"
          >
            {showRecent
              ? t('requestLog.hideRecent', { n: logData.recent?.length || 0 })
              : t('requestLog.showRecent', { n: logData.recent?.length || 0 })}
          </button>

          {showRecent && logData.recent?.length > 0 && (
            <div className="mt-2 overflow-x-auto max-h-64 overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-white dark:bg-gray-800">
                  <tr className="text-start text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="pb-1 pe-2 text-start">{t('requestLog.columns.time')}</th>
                    <th className="pb-1 pe-2 text-start">{t('requestLog.columns.method')}</th>
                    <th className="pb-1 pe-2 text-start">{t('requestLog.columns.path')}</th>
                    <th className="pb-1 pe-2 text-end">{t('requestLog.columns.size')}</th>
                    <th className="pb-1 pe-2 text-end">ms</th>
                    <th className="pb-1 text-start">IP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-700/50">
                  {logData.recent.map((row, i) => (
                    <tr key={i} className="text-gray-600 dark:text-gray-400">
                      <td className="py-1 pe-2 whitespace-nowrap">{formatDateTime(row.created_at)}</td>
                      <td className="py-1 pe-2">{row.method}</td>
                      <td className="py-1 pe-2 font-mono max-w-[200px]"><div dir="ltr" className="truncate text-start rtl:text-right">{row.path}</div></td>
                      <td className="py-1 pe-2 text-end whitespace-nowrap">{formatBytes(row.response_bytes)}</td>
                      <td className="py-1 pe-2 text-end">{fmt.int(row.duration_ms)}</td>
                      <td className="py-1 font-mono"><bdi dir="ltr">{row.ip}</bdi></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// History tables that can be cleared. Label/description come from data.targets.<key>.* at render.
const DATA_TARGETS = [
  { key: 'alerts', countKey: 'alerts' },
  { key: 'automation-logs', countKey: 'automation_logs' },
  { key: 'equipment-errors', countKey: 'equipment_errors' },
  { key: 'readings', countKey: 'readings' },
  { key: 'lab-readings', countKey: 'lab_readings' },
  { key: 'relay-events', countKey: 'relay_events' },
  { key: 'watchdog-events', countKey: 'watchdog_events' },
  { key: 'sync-queue', countKey: 'sync_queue' },
  { key: 'watchdog-cooldowns', countKey: null },
  { key: 'request-log', countKey: 'request_log' },
  { key: 'network-usage', countKey: 'network_usage' },
];

function DataManagement() {
  const { t } = useTranslation('settings');
  const fmt = useFormat();
  const { token } = useAuth();
  const { formatDateTime } = useSettings();
  const [counts, setCounts] = useState(null);
  const [storage, setStorage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState({});
  const [message, setMessage] = useState(null);

  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  const formatBytes = (bytes) => formatBytesI18n(fmt, bytes);

  const fetchAll = () => {
    setLoading(true);
    Promise.all([
      fetch(`${API_BASE}/system/data-counts`, { headers }).then(r => r.json()),
      fetch(`${API_BASE}/settings/storage`, { headers }).then(r => r.json())
    ]).then(([countsData, storageData]) => {
      setCounts(countsData);
      setStorage(storageData);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  React.useEffect(() => { fetchAll(); }, []);

  const clearData = async (target, label) => {
    if (!confirm(t('data.confirmClear', { label }))) return;
    setClearing(prev => ({ ...prev, [target]: true }));
    setMessage(null);
    try {
      const res = await fetch(`${API_BASE}/system/clear/${target}`, { method: 'DELETE', headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || t('data.errors.clearFailed'));
      setMessage({ type: 'success', text: t('data.cleared', { count: Number(data.deleted) || 0, value: fmt.int(data.deleted), label }) });
      fetchAll();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setClearing(prev => ({ ...prev, [target]: false }));
    }
  };

  const dataTargets = DATA_TARGETS.map((d) => ({
    ...d,
    label: t(`data.targets.${d.key}.label`),
    description: t(`data.targets.${d.key}.description`),
  }));

  const appShare = storage?.disk?.total ? (storage.disk.usedByApp / storage.disk.total) * 100 : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{t('data.title')}</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('data.subtitle')}</p>
        </div>
        <button onClick={fetchAll} disabled={loading}
          title={t('common:actions.refresh')} aria-label={t('common:actions.refresh')}
          className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 disabled:opacity-50">
          <svg className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
        </button>
      </div>

      {message && (
        <div className={`p-3 rounded-lg text-sm ${message.type === 'success' ? 'bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-400'}`}>
          {message.text}
        </div>
      )}

      {/* Storage Overview */}
      {storage && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">{t('data.sdCard')}</h3>
          {/* Disk usage bar */}
          <div className="mb-4">
            <div className="flex flex-wrap justify-between gap-x-2 text-xs text-gray-500 dark:text-gray-400 mb-1">
              <span>{t('data.usedOf', { used: formatBytes(storage.disk?.used), total: formatBytes(storage.disk?.total) })}</span>
              <span>{t('data.free', { value: formatBytes(storage.disk?.available) })}</span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-4 overflow-hidden">
              <div className={`h-full rounded-full transition-all ${
                storage.disk?.percentUsed > 90 ? 'bg-red-500' :
                storage.disk?.percentUsed > 70 ? 'bg-amber-500' : 'bg-green-500'
              }`} style={{ width: `${storage.disk?.percentUsed || 0}%` }}>
                <span className="text-[10px] font-bold text-white ps-2 leading-4 whitespace-nowrap">{fmt.percent(storage.disk?.percentUsed)}</span>
              </div>
            </div>
          </div>
          {/* Breakdown cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('data.database')}</p>
              <p className="text-lg font-bold text-gray-900 dark:text-white">{formatBytes(storage.database?.size)}</p>
              <p className="text-[10px] text-gray-400"><bdi dir="ltr">sensehub.db</bdi></p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('data.dataDirectory')}</p>
              <p className="text-lg font-bold text-gray-900 dark:text-white">{formatBytes(storage.dataDirectory?.size)}</p>
              <p className="text-[10px] text-gray-400">{t('data.walBackups')}</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('data.logs')}</p>
              <p className="text-lg font-bold text-gray-900 dark:text-white">{formatBytes(storage.logsDirectory?.size)}</p>
              <p className="text-[10px] text-gray-400">{t('data.logFiles')}</p>
            </div>
            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('data.appTotal')}</p>
              <p className="text-lg font-bold text-gray-900 dark:text-white">{formatBytes(storage.disk?.usedByApp)}</p>
              <p className="text-[10px] text-gray-400">{t('data.ofSdCard', { value: fmt.percent(appShare, { decimals: 1 }) })}</p>
            </div>
          </div>
          {/* Biggest tables */}
          {counts && (
            <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">{t('data.biggestTables')}</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(counts)
                  .sort(([,a], [,b]) => b - a)
                  .filter(([,count]) => count > 0)
                  .slice(0, 6)
                  .map(([table, count]) => (
                    <span key={table} className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-xs text-gray-600 dark:text-gray-400">
                      <span className="font-medium text-gray-900 dark:text-white">{fmt.int(count)}</span>
                      <span dir="ltr" lang="en">{table.replace(/_/g, ' ')}</span>
                    </span>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {loading && !storage ? (
        <div className="text-center py-8 text-gray-500 dark:text-gray-400">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto mb-2"></div>
          {t('data.loading')}
        </div>
      ) : (
        <div className="space-y-3">
          {dataTargets.map(({ key, label, countKey, description }) => (
            <div key={key} className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{label}</h3>
                  {countKey && counts && (
                    <span className="px-2 py-0.5 text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-full">
                      {t('data.records', { count: counts[countKey] || 0, value: fmt.int(counts[countKey] || 0) })}
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>
              </div>
              <button
                onClick={() => clearData(key, label)}
                disabled={clearing[key] || (countKey && counts && counts[countKey] === 0)}
                className="px-4 py-2 text-sm font-medium text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
              >
                {clearing[key] ? t('data.clearing') : t('data.clearButton', { label })}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
        <p className="text-sm text-amber-800 dark:text-amber-400">
          <Trans i18nKey="settings:data.warning" components={{ b: <strong /> }} />
        </p>
      </div>
    </div>
  );
}

export default function Settings() {
  const { user } = useAuth();
  const { t } = useTranslation('settings');
  const isAdmin = user?.role === 'admin';

  // Filter tabs based on user role
  const visibleTabs = settingsTabs.filter(tab => !tab.adminOnly || isAdmin);

  // Non-admin users can only access Profile settings
  if (!isAdmin) {
    return (
      <div className="max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">{t('title')}</h1>

        <div className="flex flex-col md:flex-row gap-6">
          {/* Sidebar navigation */}
          <nav className="w-full md:w-48 flex-shrink-0">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
              {visibleTabs.map((tab) => (
                <NavLink
                  key={tab.path}
                  to={`/settings/${tab.path}`}
                  className={({ isActive }) =>
                    `flex items-center px-4 py-3 text-sm font-medium border-s-4 transition-colors ${
                      isActive
                        ? 'bg-primary-50 dark:bg-primary-900/20 border-primary-600 text-primary-700 dark:text-primary-400'
                        : 'border-transparent text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-white'
                    }`
                  }
                >
                  <span className="me-3 text-gray-400">{tab.icon}</span>
                  {t(`tabs.${tab.path}`, { defaultValue: tab.name })}
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
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">{t('title')}</h1>

      <div className="flex flex-col md:flex-row gap-6">
        {/* Sidebar navigation */}
        <nav className="w-full md:w-48 flex-shrink-0">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
            {visibleTabs.map((tab) => (
              <NavLink
                key={tab.path}
                to={`/settings/${tab.path}`}
                className={({ isActive }) =>
                  `flex items-center px-4 py-3 text-sm font-medium border-s-4 transition-colors ${
                    isActive
                      ? 'bg-primary-50 dark:bg-primary-900/20 border-primary-600 text-primary-700 dark:text-primary-400'
                      : 'border-transparent text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-white'
                  }`
                }
              >
                <span className="me-3 text-gray-400">{tab.icon}</span>
                {t(`tabs.${tab.path}`, { defaultValue: tab.name })}
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
            <Route path="notifications" element={<NotificationSettings />} />
            <Route path="backup" element={<BackupSettings />} />
            <Route path="watchdog" element={<WatchdogHistory />} />
            <Route path="network" element={<NetworkUsage />} />
            <Route path="data" element={<DataManagement />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
