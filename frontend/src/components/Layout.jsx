import React, { useState, useEffect } from 'react';
import Sidebar from './Sidebar';
import Breadcrumb from './Breadcrumb';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';

const API_BASE = '/api';

export default function Layout({ children }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { user, token } = useAuth();
  const { isDarkMode, toggleTheme } = useTheme();
  const [cloudStatus, setCloudStatus] = useState({
    configured: false,
    connected: false,
    lastSync: null,
    pendingItems: 0
  });
  const [unacknowledgedCount, setUnacknowledgedCount] = useState(0);

  // Fetch cloud status on mount and periodically
  useEffect(() => {
    const fetchCloudStatus = async () => {
      try {
        const response = await fetch(`${API_BASE}/cloud/status`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
          const data = await response.json();
          setCloudStatus(data);
        }
      } catch (err) {
        console.error('Failed to fetch cloud status:', err);
      }
    };

    fetchCloudStatus();
    // Refresh cloud status every 30 seconds
    const interval = setInterval(fetchCloudStatus, 30000);
    return () => clearInterval(interval);
  }, [token]);

  // Fetch unacknowledged alert count
  useEffect(() => {
    const fetchUnacknowledgedCount = async () => {
      try {
        const response = await fetch(`${API_BASE}/alerts/unacknowledged/count`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
          const data = await response.json();
          setUnacknowledgedCount(data.count);
        }
      } catch (err) {
        console.error('Failed to fetch unacknowledged count:', err);
      }
    };

    fetchUnacknowledgedCount();
    // Refresh every 10 seconds for real-time updates
    const interval = setInterval(fetchUnacknowledgedCount, 10000);
    return () => clearInterval(interval);
  }, [token]);

  // Determine cloud status display
  const getCloudStatusDisplay = () => {
    if (!cloudStatus.configured) {
      return {
        color: 'bg-gray-400',
        text: 'Not Configured',
        title: 'Cloud: Not Configured'
      };
    }
    if (cloudStatus.connected) {
      return {
        color: 'bg-green-500',
        text: cloudStatus.pendingItems > 0
          ? `Connected (${cloudStatus.pendingItems} pending)`
          : 'Connected',
        title: `Cloud: Connected${cloudStatus.lastSync ? ` - Last sync: ${new Date(cloudStatus.lastSync).toLocaleString()}` : ''}`
      };
    }
    return {
      color: 'bg-yellow-400',
      text: 'Offline Mode',
      title: 'Cloud: Disconnected'
    };
  };

  const cloudDisplay = getCloudStatusDisplay();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex">
      <Sidebar mobileMenuOpen={mobileMenuOpen} setMobileMenuOpen={setMobileMenuOpen} />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top header */}
        <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-4 md:px-6">
          <div className="flex items-center justify-between">
            {/* Spacer for mobile menu button */}
            <div className="w-10 md:hidden" />

            {/* Breadcrumb navigation */}
            <div className="flex-1 ml-4 md:ml-0">
              <Breadcrumb />
            </div>

            {/* User info and status */}
            <div className="flex items-center space-x-4">
              {/* Dark mode toggle */}
              <button
                onClick={toggleTheme}
                className="p-2 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {isDarkMode ? (
                  <svg className="w-5 h-5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5 text-gray-600 dark:text-gray-400" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                  </svg>
                )}
              </button>

              {/* Unacknowledged alerts badge */}
              {unacknowledgedCount > 0 && (
                <a
                  href="/alerts"
                  className="flex items-center text-sm hover:opacity-80"
                  title={`${unacknowledgedCount} unacknowledged alert${unacknowledgedCount !== 1 ? 's' : ''}`}
                >
                  <span className="relative">
                    <svg className="w-5 h-5 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                    </svg>
                    <span className="absolute -top-2 -right-2 inline-flex items-center justify-center px-1.5 py-0.5 text-xs font-bold leading-none text-white bg-red-500 rounded-full min-w-[18px]">
                      {unacknowledgedCount > 99 ? '99+' : unacknowledgedCount}
                    </span>
                  </span>
                </a>
              )}

              {/* Cloud status indicator */}
              <div className="flex items-center text-sm" title={cloudDisplay.title}>
                <span className={`w-2 h-2 rounded-full ${cloudDisplay.color} mr-2`}></span>
                <span className="hidden sm:inline text-gray-500 dark:text-gray-400">{cloudDisplay.text}</span>
              </div>

              {/* User badge */}
              <div className="hidden md:flex items-center">
                <span className="text-sm text-gray-500 dark:text-gray-400 mr-2">{user?.name}</span>
                <span className="px-2 py-1 text-xs font-medium rounded-full bg-primary-100 dark:bg-primary-900 text-primary-700 dark:text-primary-300 capitalize">
                  {user?.role}
                </span>
              </div>
            </div>
          </div>
        </header>

        {/* Main content */}
        <main className="flex-1 p-4 md:p-6 overflow-auto">
          {children}
        </main>

        {/* Footer with system status */}
        <footer className="bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-between">
            <span>SenseHub v1.0.0</span>
            <div className="flex items-center space-x-4">
              <span className="flex items-center">
                <span className="w-2 h-2 rounded-full bg-green-500 mr-1"></span>
                System OK
              </span>
              <span className="flex items-center">
                <span className="w-2 h-2 rounded-full bg-green-500 mr-1"></span>
                DB Connected
              </span>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
