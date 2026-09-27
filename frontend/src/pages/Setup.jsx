import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { useFormat } from '../i18n/useFormat';

const API_BASE = '/api';

// Timezone choices: IANA ids are data (shown as-is); `hint` is a translated
// region word from setup.json timezone.hint.*.
const TIMEZONE_GROUPS = [
  { id: 'americas', options: [
    { value: 'America/New_York', hint: 'eastern' },
    { value: 'America/Chicago', hint: 'central' },
    { value: 'America/Denver', hint: 'mountain' },
    { value: 'America/Los_Angeles', hint: 'pacific' },
    { value: 'America/Anchorage', hint: 'alaska' },
    { value: 'Pacific/Honolulu', hint: 'hawaii' },
    { value: 'America/Toronto' },
    { value: 'America/Vancouver' },
    { value: 'America/Mexico_City' },
    { value: 'America/Sao_Paulo' },
    { value: 'America/Buenos_Aires' },
  ]},
  { id: 'europe', options: [
    { value: 'Europe/London' },
    { value: 'Europe/Paris' },
    { value: 'Europe/Berlin' },
    { value: 'Europe/Madrid' },
    { value: 'Europe/Rome' },
    { value: 'Europe/Amsterdam' },
    { value: 'Europe/Brussels' },
    { value: 'Europe/Zurich' },
    { value: 'Europe/Moscow' },
    { value: 'Europe/Istanbul' },
  ]},
  { id: 'asia', options: [
    { value: 'Asia/Dubai' },
    { value: 'Asia/Kolkata', hint: 'india' },
    { value: 'Asia/Singapore' },
    { value: 'Asia/Hong_Kong' },
    { value: 'Asia/Shanghai', hint: 'china' },
    { value: 'Asia/Tokyo' },
    { value: 'Asia/Seoul' },
    { value: 'Asia/Bangkok' },
    { value: 'Asia/Jakarta' },
  ]},
  { id: 'pacificOceania', options: [
    { value: 'Australia/Sydney' },
    { value: 'Australia/Melbourne' },
    { value: 'Australia/Perth' },
    { value: 'Pacific/Auckland', hint: 'newZealand' },
  ]},
  { id: 'africaMiddleEast', options: [
    { value: 'Africa/Johannesburg' },
    { value: 'Africa/Cairo' },
    { value: 'Africa/Lagos' },
    { value: 'Asia/Jerusalem' },
  ]},
  { id: 'other', options: [
    { value: 'UTC', hint: 'utc' },
  ]},
];

const STEP_KEYS = ['welcome', 'network', 'timezone', 'admin', 'cloud', 'complete'];

