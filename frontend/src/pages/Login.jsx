import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { Button, Label } from '../ui';
import LanguageSwitcher from '../components/LanguageSwitcher';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const location = useLocation();

  // Get the intended destination from location state, or default to dashboard
  const from = location.state?.from?.pathname || '/';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login(email, password);
      // Redirect to the originally intended page, not just the dashboard
      navigate(from, { replace: true });
    } catch (err) {
      // The server's message arrives localized (Accept-Language); fall back to ours.
      setError(err.message || t('login.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center px-4 py-8">
      <div className="max-w-md w-full">
        <LanguageSwitcher variant="inline" className="mb-6" />

        <div className="mb-8 flex items-center gap-3">
          <span aria-hidden="true" className="w-3 h-10 rounded-sm bg-brand-600 shrink-0" />
          <div className="leading-tight">
            <Label lang="en">A20Core</Label>
            <h1 className="font-display text-3xl font-bold text-ink" lang="en">SenseHub</h1>
            <p className="text-sm text-muted mt-0.5">{t('login.tagline')}</p>
          </div>
        </div>

        <div className="bg-panel border border-line rounded-card p-6 sm:p-8">
          <h2 className="font-display text-xl font-semibold text-ink mb-6">{t('login.title')}</h2>

          {error && (
            <div
              role="alert"
              aria-live="assertive"
              className="mb-4 p-3 bg-alarm-50 dark:bg-alarm-900/30 border border-alarm-200 dark:border-alarm-700 border-s-[3px] border-s-state-alarm rounded-md text-alarm-700 dark:text-alarm-300 text-sm"
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <Label as="label" htmlFor="email" className="mb-1.5">{t('login.email')}</Label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                dir="ltr"
                className="w-full min-h-touch px-3 py-2 bg-field text-ink border border-line rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 text-start rtl:text-right"
                placeholder="admin@sensehub.local"
              />
            </div>

            <div>
              <Label as="label" htmlFor="password" className="mb-1.5">{t('login.password')}</Label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full min-h-touch px-3 py-2 bg-field text-ink border border-line rounded-md focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                placeholder={t('login.passwordPlaceholder')}
              />
            </div>

            <Button type="submit" variant="primary" size="md" disabled={loading} className="w-full">
              {loading ? t('login.signingIn') : t('login.submit')}
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-label uppercase text-muted">{t('login.offlineNote')}</p>
      </div>
    </div>
  );
}
