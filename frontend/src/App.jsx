import React, { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { WebSocketProvider } from './context/WebSocketContext';
import { AlertSoundProvider } from './context/AlertSoundContext';
import { ToastProvider } from './context/ToastContext';
import { SettingsProvider } from './context/SettingsContext';
import { ThemeProvider } from './context/ThemeContext';
import { LanguageProvider } from './context/LanguageContext';
import Layout from './components/Layout';
import { ToastContainer } from './components/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import { BreadcrumbProvider } from './components/Breadcrumb';
import Login from './pages/Login';
import Setup from './pages/Setup';
import Dashboard from './pages/Dashboard';
import Equipment from './pages/Equipment';
import Zones from './pages/Zones';
import Automations from './pages/Automations';
import Alerts from './pages/Alerts';
import Settings from './pages/Settings';
import Cameras from './pages/Cameras';
import Debug from './pages/Debug';
import Fertigation from './pages/Fertigation';
import LabAnalysis from './pages/LabAnalysis';
import Calibration from './pages/Calibration';
import Reports from './pages/Reports';
import Tasks from './pages/Tasks';
import Amic from './pages/Amic';
import Agronomist from './pages/Agronomist';
import Nutrition from './pages/Nutrition';
import Planner from './pages/Planner';
import Templates from './pages/Templates';
import Analytics from './pages/Analytics';
import RelayEvents from './pages/RelayEvents';
import Logs from './pages/Logs';
import NotFound from './pages/NotFound';

// Loading spinner component. Never suspends itself (it is a Suspense fallback).
function LoadingSpinner() {
  const { t } = useTranslation('common', { useSuspense: false });
  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4"></div>
        <p className="text-muted">{t('status.loading')}</p>
      </div>
    </div>
  );
}