function Setup() {
  const { t } = useTranslation('setup');
  const fmt = useFormat();
  const navigate = useNavigate();
  const { setUserAfterSetup } = useAuth();
  const [step, setStep] = useState(1);
  const [showSkipWarning, setShowSkipWarning] = useState(false);
  const [skipLoading, setSkipLoading] = useState(false);
  const [formData, setFormData] = useState({
    // Network config
    dhcp: true,
    ipAddress: '',
    gateway: '',
    dns: '',
    // Timezone config
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    // Admin account
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    // Cloud connection
    cloudUrl: '',
    cloudApiKey: '',
    cloudEnabled: false
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Load existing network and timezone config if any
  useEffect(() => {
    const loadConfigs = async () => {
      try {
        // Load network config
        const networkResponse = await fetch(`${API_BASE}/auth/setup/network`);
        if (networkResponse.ok) {
          const networkData = await networkResponse.json();
          setFormData(prev => ({
            ...prev,
            dhcp: networkData.dhcp !== false,
            ipAddress: networkData.ipAddress || '',
            gateway: networkData.gateway || '',
            dns: networkData.dns || ''
          }));
        }

        // Load timezone config
        const timezoneResponse = await fetch(`${API_BASE}/auth/setup/timezone`);
        if (timezoneResponse.ok) {
          const timezoneData = await timezoneResponse.json();
          if (timezoneData.timezone) {
            setFormData(prev => ({
              ...prev,
              timezone: timezoneData.timezone
            }));
          }
        }
      } catch (err) {
        console.error('Failed to load config:', err);
      }
    };
    loadConfigs();
  }, []);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData({
      ...formData,
      [name]: type === 'checkbox' ? checked : value
    });
    setError('');
  };

  const validateNetworkConfig = () => {
    if (formData.dhcp) return true;

    const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

    if (formData.ipAddress && !ipRegex.test(formData.ipAddress)) {
      setError(t('errors.invalidIp'));
      return false;
    }

    if (formData.gateway && !ipRegex.test(formData.gateway)) {
      setError(t('errors.invalidGateway'));
      return false;
    }

    if (formData.dns && !ipRegex.test(formData.dns)) {
      setError(t('errors.invalidDns'));
      return false;
    }

    return true;
  };

  const saveNetworkConfig = async () => {
    if (!validateNetworkConfig()) return false;

    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE}/auth/setup/network`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          dhcp: formData.dhcp,
          ipAddress: formData.ipAddress,
          gateway: formData.gateway,
          dns: formData.dns
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || t('errors.networkSaveFailed'));
      }

      return true;
    } catch (err) {
      setError(err.message || t('errors.networkSaveError'));
      return false;
    } finally {
      setLoading(false);
    }
  };

  const handleNetworkNext = async () => {
    const saved = await saveNetworkConfig();
    if (saved) {
      setStep(3); // Go to timezone step
    }
  };

  const saveTimezoneConfig = async () => {
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE}/auth/setup/timezone`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          timezone: formData.timezone
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || t('errors.timezoneSaveFailed'));
      }

      return true;
    } catch (err) {
      setError(err.message || t('errors.timezoneSaveError'));
      return false;
    } finally {
      setLoading(false);
    }
  };

  const handleTimezoneNext = async () => {
    const saved = await saveTimezoneConfig();
    if (saved) {
      setStep(4); // Go to admin account step
    }
  };

  const validateAdminAccount = () => {
    const { name, email, password, confirmPassword } = formData;

    if (!name.trim()) {
      setError(t('errors.nameRequired'));
      return false;
    }

    if (!email.trim()) {
      setError(t('errors.emailRequired'));
      return false;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setError(t('errors.invalidEmail'));
      return false;
    }

    if (!password) {
      setError(t('errors.passwordRequired'));
      return false;
    }

    if (password.length < 8) {
      setError(t('errors.passwordTooShort'));
      return false;
    }

    if (password !== confirmPassword) {
      setError(t('errors.passwordMismatch'));
      return false;
    }

    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!validateAdminAccount()) return;

    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE}/auth/setup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: formData.name,
          email: formData.email,
          password: formData.password
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || t('errors.setupFailed'));
      }

      // Store token and update auth context
      localStorage.setItem('token', data.token);
      setUserAfterSetup(data.token, data.user);

      // Move to Cloud connection step
      setStep(5);
    } catch (err) {
      setError(err.message || t('errors.setupError'));
    } finally {
      setLoading(false);
    }
  };

  const handleCloudSkip = () => {
    // Skip cloud configuration and go to complete step
    setStep(6);
  };

  const handleCloudConnect = async () => {
    setLoading(true);
    setError('');

    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_BASE}/cloud/connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          url: formData.cloudUrl,
          apiKey: formData.cloudApiKey
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || t('errors.cloudConnectFailed'));
      }

      // Move to completion step
      setStep(6);
    } catch (err) {
      setError(err.message || t('errors.cloudConnectError'));
    } finally {
      setLoading(false);
    }
  };

  const goToDashboard = () => {
    navigate('/');
  };

  const handleSkipSetup = () => {
    setShowSkipWarning(true);
  };

  const cancelSkip = () => {
    setShowSkipWarning(false);
  };

  const confirmSkipSetup = async () => {
    setSkipLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE}/auth/setup/quick`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || t('errors.quickSetupFailed'));
      }

      // Store token and update auth context
      localStorage.setItem('token', data.token);
      setUserAfterSetup(data.token, data.user);

      // Navigate directly to dashboard
      navigate('/');
    } catch (err) {
      setError(err.message || t('errors.quickSetupError'));
      setShowSkipWarning(false);
    } finally {
      setSkipLoading(false);
    }
  };

  const stepLabels = STEP_KEYS.map((k) => t(`steps.${k}`));

  const localTimePreview = () => {
    try {
      return fmt.dateTime(Date.now(), {
        timeZone: formData.timezone,
        weekday: 'short',
        timeZoneName: 'short',
      });
    } catch {
      return '—';
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-600 to-primary-800 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full overflow-hidden">
        {/* Progress indicator */}
        <div className="bg-gray-100 px-4 sm:px-8 py-4">
          <div className="flex items-center">
            {[1, 2, 3, 4, 5, 6].map((num) => (
              <div key={num} className={`flex items-center ${num < 6 ? 'flex-1' : ''}`}>
                <div
                  className={`shrink-0 w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center font-semibold text-sm ${
                    step >= num
                      ? 'bg-primary-600 text-white'
                      : 'bg-gray-300 text-gray-600'
                  }`}
                >
                  {num}
                </div>
                {num < 6 && (
                  <div
                    className={`flex-1 min-w-2 h-1 mx-0.5 sm:mx-1 ${
                      step > num ? 'bg-primary-600' : 'bg-gray-300'
                    }`}
                  />
                )}
              </div>
            ))}
          </div>
          <p className="sm:hidden mt-2 text-xs text-center font-semibold text-primary-600">
            {t('stepOf', { step, total: 6, label: stepLabels[step - 1] })}
          </p>
          <div className="hidden sm:grid grid-cols-6 gap-1 mt-2 text-sm leading-tight text-gray-600">
            {stepLabels.map((label, index) => (
              <span key={STEP_KEYS[index]} className={`break-words ${index === 0 ? 'text-start' : index === 5 ? 'text-end' : 'text-center'} ${step === index + 1 ? 'font-semibold text-primary-600' : ''}`}>
                {label}
              </span>
            ))}
          </div>
        </div>

        <div className="p-8">
          {/* Step 1: Welcome */}
          {step === 1 && (
            <div className="text-center">
              <div className="mb-6">
                <div className="w-24 h-24 bg-primary-100 rounded-full mx-auto flex items-center justify-center">
                  <svg className="w-12 h-12 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                  </svg>
                </div>
              </div>
              <h1 className="text-3xl font-bold text-gray-900 mb-4">
                {t('welcome.title')}
              </h1>
              <p className="text-gray-600 mb-8 max-w-md mx-auto">
                {t('welcome.intro')}
              </p>

              <div className="bg-gray-50 rounded-xl p-6 mb-8 text-start">
                <h3 className="font-semibold text-gray-900 mb-4">{t('welcome.overviewTitle')}</h3>
                <ul className="space-y-3">
                  <li className="flex items-start">
                    <svg className="w-5 h-5 text-green-500 me-3 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span className="text-gray-600">{t('welcome.featureProtocols')}</span>
                  </li>
                  <li className="flex items-start">
                    <svg className="w-5 h-5 text-green-500 me-3 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span className="text-gray-600">{t('welcome.featureAutomation')}</span>
                  </li>
                  <li className="flex items-start">
                    <svg className="w-5 h-5 text-green-500 me-3 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span className="text-gray-600">{t('welcome.featureOffline')}</span>
                  </li>
                  <li className="flex items-start">
                    <svg className="w-5 h-5 text-green-500 me-3 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span className="text-gray-600">{t('welcome.featureMonitoring')}</span>
                  </li>
                </ul>
              </div>

              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <button
                  onClick={() => setStep(2)}
                  className="px-8 py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 transition-colors"
                >
                  {t('welcome.getStarted')}
                </button>
                <button
                  onClick={handleSkipSetup}
                  className="px-8 py-3 border border-gray-300 text-gray-700 rounded-lg font-semibold hover:bg-gray-50 transition-colors"
                >
                  {t('welcome.skipSetup')}
                </button>
              </div>
            </div>
          )}

          {/* Skip Setup Warning Modal */}
          {showSkipWarning && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
              <div className="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 p-6">
                <div className="flex items-center mb-4">
                  <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center me-4 shrink-0">
                    <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  </div>
                  <h3 className="text-xl font-bold text-gray-900">{t('skip.title')}</h3>
                </div>

                <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-6">
                  <p className="text-amber-800 text-sm font-medium mb-2">
                    ⚠️ {t('skip.warningTitle')}
                  </p>
                  <p className="text-amber-700 text-sm">
                    {t('skip.warningBody')}
                  </p>
                  <ul className="text-amber-700 text-sm mt-2 list-disc list-inside space-y-1">
                    <li>{t('skip.todoPassword')}</li>
                    <li>{t('skip.todoNetwork')}</li>
                    <li>{t('skip.todoTimezone')}</li>
                  </ul>
                </div>

                <div className="bg-gray-50 rounded-lg px-4 py-3 mb-6">
                  <p className="text-gray-600 text-sm font-medium mb-2">{t('skip.defaultAccount')}</p>
                  <div className="text-sm text-gray-800 space-y-1">
                    <p><span className="font-medium">{t('skip.email')}</span> <span dir="ltr">admin@sensehub.local</span></p>
                    <p className="text-gray-600">
                      <Trans t={t} i18nKey="skip.tempPassword" components={{ b: <span className="font-medium" /> }} />
                    </p>
                  </div>
                </div>

                {error && (
                  <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-4 text-red-700 text-sm">
                    {error}
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={cancelSkip}
                    disabled={skipLoading}
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
                  >
                    {t('common:actions.cancel')}
                  </button>
                  <button
                    onClick={confirmSkipSetup}
                    disabled={skipLoading}
                    className="flex-1 px-4 py-2 bg-amber-600 text-white rounded-lg font-semibold hover:bg-amber-700 transition-colors disabled:opacity-50 flex items-center justify-center"
                  >
                    {skipLoading && (
                      <svg className="animate-spin -ms-1 me-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    )}
                    {skipLoading ? t('skip.settingUp') : t('skip.confirm')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Network Configuration */}
          {step === 2 && (
            <div>
              <div className="flex items-center mb-2">
                <svg className="w-8 h-8 text-primary-600 me-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                </svg>
                <h2 className="text-2xl font-bold text-gray-900">
                  {t('network.title')}
                </h2>
              </div>
              <p className="text-gray-600 mb-6">
                {t('network.subtitle')}
              </p>

              <div className="space-y-4">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="dhcp"
                    name="dhcp"
                    checked={formData.dhcp}
                    onChange={handleChange}
                    className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                  />
                  <label htmlFor="dhcp" className="ms-2 block text-sm text-gray-900">
                    {t('network.useDhcp')}
                  </label>
                </div>

                <div className={`space-y-4 ${formData.dhcp ? 'opacity-50' : ''}`}>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t('network.ipAddress')}
                    </label>
                    <input
                      type="text"
                      name="ipAddress"
                      value={formData.ipAddress}
                      onChange={handleChange}
                      disabled={formData.dhcp}
                      className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white text-gray-900 dark:bg-gray-700 dark:text-white disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:cursor-not-allowed"
                      placeholder="192.168.1.100"
                      dir="ltr"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t('network.gateway')}
                    </label>
                    <input
                      type="text"
                      name="gateway"
                      value={formData.gateway}
                      onChange={handleChange}
                      disabled={formData.dhcp}
                      className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white text-gray-900 dark:bg-gray-700 dark:text-white disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:cursor-not-allowed"
                      placeholder="192.168.1.1"
                      dir="ltr"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t('network.dnsServer')}
                    </label>
                    <input
                      type="text"
                      name="dns"
                      value={formData.dns}
                      onChange={handleChange}
                      disabled={formData.dhcp}
                      className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white text-gray-900 dark:bg-gray-700 dark:text-white disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:cursor-not-allowed"
                      placeholder="8.8.8.8"
                      dir="ltr"
                    />
                  </div>
                </div>

                {error && (
                  <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-red-700 text-sm">
                    {error}
                  </div>
                )}

                <div className="flex justify-between pt-4">
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="px-6 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    {t('common:actions.back')}
                  </button>
                  <button
                    type="button"
                    onClick={handleNetworkNext}
                    disabled={loading}
                    className="px-6 py-2 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                  >
                    {loading && (
                      <svg className="animate-spin -ms-1 me-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    )}
                    {loading ? t('common:actions.saving') : t('actions.continue')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Timezone Configuration */}
          {step === 3 && (
            <div>
              <div className="flex items-center mb-2">
                <svg className="w-8 h-8 text-primary-600 me-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <h2 className="text-2xl font-bold text-gray-900">
                  {t('timezone.title')}
                </h2>
              </div>
              <p className="text-gray-600 mb-6">
                {t('timezone.subtitle')}
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('timezone.label')}
                  </label>
                  <select
                    name="timezone"
                    dir="ltr"
                    value={formData.timezone}
                    onChange={handleChange}
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white text-gray-900 dark:bg-gray-700 dark:text-white"
                  >
                    {TIMEZONE_GROUPS.map((group) => (
                      <optgroup key={group.id} label={t(`timezone.group.${group.id}`)}>
                        {group.options.map((tz) => (
                          <option key={tz.value} value={tz.value}>
                            {tz.hint ? `${tz.value} (${t(`timezone.hint.${tz.hint}`)})` : tz.value}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
                  <div className="flex items-start">
                    <svg className="w-5 h-5 text-blue-500 me-2 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                    </svg>
                    <div className="text-sm text-blue-700">
                      <p className="font-medium">{t('timezone.currentSelection')} <span dir="ltr">{formData.timezone}</span></p>
                      <p className="mt-1">
                        {t('timezone.localTime', { time: localTimePreview() })}
                      </p>
                    </div>
                  </div>
                </div>

                {error && (
                  <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-red-700 text-sm">
                    {error}
                  </div>
                )}

                <div className="flex justify-between pt-4">
                  <button
                    type="button"
                    onClick={() => setStep(2)}
                    className="px-6 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    {t('common:actions.back')}
                  </button>
                  <button
                    type="button"
                    onClick={handleTimezoneNext}
                    disabled={loading}
                    className="px-6 py-2 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                  >
                    {loading && (
                      <svg className="animate-spin -ms-1 me-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    )}
                    {loading ? t('common:actions.saving') : t('actions.continue')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Step 4: Create Admin Account */}
          {step === 4 && (
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-2">
                {t('admin.title')}
              </h2>
              <p className="text-gray-600 mb-6">
                {t('admin.subtitle')}
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('admin.fullName')}
                  </label>
                  <input
                    type="text"
                    name="name"
                    value={formData.name}
                    onChange={handleChange}
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white text-gray-900 dark:bg-gray-700 dark:text-white"
                    placeholder={t('admin.namePlaceholder')}
                    autoComplete="name"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('admin.email')}
                  </label>
                  <input
                    type="email"
                    name="email"
                    value={formData.email}
                    onChange={handleChange}
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white text-gray-900 dark:bg-gray-700 dark:text-white"
                    placeholder="admin@example.com"
                    dir="ltr"
                    autoComplete="email"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('admin.password')}
                  </label>
                  <input
                    type="password"
                    name="password"
                    value={formData.password}
                    onChange={handleChange}
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white text-gray-900 dark:bg-gray-700 dark:text-white"
                    placeholder={t('admin.passwordPlaceholder')}
                    autoComplete="new-password"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('admin.confirmPassword')}
                  </label>
                  <input
                    type="password"
                    name="confirmPassword"
                    value={formData.confirmPassword}
                    onChange={handleChange}
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white text-gray-900 dark:bg-gray-700 dark:text-white"
                    placeholder={t('admin.confirmPlaceholder')}
                    autoComplete="new-password"
                  />
                </div>

                {error && (
                  <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-red-700 text-sm">
                    {error}
                  </div>
                )}

                <div className="flex justify-between pt-4">
                  <button
                    type="button"
                    onClick={() => setStep(3)}
                    className="px-6 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    {t('common:actions.back')}
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="px-6 py-2 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                  >
                    {loading && (
                      <svg className="animate-spin -ms-1 me-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    )}
                    {loading ? t('admin.creating') : t('admin.create')}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Step 5: Cloud Connection (Optional) */}
          {step === 5 && (
            <div>
              <div className="flex items-center mb-2">
                <svg className="w-8 h-8 text-primary-600 me-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
                </svg>
                <h2 className="text-2xl font-bold text-gray-900">
                  {t('cloud.title')}
                </h2>
              </div>
              <p className="text-gray-600 mb-6">
                {t('cloud.subtitle')}
                <span className="block mt-1 text-sm text-gray-500">{t('cloud.optionalNote')}</span>
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('cloud.url')}
                  </label>
                  <input
                    type="url"
                    name="cloudUrl"
                    value={formData.cloudUrl}
                    onChange={handleChange}
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white text-gray-900 dark:bg-gray-700 dark:text-white"
                    placeholder="https://cloud.sensehub.io"
                    dir="ltr"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t('cloud.apiKey')}
                  </label>
                  <input
                    type="password"
                    name="cloudApiKey"
                    value={formData.cloudApiKey}
                    onChange={handleChange}
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white text-gray-900 dark:bg-gray-700 dark:text-white"
                    placeholder={t('cloud.apiKeyPlaceholder')}
                  />
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
                  <div className="flex items-start">
                    <svg className="w-5 h-5 text-blue-500 me-2 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                    </svg>
                    <div className="text-sm text-blue-700">
                      <p className="font-medium">{t('cloud.offlineTitle')}</p>
                      <p className="mt-1">{t('cloud.offlineBody')}</p>
                    </div>
                  </div>
                </div>

                {error && (
                  <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-red-700 text-sm">
                    {error}
                  </div>
                )}

                <div className="flex justify-between pt-4">
                  <button
                    type="button"
                    onClick={handleCloudSkip}
                    className="px-6 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    {t('cloud.skip')}
                  </button>
                  <button
                    type="button"
                    onClick={handleCloudConnect}
                    disabled={loading || (!formData.cloudUrl || !formData.cloudApiKey)}
                    className="px-6 py-2 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                  >
                    {loading && (
                      <svg className="animate-spin -ms-1 me-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    )}
                    {loading ? t('cloud.connecting') : t('cloud.connect')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Step 6: Complete */}
          {step === 6 && (
            <div className="text-center">
              <div className="mb-6">
                <div className="w-24 h-24 bg-green-100 rounded-full mx-auto flex items-center justify-center">
                  <svg className="w-12 h-12 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              </div>
              <h2 className="text-3xl font-bold text-gray-900 mb-4">
                {t('complete.title')}
              </h2>
              <p className="text-gray-600 mb-6 max-w-md mx-auto">
                {t('complete.body')}
              </p>

              {/* Configuration Summary */}
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 mb-6 text-start">
                <h3 className="font-semibold text-gray-900 mb-4 flex items-center">
                  <svg className="w-5 h-5 text-blue-600 me-2 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {t('complete.summaryTitle')}
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500">{t('complete.network')}</span>
                    <span className="ms-2 text-gray-900 font-medium">
                      {formData.dhcp ? t('complete.dhcpAutomatic') : formData.ipAddress || t('complete.staticIp')}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">{t('complete.timezone')}</span>
                    <span className="ms-2 text-gray-900 font-medium" dir="ltr">{formData.timezone}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">{t('complete.admin')}</span>
                    <span className="ms-2 text-gray-900 font-medium" dir="auto">{formData.name}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">{t('complete.email')}</span>
                    <span className="ms-2 text-gray-900 font-medium" dir="ltr">{formData.email}</span>
                  </div>
                  <div className="sm:col-span-2">
                    <span className="text-gray-500">{t('complete.cloud')}</span>
                    <span className="ms-2 text-gray-900 font-medium">
                      {formData.cloudUrl ? t('complete.cloudConnected') : t('complete.cloudNotConfigured')}
                    </span>
                  </div>
                </div>
              </div>

              <div className="bg-gray-50 rounded-xl p-6 mb-8 text-start">
                <h3 className="font-semibold text-gray-900 mb-4">{t('complete.nextStepsTitle')}</h3>
                <ul className="space-y-3">
                  <li className="flex items-start">
                    <span className="w-6 h-6 bg-primary-100 text-primary-600 rounded-full flex items-center justify-center text-sm font-semibold me-3 mt-0.5 shrink-0">1</span>
                    <span className="text-gray-600">{t('complete.nextScan')}</span>
                  </li>
                  <li className="flex items-start">
                    <span className="w-6 h-6 bg-primary-100 text-primary-600 rounded-full flex items-center justify-center text-sm font-semibold me-3 mt-0.5 shrink-0">2</span>
                    <span className="text-gray-600">{t('complete.nextZones')}</span>
                  </li>
                  <li className="flex items-start">
                    <span className="w-6 h-6 bg-primary-100 text-primary-600 rounded-full flex items-center justify-center text-sm font-semibold me-3 mt-0.5 shrink-0">3</span>
                    <span className="text-gray-600">{t('complete.nextAutomations')}</span>
                  </li>
                  <li className="flex items-start">
                    <span className="w-6 h-6 bg-primary-100 text-primary-600 rounded-full flex items-center justify-center text-sm font-semibold me-3 mt-0.5 shrink-0">4</span>
                    <span className="text-gray-600">{t('complete.nextCloud')}</span>
                  </li>
                </ul>
              </div>

              <button
                onClick={goToDashboard}
                className="px-8 py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 transition-colors"
              >
                {t('complete.goToDashboard')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default Setup;
