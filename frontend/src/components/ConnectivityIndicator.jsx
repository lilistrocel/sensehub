import React, { useEffect, useState } from 'react';
import { useConnectivity } from '../hooks/useConnectivity';

function ageLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

// Shape + colour (docs/FARM-APP-STANDARDS.md): hollow = unknown/stale,
// triangle = caution, square = alarm. Nothing is rendered while fresh.
const VIEW = {
  reconnecting: {
    text: 'Reconnecting…',
    cls: 'border-line text-muted bg-panel',
    mark: <span aria-hidden="true" className="inline-block w-2 h-2 rounded-full border-2 border-state-idle animate-pulse" />,
    title: 'Reconnecting to SenseHub. Showing the last data received.',
  },
  offline: {
    text: 'Offline',
    cls: 'border-caution-300 text-caution-700 bg-caution-50 dark:border-caution-700 dark:text-caution-300 dark:bg-caution-900/40',
    mark: (
      <svg aria-hidden="true" viewBox="0 0 10 10" className="w-2.5 h-2.5 fill-current text-state-caution"><path d="M5 0.5 9.5 9.5H0.5Z" /></svg>
    ),
    title: 'This device has no network connection. Showing the last data received.',
  },
  down: {
    text: 'Server unreachable',
    cls: 'border-alarm-300 text-alarm-700 bg-alarm-50 dark:border-alarm-700 dark:text-alarm-300 dark:bg-alarm-900/40',
    mark: <span aria-hidden="true" className="inline-block w-2 h-2 bg-state-alarm" />,
    title: 'SenseHub is not answering. Data on screen is stale.',
  },
};

/**
 * Header pill shown only while the app is not fresh: reconnecting after a
 * resume, device offline, or the server persistently unreachable. Includes
 * the age of the last successful response so stale data reads as stale.
 */
const RECONNECTING_SHOW_AFTER_MS = 1500; // a quick resume should not flash the pill

export default function ConnectivityIndicator({ className = '' }) {
  const { status, lastOkAt } = useConnectivity();
  const [now, setNow] = useState(Date.now());
  const [notOkSince, setNotOkSince] = useState(null);

  useEffect(() => {
    if (status === 'ok') { setNotOkSince(null); return undefined; }
    setNotOkSince((prev) => prev ?? Date.now());
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [status]);

  if (status === 'ok') return null;
  if (status === 'reconnecting' && (!notOkSince || now - notOkSince < RECONNECTING_SHOW_AFTER_MS)) return null;
  const v = VIEW[status] || VIEW.reconnecting;
  const age = lastOkAt ? ageLabel(now - lastOkAt) : null;
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="connectivity-indicator"
      data-status={status}
      title={v.title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold whitespace-nowrap shadow-sm ${v.cls} ${className}`.trim()}
    >
      {v.mark}
      <span>{v.text}</span>
      {age && status !== 'reconnecting' && <span className="font-normal opacity-80">· updated {age}</span>}
    </span>
  );
}
