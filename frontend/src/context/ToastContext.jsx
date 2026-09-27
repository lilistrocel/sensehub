import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { shouldSuppressErrorText, subscribe as subscribeConnectivity, getSessionExpiredAt } from '../utils/connectivity';
import i18n from '../i18n';

// Default titles are resolved when the toast is raised, in the active language.
const defaultTitle = (type) => i18n.t(`common:toast.${type}`);

const ToastContext = createContext(null);

// Auto-dismiss times in milliseconds
const TOAST_DURATIONS = {
  success: 4000,
  error: 6000,
  warning: 5000,
  info: 4000
};

let toastIdCounter = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback(({ type = 'info', title, message, duration = null }) => {
    // Network errors while the tab is hidden / offline / just resumed are resume
    // noise, not faults (the fetch layer retries them), and errors in the seconds
    // after a session expiry are fallout of the redirect to login. Drop them;
    // a failure that persists once the page is visible and online still toasts.
    if ((type === 'error' || type === 'warning') && shouldSuppressErrorText(`${title || ''} ${message || ''}`)) {
      console.info('[toast suppressed: transient]', title, message);
      return null;
    }
    const id = ++toastIdCounter;
    const autoDismiss = duration ?? TOAST_DURATIONS[type] ?? 4000;

    setToasts(prev => [...prev, { id, type, title, message }]);

    // Auto-dismiss after duration
    if (autoDismiss > 0) {
      setTimeout(() => {
        removeToast(id);
      }, autoDismiss);
    }

    return id;
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  }, []);

  // Session expired: the user is on their way to the login page. Clear the
  // error/warning toasts the expiring requests raised on the way out.
  useEffect(() => {
    let seen = getSessionExpiredAt();
    return subscribeConnectivity(() => {
      const at = getSessionExpiredAt();
      if (at && at !== seen) {
        seen = at;
        setToasts(prev => prev.filter(t => t.type !== 'error' && t.type !== 'warning'));
      }
    });
  }, []);

  // Convenience methods
  const showSuccess = useCallback((message, title = defaultTitle('success')) => {
    return addToast({ type: 'success', title, message });
  }, [addToast]);

  const showError = useCallback((message, title = defaultTitle('error')) => {
    return addToast({ type: 'error', title, message });
  }, [addToast]);

  const showWarning = useCallback((message, title = defaultTitle('warning')) => {
    return addToast({ type: 'warning', title, message });
  }, [addToast]);

  const showInfo = useCallback((message, title = defaultTitle('info')) => {
    return addToast({ type: 'info', title, message });
  }, [addToast]);

  return (
    <ToastContext.Provider value={{
      toasts,
      addToast,
      removeToast,
      showSuccess,
      showError,
      showWarning,
      showInfo
    }}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

export default ToastContext;
