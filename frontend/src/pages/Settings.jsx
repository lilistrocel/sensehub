import React from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Users from './settings/Users';

// Settings navigation tabs
const settingsTabs = [
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
  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Cloud Connection</h2>
      <div className="bg-white rounded-lg shadow p-6">
        <p className="text-gray-500">Cloud settings coming soon.</p>
      </div>
    </div>
  );
}

function BackupSettings() {
  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Backup & Restore</h2>
      <div className="bg-white rounded-lg shadow p-6">
        <p className="text-gray-500">Backup settings coming soon.</p>
      </div>
    </div>
  );
}

export default function Settings() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  // Filter tabs based on user role
  const visibleTabs = settingsTabs.filter(tab => !tab.adminOnly || isAdmin);

  if (!isAdmin) {
    return (
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Settings</h1>
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex">
            <svg className="h-5 w-5 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-yellow-800">Access Restricted</h3>
              <p className="mt-1 text-sm text-yellow-700">
                You need administrator privileges to access settings.
              </p>
            </div>
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
            <Route index element={<Navigate to="users" replace />} />
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
