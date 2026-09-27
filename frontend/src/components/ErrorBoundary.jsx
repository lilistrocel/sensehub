import React from 'react';
import { onResume } from '../utils/connectivity';

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
    return (
      <div role="alert" className="max-w-xl mx-auto mt-8 rounded-lg border border-line bg-panel p-5 text-sm">
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="mt-1 inline-block w-2.5 h-2.5 bg-state-alarm" />
          <div className="flex-1">
            <p className="font-semibold text-ink">This page could not be displayed.</p>
            <p className="mt-1 text-muted">
              The header controls still work. Try again, or open another page from the menu.
            </p>
            <button
              type="button"
              onClick={this.retry}
              className="mt-3 inline-flex items-center min-h-[40px] px-3 rounded-md border border-line bg-field text-ink font-medium"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
