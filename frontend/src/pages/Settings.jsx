import React, { useState } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
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
  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-4">System Settings</h2>
      <div className="bg-white rounded-lg shadow p-6">
        <p className="text-gray-500">System settings coming soon.</p>
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

  // Initial fetch and refresh every 30 seconds
  React.useEffect(() => {
    fetchCloudStatus();
    fetchSuggestedPrograms();
    const interval = setInterval(fetchCloudStatus, 30000);
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

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3">
          {cloudStatus?.configured ? (
            <>
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

      {/* Connect Modal */}
      {showConnectModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75" onClick={() => setShowConnectModal(false)}></div>
            <div className="inline-block w-full max-w-md p-6 my-8 overflow-hidden text-left align-middle transition-all transform bg-white shadow-xl rounded-lg relative">
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
  const { token } = useAuth();
  const [showFactoryResetModal, setShowFactoryResetModal] = useState(false);
  const [resetPassword, setResetPassword] = useState('');
  const [resetError, setResetError] = useState(null);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupMessage, setBackupMessage] = useState(null);

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
      // In production, the system would restart here
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
            <div className="inline-block w-full max-w-md p-6 my-8 overflow-hidden text-left align-middle transition-all transform bg-white shadow-xl rounded-lg relative">
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
