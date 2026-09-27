import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../context/SettingsContext';

/**
 * Ticking device clock for the header: HH:MM:SS in mono (tabular, so it never
 * jitters) plus the configured timezone as "City GMT+4". Hidden below md.
 */
function makeFormatters(timezone) {
  const tz = timezone || 'UTC';
  try {
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const offset = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'shortOffset' });
    return { time, offset, tz };
  } catch {
    // Unknown IANA name (or old engine): fall back to the browser zone.
    const time = new Intl.DateTimeFormat('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return { time, offset: null, tz: null };
  }
}

// The city is the IANA zone id ("Dubai"): an identifier, shown untranslated.
function zoneLabel(tz, offsetFmt, date, localLabel) {
  const city = tz ? (tz.split('/').pop() || tz).replace(/_/g, ' ') : localLabel;
  let off = '';
  if (offsetFmt) {
    const part = offsetFmt.formatToParts(date).find((p) => p.type === 'timeZoneName');
    off = part ? part.value.replace('GMT', 'GMT') : '';
    if (off === 'GMT') off = 'GMT+0';
  }
  return off ? `${city} ${off}` : city;
}

export default function DeviceClock({ className = '' }) {
  const { timezone } = useSettings();
  const { t } = useTranslation('shell');
  const fmt = useMemo(() => makeFormatters(timezone), [timezone]);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Align to the next whole second, then tick every second.
    let interval;
    const timeout = setTimeout(() => {
      setNow(new Date());
      interval = setInterval(() => setNow(new Date()), 1000);
    }, 1000 - (Date.now() % 1000));
    return () => { clearTimeout(timeout); if (interval) clearInterval(interval); };
  }, []);

  // en-GB with hour12:false can yield "24:00:00" at midnight in some engines.
  const time = fmt.time.format(now).replace(/^24:/, '00:');
  const label = zoneLabel(fmt.tz, fmt.offset, now, t('clock.local'));

  return (
    <div
      dir="ltr"
      className={`hidden md:flex flex-col items-end leading-none shrink-0 ${className}`.trim()}
      title={t('clock.title', { zone: label })}
      aria-label={t('clock.aria', { time, zone: label })}
      data-testid="device-clock"
    >
      <span className="font-mono tabular text-sm font-medium text-ink" data-testid="device-clock-time">{time}</span>
      <span className="text-label uppercase text-muted mt-1">{label}</span>
    </div>
  );
}
