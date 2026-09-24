import React, { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [isDarkMode, setIsDarkMode] = useState(() => {
    // Stored preference wins. With no preference the app is LIGHT: operators
    // read phones in full sun, so we deliberately do NOT follow
    // prefers-color-scheme. The toggle (header / Settings) still opts into dark.
    try {
      const saved = localStorage.getItem('theme');
      if (saved) {
        return saved === 'dark';
      }
    } catch {
      /* storage unavailable (private mode) - fall through to light */
    }
    return false;
  });

  useEffect(() => {
    // Apply dark class to html element
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    // Save preference
    try {
      localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
    } catch {
      /* ignore */
    }
  }, [isDarkMode]);

  const toggleTheme = () => {
    setIsDarkMode(prev => !prev);
  };

  const value = {
    isDarkMode,
    toggleTheme,
    setIsDarkMode
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

export default ThemeContext;
