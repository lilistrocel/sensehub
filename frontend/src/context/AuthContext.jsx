import React, { createContext, useContext, useState, useEffect } from 'react';

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
