import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Chart, Label } from '../../ui';
import { toEpochMs } from '../../utils/freshness';
import { API_BASE, TREND_CHARTS, TRENDS_POLL_MS } from './constants';
import { usePoll } from '../../hooks/usePoll';

/**
 * Chart series from /api/dashboard/overview chartReadings, refetched on range
 * change and every 5 minutes. Rows: { equipment_id, name, unit, timestamp, value }.
 */
export function useTrendSeries({ token, hours, notifyError }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);

  const fetchRows = useCallback(async () => {
    if (!token || inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await fetch(`${API_BASE}/dashboard/overview?hours=${encodeURIComponent(hours)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setRows(Array.isArray(data.chartReadings) ? data.chartReadings : []);
    } catch (e) {
      notifyError?.(`Trend data unavailable: ${e.message}`, 'trends');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [token, hours, notifyError]);

  useEffect(() => { setLoading(true); }, [fetchRows]);
  usePoll(fetchRows, TRENDS_POLL_MS);

  return { rows, loading, refresh: fetchRows };
}

/** Build the series for each chart from raw rows; disabled equipment is dropped. */
export function buildTrendCharts(rows, disabledDevices = []) {
  const disabled = new Set((disabledDevices || []).map(Number));
  const index = new Map();
  (rows || []).forEach((r) => {
    const t = toEpochMs(r.timestamp);
    const v = Number(r.value);
    if (t === null || !Number.isFinite(v)) return;
    const k = `${r.equipment_id}|${r.name || ''}`;
    if (!index.has(k)) index.set(k, { unit: r.unit || '', points: [] });
    index.get(k).points.push({ t, v });
  });
  return TREND_CHARTS.map((chart) => ({
    key: chart.key,
    title: chart.title,
    series: chart.series
      .filter((s) => !disabled.has(Number(s.equipment_id)))
      .map((s) => {
        const found = index.get(`${s.equipment_id}|${s.metric}`);
        return { key: s.key, label: s.label, tone: s.tone, unit: found?.unit || '', points: found?.points || [] };
      }),
  }));
}

export default function TrendsPanel({ rows, hours, disabledDevices, timezone, loading }) {
  const charts = useMemo(() => buildTrendCharts(rows, disabledDevices), [rows, disabledDevices]);
  const domain = useMemo(() => {
    const end = Date.now();
    return [end - Number(hours) * 3600 * 1000, end];
  }, [hours, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const long = Number(hours) > 48;
  const formatTime = useMemo(() => {
    const tz = timezone || 'UTC';
    const short = new Intl.DateTimeFormat('en-GB', long ? { timeZone: tz, day: 'numeric', month: 'short' } : { timeZone: tz, hour: '2-digit', minute: '2-digit' });
    const full = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return (ms, opts) => (opts && opts.long ? full : short).format(new Date(ms));
  }, [timezone, long]);

  return (
    <div className={`grid grid-cols-1 xl:grid-cols-2 gap-4 ${loading ? 'opacity-70' : ''}`} data-testid="trends">
      {charts.map((c, i) => (
        <Card key={c.key} padding="sm" className={i === 0 ? 'xl:col-span-2' : ''}>
          <Label className="mb-2">{c.title}</Label>
          <Chart series={c.series} domain={domain} formatTime={formatTime} panelHeight={i === 0 ? 140 : 150} precision={c.key === 'pore_ec' ? 0 : 1} />
        </Card>
      ))}
    </div>
  );
}
