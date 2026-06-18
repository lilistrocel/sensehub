import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';

const AuthContext = createContext(null);

const API_BASE = '/api';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(null);

  useEffect(() => {
    checkSetupAndSession();
  }, []);

  // Keep a live ref to the current token so the (install-once) fetch wrapper
  // below can read it without being re-installed on every token change.
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  // Global 401 interceptor: wrap window.fetch ONCE so every manual fetch() call
  // across the ~270 call sites in the app is covered without touching them.
  // When an authenticated request to an /api/ endpoint comes back 401, the
  // backend session has expired -> tear down the local session, which makes
  // ProtectedRoute redirect to /login. Auth endpoints are excluded so a bad
  // login (also 401) does not bounce the user or create a logout loop.
  useEffect(() => {
    const originalFetch = window.fetch;

    // Endpoints whose 401s must NOT trigger auto-logout (avoid loops / spurious
    // logout on a failed login attempt while unauthenticated).
    const isExemptUrl = (url) =>
      url.includes('/api/auth/login') ||
      url.includes('/api/auth/logout') ||
      url.includes('/api/auth/setup-status') ||
      url.includes('/api/auth/session');

    const interceptedFetch = async (input, init) => {
      const response = await originalFetch(input, init);

      try {
        if (response.status === 401) {
          // Resolve the request URL across the possible `input` shapes.
          const url =
            typeof input === 'string'
              ? input
              : (input && input.url) || String(input || '');

          // Only react to our own API, only when a token was present, and never
          // on the auth endpoints handled by their own callers.
          if (url.includes('/api/') && !isExemptUrl(url) && tokenRef.current) {
            handleSessionExpired();
          }
        }
      } catch (e) {
        // Never let interceptor bookkeeping break the actual request flow.
        console.error('Session-expiry interceptor error:', e);
      }

      return response;
    };

    window.fetch = interceptedFetch;

    return () => {
      // Restore only if no one else re-wrapped fetch after us.
      if (window.fetch === interceptedFetch) {
        window.fetch = originalFetch;
      }
    };
  }, [handleSessionExpired]);

  const checkSetupAndSession = async () => {
    try {
      // First check if setup is needed
      const setupResponse = await fetch(`${API_BASE}/auth/setup-status`);
      if (setupResponse.ok) {
        const setupData = await setupResponse.json();
        setNeedsSetup(setupData.needsSetup);

        // If setup is needed, no need to check session
        if (setupData.needsSetup) {
          setLoading(false);
          return;
        }
      }

      // If we have a token, verify the session
      if (token) {
        await checkSession();
      } else {
        setLoading(false);
      }
    } catch (error) {
      console.error('Setup/session check failed:', error);
      setNeedsSetup(false);
      setLoading(false);
    }
  };

  const checkSession = async () => {
    try {
      const response = await fetch(`${API_BASE}/auth/session`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (response.ok) {
        const data = await response.json();
        setUser(data.user);
      } else {
        // Session invalid, clear token
        localStorage.removeItem('token');
        setToken(null);
        setUser(null);
      }
    } catch (error) {
      console.error('Session check failed:', error);
      localStorage.removeItem('token');
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  const login = async (email, password) => {
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Login failed');
    }

    const data = await response.json();
    localStorage.setItem('token', data.token);
    setToken(data.token);
    setUser(data.user);
    return data;
  };

  const logout = async () => {
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      localStorage.removeItem('token');
      setToken(null);
      setUser(null);
    }
  };

  // Local session teardown used when the backend reports the session has
  // expired (HTTP 401). Unlike logout() this does NOT call the logout endpoint
  // (the token is already invalid) and never goes through the fetch wrapper, so
  // it cannot trigger a logout loop. Clearing `user` causes ProtectedRoute in
  // App.jsx to redirect to /login automatically (no hard navigation needed).
  const handleSessionExpired = useCallback(() => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
  }, []);

  // Function to update user after setup completion
  const setUserAfterSetup = (newToken, newUser) => {
    setToken(newToken);
    setUser(newUser);
    setNeedsSetup(false);
  };

  const value = {
    user,
    token,
    loading,
    login,
    logout,
    isAuthenticated: !!user,
    needsSetup,
    setUserAfterSetup
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export default AuthContext;
