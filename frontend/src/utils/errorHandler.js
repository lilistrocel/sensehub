/**
 * User-friendly error handling utility for SenseHub
 * Converts technical errors to readable messages and provides retry options
 */

// Map of technical error patterns to user-friendly messages
const ERROR_MESSAGES = {
  // Network errors
  'Failed to fetch': {
    message: 'Unable to connect to the server. Please check your network connection.',
    isNetworkError: true,
    canRetry: true
  },
  'NetworkError': {
    message: 'Network error occurred. Please check your internet connection and try again.',
    isNetworkError: true,
    canRetry: true
  },
  'Network request failed': {
    message: 'Unable to reach the server. Please verify your network connection.',
    isNetworkError: true,
    canRetry: true
  },
  'ERR_NETWORK': {
    message: 'Connection to server failed. Please check if the server is running.',
    isNetworkError: true,
    canRetry: true
  },
  'net::ERR_CONNECTION_REFUSED': {
    message: 'Server connection refused. Please try again later.',
    isNetworkError: true,
    canRetry: true
  },
  'net::ERR_CONNECTION_TIMED_OUT': {
    message: 'Connection timed out. The server might be busy. Please try again.',
    isNetworkError: true,
    canRetry: true
  },
  'net::ERR_INTERNET_DISCONNECTED': {
    message: 'No internet connection. Please check your network and try again.',
    isNetworkError: true,
    canRetry: true
  },
  'ETIMEDOUT': {
    message: 'Request timed out. The server is taking too long to respond.',
    isNetworkError: true,
    canRetry: true
  },
  'ECONNABORTED': {
    message: 'Connection was aborted. Please try again.',
    isNetworkError: true,
    canRetry: true
  },

  // HTTP errors
  '401': {
    message: 'Your session has expired. Please log in again.',
    isAuthError: true,
    canRetry: false
  },
  '403': {
    message: 'You do not have permission to perform this action.',
    isAuthError: true,
    canRetry: false
  },
  '404': {
    message: 'The requested item was not found.',
    isNetworkError: false,
    canRetry: false
  },
  '500': {
    message: 'An unexpected server error occurred. Please try again later.',
    isNetworkError: false,
    canRetry: true
  },
  '502': {
    message: 'Server is temporarily unavailable. Please try again in a moment.',
    isNetworkError: false,
    canRetry: true
  },
  '503': {
    message: 'Service is temporarily unavailable. Please try again later.',
    isNetworkError: false,
    canRetry: true
  },
  '504': {
    message: 'Request timed out. The server is taking too long to respond.',
    isNetworkError: false,
    canRetry: true
  },

  // Generic fallback patterns
  'TypeError': {
    message: 'An unexpected error occurred. Please refresh the page and try again.',
    isNetworkError: false,
    canRetry: true
  },
  'timeout': {
    message: 'The operation took too long. Please try again.',
    isNetworkError: false,
    canRetry: true
  }
};

/**
 * Convert a technical error to a user-friendly error object
 * @param {Error|string} error - The error to convert
 * @param {string} context - Optional context about what operation was being performed
 * @returns {Object} - User-friendly error object with message, canRetry, and isNetworkError flags
 */
export function getUserFriendlyError(error, context = '') {
  // Get the error message string
  const errorMessage = typeof error === 'string'
    ? error
    : error?.message || String(error);

  // Check for specific error patterns
  for (const [pattern, errorInfo] of Object.entries(ERROR_MESSAGES)) {
    if (errorMessage.includes(pattern) || errorMessage.toLowerCase().includes(pattern.toLowerCase())) {
      return {
        message: errorInfo.message,
        canRetry: errorInfo.canRetry,
        isNetworkError: errorInfo.isNetworkError || false,
        isAuthError: errorInfo.isAuthError || false,
        originalError: errorMessage
      };
    }
  }

  // Check for HTTP status codes in the error
  const statusMatch = errorMessage.match(/(\d{3})/);
  if (statusMatch) {
    const status = statusMatch[1];
    if (ERROR_MESSAGES[status]) {
      return {
        message: ERROR_MESSAGES[status].message,
        canRetry: ERROR_MESSAGES[status].canRetry,
        isNetworkError: ERROR_MESSAGES[status].isNetworkError || false,
        isAuthError: ERROR_MESSAGES[status].isAuthError || false,
        originalError: errorMessage
      };
    }
  }

  // If the error message is already user-friendly (not technical), return it as-is
  // Technical messages often contain: error codes, stack traces, or all-caps terms
  const technicalPatterns = [
    /^[A-Z_]+$/,           // All caps with underscores (error codes)
    /Error:/,               // Contains "Error:"
    /at\s+\w+\s*\(/,       // Stack trace pattern
    /ENOENT|EACCES|EPERM/, // System error codes
    /\{.*\}/,              // JSON objects
    /undefined|null/,       // Programming terms
  ];

  const isTechnical = technicalPatterns.some(pattern => pattern.test(errorMessage));

  if (!isTechnical && errorMessage.length < 200) {
    // The message seems user-friendly already
    return {
      message: errorMessage,
      canRetry: true,
      isNetworkError: false,
      isAuthError: false,
      originalError: errorMessage
    };
  }

  // Fallback to generic message
  const contextStr = context ? ` while ${context}` : '';
  return {
    message: `Something went wrong${contextStr}. Please try again.`,
    canRetry: true,
    isNetworkError: false,
    isAuthError: false,
    originalError: errorMessage
  };
}

/**
 * Handle API response errors and return user-friendly error
 * @param {Response} response - The fetch Response object
 * @param {string} context - Optional context about what operation was being performed
 * @returns {Promise<Object>} - User-friendly error object
 */
export async function handleApiError(response, context = '') {
  try {
    const data = await response.json();

    // If server provides a message, check if it's user-friendly
    if (data.message) {
      return getUserFriendlyError(data.message, context);
    }

    // Use HTTP status code
    return getUserFriendlyError(String(response.status), context);
  } catch {
    // JSON parsing failed
    return getUserFriendlyError(String(response.status), context);
  }
}

/**
 * Create a retry-enabled fetch wrapper
 * @param {string} url - The URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} maxRetries - Maximum number of retries (default: 3)
 * @param {number} retryDelay - Delay between retries in ms (default: 1000)
 * @returns {Promise<Response>} - The fetch response
 */
export async function fetchWithRetry(url, options = {}, maxRetries = 3, retryDelay = 1000) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      return response;
    } catch (error) {
      lastError = error;

      // Check if error is retryable
      const errorInfo = getUserFriendlyError(error);
      if (!errorInfo.canRetry || attempt === maxRetries) {
        throw error;
      }

      // Wait before retry with exponential backoff
      await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt)));
    }
  }

  throw lastError;
}

export default {
  getUserFriendlyError,
  handleApiError,
  fetchWithRetry
};
