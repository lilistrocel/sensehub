import { useCallback, useRef } from 'react';

/**
 * Wraps a toast function so repeated failures of the same background job
 * (polling, periodic refresh) surface as ONE toast per window instead of one
 * per tick.
 *
 * @param {(message: string) => void} showError  from useToast()
 * @param {number} windowMs  minimum gap between toasts for the same key (default 60 s)
 * @returns {(message: string, key?: string) => void}
 */
export function useThrottledError(showError, windowMs = 60000) {
  const lastShownRef = useRef({});
  return useCallback((message, key) => {
    const k = key || message;
    const now = Date.now();
    if (now - (lastShownRef.current[k] || 0) < windowMs) return;
    lastShownRef.current[k] = now;
    showError(message);
  }, [showError, windowMs]);
}

export default useThrottledError;
