import React from 'react';
import { useTranslation } from 'react-i18next';
import { onResume } from '../utils/connectivity';

// Function component so the fallback can translate; never suspends (the
// app-level boundary sits outside every Suspense boundary).
function ErrorFallback({ onRetry }) {
  const { t } = useTranslation('common', { useSuspense: false });
  return (
    <div role="alert" className="max-w-xl mx-auto mt-8 rounded-lg border border-line bg-panel p-5 text-sm">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-1 inline-block w-2.5 h-2.5 bg-state-alarm" />
        <div className="flex-1">
          <p className="font-semibold text-ink">{t('errorBoundary.title')}</p>
          <p className="mt-1 text-muted">{t('errorBoundary.body')}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 inline-flex items-center min-h-[40px] px-3 rounded-md border border-line bg-field text-ink font-medium"
          >
            {t('actions.tryAgain')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Catches a render crash in the page content so it cannot blank the whole app.
 * Mounted inside Layout around the routed page: the header (Stop / E-STOP,
 * disarmed banner) and the sidebar stay alive and usable.
 *
 * A crash caused by odd data from a failed refetch (tab resume, expiring
 * session) usually heals on the next good response, so the boundary retries
 * by itself on resume, and `resetKey` (the route path) resets it on navigation.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.retry = this.retry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Page render error:', error, info?.componentStack);
  }

  componentDidMount() {
    this.offResume = onResume(() => { if (this.state.error) this.retry(); });
  }

  componentWillUnmount() {
    if (this.offResume) this.offResume();
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) this.retry();
  }

  retry() {
    this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <ErrorFallback onRetry={this.retry} />;
  }
}
