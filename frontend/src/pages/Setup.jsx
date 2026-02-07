import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const API_BASE = 'http://localhost:3001/api';

function Setup() {
  const navigate = useNavigate();
  const { setUserAfterSetup } = useAuth();
  const [step, setStep] = useState(1);
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
      setError('Please enter a valid IP address');
      return false;
    }

    if (formData.gateway && !ipRegex.test(formData.gateway)) {
      setError('Please enter a valid gateway address');
      return false;
    }

    if (formData.dns && !ipRegex.test(formData.dns)) {
      setError('Please enter a valid DNS address');
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
        throw new Error(data.message || 'Failed to save network configuration');
      }

      return true;
    } catch (err) {
      setError(err.message || 'An error occurred saving network configuration');
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
        throw new Error(data.message || 'Failed to save timezone configuration');
      }

      return true;
    } catch (err) {
      setError(err.message || 'An error occurred saving timezone configuration');
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
      setError('Name is required');
      return false;
    }

    if (!email.trim()) {
      setError('Email is required');
      return false;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setError('Please enter a valid email address');
      return false;
    }

    if (!password) {
      setError('Password is required');
      return false;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return false;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
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
        throw new Error(data.message || 'Setup failed');
      }

      // Store token and update auth context
      localStorage.setItem('token', data.token);
      setUserAfterSetup(data.token, data.user);

      // Move to Cloud connection step
      setStep(5);
    } catch (err) {
      setError(err.message || 'An error occurred during setup');
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
        throw new Error(data.message || 'Failed to connect to cloud');
      }

      // Move to completion step
      setStep(6);
    } catch (err) {
      setError(err.message || 'An error occurred connecting to cloud');
    } finally {
      setLoading(false);
    }
  };

  const goToDashboard = () => {
    navigate('/');
  };

  const stepLabels = ['Welcome', 'Network', 'Timezone', 'Admin Account', 'Cloud', 'Complete'];

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-600 to-primary-800 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full overflow-hidden">
        {/* Progress indicator */}
        <div className="bg-gray-100 px-8 py-4">
          <div className="flex items-center justify-between">
            {[1, 2, 3, 4, 5, 6].map((num) => (
              <div key={num} className="flex items-center">
                <div
                  className={`w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center font-semibold text-sm ${
                    step >= num
                      ? 'bg-primary-600 text-white'
                      : 'bg-gray-300 text-gray-600'
                  }`}
                >
                  {num}
                </div>
                {num < 6 && (
                  <div
                    className={`w-8 sm:w-12 md:w-16 h-1 mx-0.5 sm:mx-1 ${
                      step > num ? 'bg-primary-600' : 'bg-gray-300'
                    }`}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-2 text-xs sm:text-sm text-gray-600">
            {stepLabels.map((label, index) => (
              <span key={label} className={step === index + 1 ? 'font-semibold text-primary-600' : ''}>
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
                Welcome to SenseHub
              </h1>
              <p className="text-gray-600 mb-8 max-w-md mx-auto">
                Your edge computing platform for industrial IoT operations.
                Manage sensors, relays, controllers, and automate your operations
                with SenseHub's powerful local processing capabilities.
              </p>

              <div className="bg-gray-50 rounded-xl p-6 mb-8 text-left">
                <h3 className="font-semibold text-gray-900 mb-4">System Overview</h3>
                <ul className="space-y-3">
                  <li className="flex items-start">
                    <svg className="w-5 h-5 text-green-500 mr-3 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span className="text-gray-600">Multi-protocol support (Modbus, MQTT, Zigbee, Z-Wave)</span>
                  </li>
                  <li className="flex items-start">
                    <svg className="w-5 h-5 text-green-500 mr-3 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span className="text-gray-600">Visual automation builder with triggers and conditions</span>
                  </li>
                  <li className="flex items-start">
                    <svg className="w-5 h-5 text-green-500 mr-3 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span className="text-gray-600">Offline-first operation with cloud sync when connected</span>
                  </li>
                  <li className="flex items-start">
                    <svg className="w-5 h-5 text-green-500 mr-3 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span className="text-gray-600">Real-time monitoring and alerts</span>
                  </li>
                </ul>
              </div>

              <button
                onClick={() => setStep(2)}
                className="px-8 py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 transition-colors"
              >
                Get Started
              </button>
            </div>
          )}

          {/* Step 2: Network Configuration */}
          {step === 2 && (
            <div>
              <div className="flex items-center mb-2">
                <svg className="w-8 h-8 text-primary-600 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                </svg>
                <h2 className="text-2xl font-bold text-gray-900">
                  Network Configuration
                </h2>
              </div>
              <p className="text-gray-600 mb-6">
                Configure network settings for your SenseHub device.
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
                  <label htmlFor="dhcp" className="ml-2 block text-sm text-gray-900">
                    Use DHCP (automatic IP configuration)
                  </label>
                </div>

                <div className={`space-y-4 ${formData.dhcp ? 'opacity-50' : ''}`}>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      IP Address
                    </label>
                    <input
                      type="text"
                      name="ipAddress"
                      value={formData.ipAddress}
                      onChange={handleChange}
                      disabled={formData.dhcp}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                      placeholder="192.168.1.100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Gateway
                    </label>
                    <input
                      type="text"
                      name="gateway"
                      value={formData.gateway}
                      onChange={handleChange}
                      disabled={formData.dhcp}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                      placeholder="192.168.1.1"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      DNS Server
                    </label>
                    <input
                      type="text"
                      name="dns"
                      value={formData.dns}
                      onChange={handleChange}
                      disabled={formData.dhcp}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                      placeholder="8.8.8.8"
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
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={handleNetworkNext}
                    disabled={loading}
                    className="px-6 py-2 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                  >
                    {loading && (
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    )}
                    {loading ? 'Saving...' : 'Continue'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Timezone Configuration */}
          {step === 3 && (
            <div>
              <div className="flex items-center mb-2">
                <svg className="w-8 h-8 text-primary-600 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <h2 className="text-2xl font-bold text-gray-900">
                  Timezone Configuration
                </h2>
              </div>
              <p className="text-gray-600 mb-6">
                Select your timezone for accurate time display and scheduling.
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Timezone
                  </label>
                  <select
                    name="timezone"
                    value={formData.timezone}
                    onChange={handleChange}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white"
                  >
                    <optgroup label="Americas">
                      <option value="America/New_York">America/New_York (Eastern)</option>
                      <option value="America/Chicago">America/Chicago (Central)</option>
                      <option value="America/Denver">America/Denver (Mountain)</option>
                      <option value="America/Los_Angeles">America/Los_Angeles (Pacific)</option>
                      <option value="America/Anchorage">America/Anchorage (Alaska)</option>
                      <option value="Pacific/Honolulu">Pacific/Honolulu (Hawaii)</option>
                      <option value="America/Toronto">America/Toronto</option>
                      <option value="America/Vancouver">America/Vancouver</option>
                      <option value="America/Mexico_City">America/Mexico_City</option>
                      <option value="America/Sao_Paulo">America/Sao_Paulo</option>
                      <option value="America/Buenos_Aires">America/Buenos_Aires</option>
                    </optgroup>
                    <optgroup label="Europe">
                      <option value="Europe/London">Europe/London</option>
                      <option value="Europe/Paris">Europe/Paris</option>
                      <option value="Europe/Berlin">Europe/Berlin</option>
                      <option value="Europe/Madrid">Europe/Madrid</option>
                      <option value="Europe/Rome">Europe/Rome</option>
                      <option value="Europe/Amsterdam">Europe/Amsterdam</option>
                      <option value="Europe/Brussels">Europe/Brussels</option>
                      <option value="Europe/Zurich">Europe/Zurich</option>
                      <option value="Europe/Moscow">Europe/Moscow</option>
                      <option value="Europe/Istanbul">Europe/Istanbul</option>
                    </optgroup>
                    <optgroup label="Asia">
                      <option value="Asia/Dubai">Asia/Dubai</option>
                      <option value="Asia/Kolkata">Asia/Kolkata (India)</option>
                      <option value="Asia/Singapore">Asia/Singapore</option>
                      <option value="Asia/Hong_Kong">Asia/Hong_Kong</option>
                      <option value="Asia/Shanghai">Asia/Shanghai (China)</option>
                      <option value="Asia/Tokyo">Asia/Tokyo</option>
                      <option value="Asia/Seoul">Asia/Seoul</option>
                      <option value="Asia/Bangkok">Asia/Bangkok</option>
                      <option value="Asia/Jakarta">Asia/Jakarta</option>
                    </optgroup>
                    <optgroup label="Pacific / Oceania">
                      <option value="Australia/Sydney">Australia/Sydney</option>
                      <option value="Australia/Melbourne">Australia/Melbourne</option>
                      <option value="Australia/Perth">Australia/Perth</option>
                      <option value="Pacific/Auckland">Pacific/Auckland (New Zealand)</option>
                    </optgroup>
                    <optgroup label="Africa / Middle East">
                      <option value="Africa/Johannesburg">Africa/Johannesburg</option>
                      <option value="Africa/Cairo">Africa/Cairo</option>
                      <option value="Africa/Lagos">Africa/Lagos</option>
                      <option value="Asia/Jerusalem">Asia/Jerusalem</option>
                    </optgroup>
                    <optgroup label="Other">
                      <option value="UTC">UTC (Coordinated Universal Time)</option>
                    </optgroup>
                  </select>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
                  <div className="flex items-start">
                    <svg className="w-5 h-5 text-blue-500 mr-2 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                    </svg>
                    <div className="text-sm text-blue-700">
                      <p className="font-medium">Current selection: {formData.timezone}</p>
                      <p className="mt-1">
                        Local time: {new Date().toLocaleString('en-US', {
                          timeZone: formData.timezone,
                          weekday: 'short',
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                          timeZoneName: 'short'
                        })}
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
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={handleTimezoneNext}
                    disabled={loading}
                    className="px-6 py-2 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                  >
                    {loading && (
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    )}
                    {loading ? 'Saving...' : 'Continue'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Step 4: Create Admin Account */}
          {step === 4 && (
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-2">
                Create Admin Account
              </h2>
              <p className="text-gray-600 mb-6">
                Set up your administrator account to manage SenseHub.
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Full Name
                  </label>
                  <input
                    type="text"
                    name="name"
                    value={formData.name}
                    onChange={handleChange}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Enter your name"
                    autoComplete="name"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Email Address
                  </label>
                  <input
                    type="email"
                    name="email"
                    value={formData.email}
                    onChange={handleChange}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    placeholder="admin@example.com"
                    autoComplete="email"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Password
                  </label>
                  <input
                    type="password"
                    name="password"
                    value={formData.password}
                    onChange={handleChange}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Minimum 8 characters"
                    autoComplete="new-password"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Confirm Password
                  </label>
                  <input
                    type="password"
                    name="confirmPassword"
                    value={formData.confirmPassword}
                    onChange={handleChange}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Re-enter your password"
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
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="px-6 py-2 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                  >
                    {loading && (
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    )}
                    {loading ? 'Creating Account...' : 'Create Account'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Step 5: Cloud Connection (Optional) */}
          {step === 5 && (
            <div>
              <div className="flex items-center mb-2">
                <svg className="w-8 h-8 text-primary-600 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
                </svg>
                <h2 className="text-2xl font-bold text-gray-900">
                  Cloud Connection
                </h2>
              </div>
              <p className="text-gray-600 mb-6">
                Connect to SenseHub Cloud for remote monitoring, data backup, and cross-site management.
                <span className="block mt-1 text-sm text-gray-500">This is optional - you can configure it later in Settings.</span>
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Cloud URL
                  </label>
                  <input
                    type="url"
                    name="cloudUrl"
                    value={formData.cloudUrl}
                    onChange={handleChange}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    placeholder="https://cloud.sensehub.io"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    API Key
                  </label>
                  <input
                    type="password"
                    name="cloudApiKey"
                    value={formData.cloudApiKey}
                    onChange={handleChange}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Enter your cloud API key"
                  />
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
                  <div className="flex items-start">
                    <svg className="w-5 h-5 text-blue-500 mr-2 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                    </svg>
                    <div className="text-sm text-blue-700">
                      <p className="font-medium">SenseHub works fully offline</p>
                      <p className="mt-1">Cloud connection is optional. Your system will operate completely independently without it.</p>
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
                    Skip for Now
                  </button>
                  <button
                    type="button"
                    onClick={handleCloudConnect}
                    disabled={loading || (!formData.cloudUrl || !formData.cloudApiKey)}
                    className="px-6 py-2 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                  >
                    {loading && (
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    )}
                    {loading ? 'Connecting...' : 'Connect to Cloud'}
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
                Setup Complete!
              </h2>
              <p className="text-gray-600 mb-8 max-w-md mx-auto">
                Your SenseHub system is ready to use. You're now logged in as the administrator.
              </p>

              <div className="bg-gray-50 rounded-xl p-6 mb-8 text-left">
                <h3 className="font-semibold text-gray-900 mb-4">Next Steps</h3>
                <ul className="space-y-3">
                  <li className="flex items-start">
                    <span className="w-6 h-6 bg-primary-100 text-primary-600 rounded-full flex items-center justify-center text-sm font-semibold mr-3 mt-0.5">1</span>
                    <span className="text-gray-600">Scan for equipment on your network</span>
                  </li>
                  <li className="flex items-start">
                    <span className="w-6 h-6 bg-primary-100 text-primary-600 rounded-full flex items-center justify-center text-sm font-semibold mr-3 mt-0.5">2</span>
                    <span className="text-gray-600">Organize equipment into zones</span>
                  </li>
                  <li className="flex items-start">
                    <span className="w-6 h-6 bg-primary-100 text-primary-600 rounded-full flex items-center justify-center text-sm font-semibold mr-3 mt-0.5">3</span>
                    <span className="text-gray-600">Create automation programs</span>
                  </li>
                  <li className="flex items-start">
                    <span className="w-6 h-6 bg-primary-100 text-primary-600 rounded-full flex items-center justify-center text-sm font-semibold mr-3 mt-0.5">4</span>
                    <span className="text-gray-600">Configure cloud sync (optional)</span>
                  </li>
                </ul>
              </div>

              <button
                onClick={goToDashboard}
                className="px-8 py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 transition-colors"
              >
                Go to Dashboard
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default Setup;
