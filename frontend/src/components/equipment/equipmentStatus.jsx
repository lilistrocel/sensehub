import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { formatAgo } from '../../i18n/format';
import { isStale, toEpochMs, formatSince } from '../../utils/freshness';

/** Re-render on a fixed cadence so "x min ago" / stale evaluation stays honest. */
export function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export const isEquipmentDisabled = (eq) => eq?.enabled === 0 || eq?.enabled === false;

/** Stale = enabled, has a poll interval, and last_communication older than 2x it. */
export function isEquipmentStale(eq, now = Date.now()) {
  if (!eq || isEquipmentDisabled(eq)) return false;
  const poll = Number(eq.polling_interval_ms);
  if (!Number.isFinite(poll) || poll <= 0) return false;
  return isStale(eq.last_communication, poll, 2, now);
}

/**
 * "just now", "45 s ago", "3 min ago", "2 h ago", "3 d ago", or "never" in the
 * active language (translated at call time, so callers re-render on a switch).
 */
export function formatRelative(ts, now = Date.now()) {
  const ms = toEpochMs(ts);
  if (ms === null) return i18n.t('common:status.never');
  const diff = Math.max(0, now - ms);
  if (diff < 10000) return i18n.t('equipment:relative.justNow');
  if (diff < 48 * 3600e3) return formatAgo(diff);
  return i18n.t('equipment:relative.daysAgo', { count: Math.round(diff / 86400e3) });
}

/**
 * One place that decides how a piece of equipment presents: rail, pill state,
 * LED fill and text. Status is shape + colour, never colour alone.
 *
 * @param {object} eq
 * @param {{ now?: number, formatSinceFn?: (d: Date, sameDay: boolean) => string }} opts
 */
export function getEquipmentPresentation(eq, opts = {}) {
  const now = opts.now ?? Date.now();
  const disabled = isEquipmentDisabled(eq);
  const stale = isEquipmentStale(eq, now);
  const status = eq?.status || 'unknown';
  // Translated at call time: every caller renders under useTranslation, so a
  // language switch re-runs this.
  const t = (key, opts) => i18n.t(key, opts);

  if (disabled) {
    return { key: 'disabled', rail: 'idle', pill: 'idle', filled: false, text: t('equipment:presentation.disabled'), dim: true, stale: false, disabled: true };
  }
  if (status === 'error') {
    return { key: 'error', rail: 'alarm', pill: 'alarm', filled: true, text: t('equipment:presentation.error'), dim: false, stale, disabled: false };
  }
  if (status === 'warning') {
    return { key: 'warning', rail: 'caution', pill: 'caution', filled: true, text: t('equipment:presentation.warning'), dim: false, stale, disabled: false };
  }
  if (stale) {
    const since = eq?.last_communication
      ? t('common:reading.notReportedSince', { time: formatSince(eq.last_communication, { now, format: opts.formatSinceFn }) })
      : t('equipment:presentation.neverReported');
    return { key: 'stale', rail: 'stale', pill: 'caution', filled: false, text: since, dim: false, stale: true, disabled: false };
  }
  if (status === 'online') {
    return { key: 'online', rail: 'ok', pill: 'ok', filled: true, text: t('equipment:presentation.online'), dim: false, stale: false, disabled: false };
  }
  if (status === 'offline') {
    return { key: 'offline', rail: 'alarm', pill: 'alarm', filled: false, text: t('equipment:presentation.offline'), dim: false, stale: false, disabled: false };
  }
  return { key: 'unknown', rail: 'idle', pill: 'idle', filled: false, text: t(`equipment:presentation.${status || 'unknown'}`, { defaultValue: status || t('equipment:presentation.unknown') }), dim: false, stale: false, disabled: false };
}

/** Coil mappings that can be controlled (coil + readwrite), as a normalised list. */
export function getCoilChannels(eq) {
  let list = eq?.register_mappings;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = []; }
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter(m => m && m.type === 'coil' && m.access === 'readwrite')
    .map((m, idx) => ({ ...m, index: idx, address: parseInt(m.register ?? m.address, 10) || idx }));
}

export const isRelayBoard = (eq) => eq?.protocol === 'modbus' && getCoilChannels(eq).length > 0;

/** Cached relay states from the poll read-back, `null` for any coil not present. */
export function parseCachedRelayStates(eq) {
  if (!eq?.last_reading) return {};
  try {
    const parsed = typeof eq.last_reading === 'string' ? JSON.parse(eq.last_reading) : eq.last_reading;
    const states = parsed?.relayStates;
    if (!states || typeof states !== 'object') return {};
    const out = {};
    Object.entries(states).forEach(([k, v]) => { out[String(k)] = v === true || v === 1; });
    return out;
  } catch {
    return {};
  }
}

/** "unverified" pill: scale/register inferred, not confirmed by a controlled read. */
export function UnverifiedPill({ className = '' }) {
  const { t } = useTranslation('equipment');
  const title = t('unverified.title');
  return (
    <span
      title={title}
      aria-label={title}
      data-testid="unverified-pill"
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0 text-[10px] font-bold uppercase tracking-wider whitespace-nowrap border-caution-300 text-caution-700 bg-caution-50 dark:border-caution-700 dark:text-caution-300 dark:bg-caution-900/40 ${className}`.trim()}
    >
      <svg className="h-2.5 w-2.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M10 2 1.5 17h17L10 2zm0 5a1 1 0 0 1 1 1v3a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1zm0 6.5a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2z" />
      </svg>
      {t('unverified.pill')}
    </span>
  );
}

/**
 * Relay LED: filled (on), hollow (off) or dashed (unknown). Shape carries the
 * state so it reads without colour.
 * state: true | false | null
 */
export function RelayLed({ state, pending = false, size = 'md', className = '' }) {
  const { t } = useTranslation('equipment');
  const dim = size === 'sm' ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5';
  let cls;
  let label;
  if (pending) {
    cls = 'border-2 border-state-caution bg-transparent animate-pulse';
    label = t('led.pending');
  } else if (state === true) {
    cls = 'border-2 border-state-ok bg-state-ok';
    label = t('led.on');
  } else if (state === false) {
    cls = 'border-2 border-state-idle bg-transparent';
    label = t('led.off');
  } else {
    cls = 'border-2 border-dashed border-state-caution bg-transparent';
    label = t('led.unknown');
  }
  return (
    <span
      role="img"
      aria-label={label}
      data-led={pending ? 'pending' : state === true ? 'on' : state === false ? 'off' : 'unknown'}
      className={`inline-block rounded-full shrink-0 ${dim} ${cls} ${className}`.trim()}
    />
  );
}
