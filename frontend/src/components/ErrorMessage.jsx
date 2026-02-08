import React from 'react';

/**
 * A user-friendly error message component with optional retry button
 * @param {Object} props
 * @param {string} props.message - The error message to display
 * @param {boolean} props.canRetry - Whether to show the retry button
 * @param {Function} props.onRetry - Callback function when retry is clicked
 * @param {boolean} props.isNetworkError - Whether this is a network-related error
 * @param {string} props.className - Additional CSS classes
 */
function ErrorMessage({
  message,
  canRetry = false,
  onRetry,
  isNetworkError = false,
  className = ''
}) {
  if (!message) return null;

  return (
    <div className={`p-4 bg-red-50 border border-red-200 rounded-lg ${className}`}>
      <div className="flex items-start">
        {/* Error Icon */}
        <div className="flex-shrink-0">
          {isNetworkError ? (
            // Network error icon (wifi off)
            <svg className="h-5 w-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414" />
            </svg>
          ) : (
            // General error icon (exclamation circle)
            <svg className="h-5 w-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
        </div>

        {/* Error Message */}
        <div className="ml-3 flex-1">
          <p className="text-sm text-red-800">{message}</p>

          {/* Retry Button */}
          {canRetry && onRetry && (
            <button
              onClick={onRetry}
              className="mt-2 inline-flex items-center px-3 py-1.5 border border-red-300 text-sm font-medium rounded-md text-red-700 bg-red-100 hover:bg-red-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors"
            >
              <svg className="h-4 w-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Try Again
            </button>
          )}
        </div>

        {/* Dismiss Button (if no retry) */}
        {!canRetry && (
          <div className="ml-auto pl-3">
            <button
              className="text-red-400 hover:text-red-600 focus:outline-none"
              aria-label="Dismiss"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default ErrorMessage;