// Protected route wrapper
function ProtectedRoute({ children }) {
  const { isAuthenticated, loading, needsSetup } = useAuth();
  const location = useLocation();

  if (loading || needsSetup === null) {
    return <LoadingSpinner />;
  }

  // Redirect to setup if needed
  if (needsSetup) {
    return <Navigate to="/setup" replace />;
  }

  if (!isAuthenticated) {
    // Pass the current location as state so we can redirect back after login
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Layout>{children}</Layout>;
}

// Public route wrapper (redirect to dashboard if already logged in)
function PublicRoute({ children }) {
  const { isAuthenticated, loading, needsSetup } = useAuth();

  if (loading || needsSetup === null) {
    return <LoadingSpinner />;
  }

  // Redirect to setup if needed
  if (needsSetup) {
    return <Navigate to="/setup" replace />;
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return children;
}

// Single source of truth for whether the /debug route exists. Sidebar.jsx
// applies the identical rule (import.meta.env.DEV && role === 'admin') so the
// nav item is never shown for a route that is not mounted.
const DEBUG_ROUTE_ENABLED = !!import.meta.env.DEV;

// Admin-only route wrapper (authenticated AND role === 'admin').
// Used to gate developer/diagnostic routes away from operators and viewers.
function AdminRoute({ children }) {
  const { isAuthenticated, loading, needsSetup, user } = useAuth();
  const location = useLocation();

  if (loading || needsSetup === null) {
    return <LoadingSpinner />;
  }

  if (needsSetup) {
    return <Navigate to="/setup" replace />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Non-admins are redirected to the dashboard rather than seeing the page.
  if (user?.role !== 'admin') {
    return <Navigate to="/" replace />;
  }

  return <Layout>{children}</Layout>;
}

// Setup route wrapper (only accessible when setup is needed)
function SetupRoute({ children }) {
  const { isAuthenticated, loading, needsSetup } = useAuth();

  if (loading || needsSetup === null) {
    return <LoadingSpinner />;
  }

  // If setup is complete and user is logged in, go to dashboard
  if (!needsSetup && isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  // If setup is complete but user not logged in, go to login
  if (!needsSetup && !isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/setup"
        element={
          <SetupRoute>
            <Setup />
          </SetupRoute>
        }
      />
      <Route
        path="/login"
        element={
          <PublicRoute>
            <Login />
          </PublicRoute>
        }
      />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/equipment"
        element={
          <ProtectedRoute>
            <Equipment />
          </ProtectedRoute>
        }
      />
      <Route
        path="/equipment/:id"
        element={
          <ProtectedRoute>
            <Equipment />
          </ProtectedRoute>
        }
      />
      <Route
        path="/cameras"
        element={
          <ProtectedRoute>
            <Cameras />
          </ProtectedRoute>
        }
      />
      <Route
        path="/zones"
        element={
          <ProtectedRoute>
            <Zones />
          </ProtectedRoute>
        }
      />
      <Route
        path="/zones/:id"
        element={
          <ProtectedRoute>
            <Zones />
          </ProtectedRoute>
        }
      />
      <Route
        path="/automations"
        element={
          <ProtectedRoute>
            <Automations />
          </ProtectedRoute>
        }
      />
      <Route
        path="/fertigation"
        element={
          <ProtectedRoute>
            <Fertigation />
          </ProtectedRoute>
        }
      />
      <Route
        path="/lab-analysis"
        element={
          <ProtectedRoute>
            <LabAnalysis />
          </ProtectedRoute>
        }
      />
      <Route
        path="/calibration"
        element={
          <ProtectedRoute>
            <Calibration />
          </ProtectedRoute>
        }
      />
      <Route
        path="/reports"
        element={
          <ProtectedRoute>
            <Reports />
          </ProtectedRoute>
        }
      />
      <Route
        path="/amic"
        element={
          <ProtectedRoute>
            <Amic />
          </ProtectedRoute>
        }
      />
      <Route
        path="/agronomist"
        element={
          <ProtectedRoute>
            <Agronomist />
          </ProtectedRoute>
        }
      />
      <Route
        path="/planner"
        element={
          <ProtectedRoute>
            <Planner />
          </ProtectedRoute>
        }
      />
      <Route
        path="/templates"
        element={
          <ProtectedRoute>
            <Templates />
          </ProtectedRoute>
        }
      />
      <Route
        path="/nutrition"
        element={
          <ProtectedRoute>
            <Nutrition />
          </ProtectedRoute>
        }
      />
      <Route
        path="/analytics"
        element={
          <ProtectedRoute>
            <Analytics />
          </ProtectedRoute>
        }
      />
      <Route
        path="/tasks"
        element={
          <ProtectedRoute>
            <Tasks />
          </ProtectedRoute>
        }
      />
      <Route
        path="/alerts"
        element={
          <ProtectedRoute>
            <Alerts />
          </ProtectedRoute>
        }
      />
      <Route
        path="/relay-events"
        element={
          <ProtectedRoute>
            <RelayEvents />
          </ProtectedRoute>
        }
      />
      <Route
        path="/logs"
        element={
          <ProtectedRoute>
            <Logs />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/*"
        element={
          <ProtectedRoute>
            <Settings />
          </ProtectedRoute>
        }
      />
      {/* Debug/diagnostics: dev builds only, and admin-only even there.
          In production builds (import.meta.env.DEV === false) the route is not
          mounted at all, so it falls through to the 404 handler. */}
      {DEBUG_ROUTE_ENABLED && (
        <Route
          path="/debug"
          element={
            <AdminRoute>
              <Debug />
            </AdminRoute>
          }
        />
      )}
      {/* Catch all - show 404 page */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <SettingsProvider>
            <BreadcrumbProvider>
              <WebSocketProvider>
                <AlertSoundProvider>
                  <ToastProvider>
                    <LanguageProvider>
                      <ErrorBoundary>
                        <Suspense fallback={<LoadingSpinner />}>
                          <AppRoutes />
                        </Suspense>
                      </ErrorBoundary>
                      <ToastContainer />
                    </LanguageProvider>
                  </ToastProvider>
                </AlertSoundProvider>
              </WebSocketProvider>
            </BreadcrumbProvider>
          </SettingsProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}

export default App;
