import React, { useState } from 'react';
import Sidebar from './Sidebar';
import { useAuth } from '../context/AuthContext';

export default function Layout({ children }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { user } = useAuth();

  return (
    <div className="min-h-screen bg-gray-50 flex">
      <Sidebar mobileMenuOpen={mobileMenuOpen} setMobileMenuOpen={setMobileMenuOpen} />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top header */}
        <header className="bg-white border-b border-gray-200 px-4 py-4 md:px-6">
          <div className="flex items-center justify-between">
            {/* Spacer for mobile menu button */}
            <div className="w-10 md:hidden" />

            {/* Page title placeholder */}
            <div className="flex-1 ml-4 md:ml-0">
              {/* This will be updated per-page */}
            </div>

            {/* User info and status */}
            <div className="flex items-center space-x-4">
              {/* Cloud status indicator */}
              <div className="flex items-center text-sm">
                <span className="w-2 h-2 rounded-full bg-yellow-400 mr-2" title="Cloud: Disconnected"></span>
                <span className="hidden sm:inline text-gray-500">Offline Mode</span>
              </div>

              {/* User badge */}
              <div className="hidden md:flex items-center">
                <span className="text-sm text-gray-500 mr-2">{user?.name}</span>
                <span className="px-2 py-1 text-xs font-medium rounded-full bg-primary-100 text-primary-700 capitalize">
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
        <footer className="bg-white border-t border-gray-200 px-4 py-2 text-xs text-gray-500">
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
