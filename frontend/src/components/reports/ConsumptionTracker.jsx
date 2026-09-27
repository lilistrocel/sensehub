import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Card, Label, Reading, Button, SectionHeader } from '../../ui';
import { formatWithUnit } from '../../i18n/format';
import { formatScaled } from '../../utils/unitScaling';

const API_BASE = '/api';

/**
 * Energy Consumption Tracker (moved here from the Dashboard). Same API:
 *   GET    /api/baselines/active                      active trackers with live delta
 *   POST   /api/baselines/equipment/:id {metric_name} capture the current reading as baseline
 *   DELETE /api/baselines/:id                          stop tracking
 * Trackable meters come from the dashboard overview's latestReadings (kWh units),
 * exactly as the Dashboard widget derived them.
 */
export default function ConsumptionTracker({ token, canControl, showError, formatDateTime, refreshKey = 0 }) {
  const { t } = useTranslation('reports');
  const [baselines, setBaselines] = useState([]);
  const [readings, setReadings] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const fetchBaselines = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/baselines/active`, { headers });
      if (r.ok) setBaselines(await r.json());
      else if (r.status >= 500) showError?.(t('consumption.loadFailed'));
    } catch {
      showError?.(t('consumption.loadFailed'));
    } finally {
      setLoaded(true);
    }
  }, [headers, showError, t]);

  const fetchReadings = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/dashboard/overview?hours=1`, { headers });
      if (!r.ok) return;
      const data = await r.json();
      setReadings(Array.isArray(data.latestReadings) ? data.latestReadings : []);
    } catch {
      // trackable list is a convenience; the baselines themselves still render
    }
  }, [headers]);

  useEffect(() => {
    if (!token) return;
    fetchBaselines();
    fetchReadings();
  }, [token, fetchBaselines, fetchReadings, refreshKey]);

  const addBaseline = async (equipmentId, metricName) => {
    try {
      const r = await fetch(`${API_BASE}/baselines/equipment/${equipmentId}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ metric_name: metricName, label: null }),
      });
      if (r.ok) { await fetchBaselines(); setShowAdd(false); }
      else {
        const err = await r.json().catch(() => ({}));
        showError?.(err.error || err.message || t('consumption.addFailed'));
      }
    } catch {
      showError?.(t('consumption.addFailed'));
    }
  };

  const removeBaseline = async (id) => {
    try {
      const r = await fetch(`${API_BASE}/baselines/${id}`, { method: 'DELETE', headers });
      if (!r.ok) showError?.(t('consumption.removeFailed'));
      await fetchBaselines();
    } catch {
      showError?.(t('consumption.removeFailed'));
    }
  };

  const readingByKey = useMemo(() => {
    const m = {};
    for (const r of readings) m[`${r.equipment_id}|${r.name || ''}`] = r;
    return m;
  }, [readings]);

  const trackableOptions = useMemo(() => {
    const taken = new Set(baselines.map((b) => `${b.equipment_id}|${b.metric_name}`));
    return readings
      .filter((r) => r.unit === 'kWh' && !taken.has(`${r.equipment_id}|${r.name || ''}`))
      .map((r) => ({
        equipment_id: r.equipment_id,
        equipment_name: r.equipment_name,
        metric_name: r.name || '',
        current_value: r.value,
        unit: r.unit,
      }));
  }, [readings, baselines]);

  if (loaded && baselines.length === 0 && trackableOptions.length === 0) return null;

  return (
    <section className="mt-8" data-testid="consumption-tracker">
      <SectionHeader
        title={t('consumption.title')}
        subtitle={t('consumption.subtitle')}
        right={canControl && trackableOptions.length > 0 && (
          <Button variant="secondary" size="sm" onClick={() => setShowAdd((v) => !v)}>
            {showAdd ? t('common:actions.cancel') : t('consumption.trackMeter')}
          </Button>
        )}
      />

      {showAdd && trackableOptions.length > 0 && (
        <Card padding="sm" className="mb-3">
          <Label className="mb-2">{t('consumption.pickMeter')}</Label>
          <div className="flex flex-wrap gap-2">
            {trackableOptions.map((opt) => (
              <Button
                key={`${opt.equipment_id}|${opt.metric_name}`}
                variant="secondary"
                size="sm"
                onClick={() => addBaseline(opt.equipment_id, opt.metric_name)}
                title={t('consumption.captureTitle', {
                  value: typeof opt.current_value === 'number'
                    ? formatWithUnit(opt.current_value, opt.unit, { decimals: 3 })
                    : `${opt.current_value ?? '—'} ${opt.unit}`,
                })}
              >
                <span className="font-semibold" dir="auto">{opt.equipment_name}</span>
                <span className="text-muted" dir="auto">· {opt.metric_name}</span>
              </Button>
            ))}
          </div>
        </Card>
      )}

      {baselines.length === 0 ? (
        <Card className="text-center text-sm text-muted py-6">
          <Trans t={t} i18nKey="consumption.empty" components={{ b: <span className="font-semibold text-ink" /> }} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {baselines.map((b) => {
            const live = readingByKey[`${b.equipment_id}|${b.metric_name}`];
            const current = live && typeof live.value === 'number' ? live.value : b.current_value;
            const delta = (typeof current === 'number' && typeof b.baseline_value === 'number')
              ? current - b.baseline_value
              : (typeof b.delta === 'number' ? b.delta : null);
            const scaled = delta !== null ? formatScaled(delta, b.unit || 'kWh') : null;
            return (
              <Card key={b.id} rail="lighting" padding="md">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Label className="truncate" title={b.equipment_name} dir="auto">{b.equipment_name}</Label>
                    <p className="text-xs text-muted mt-0.5" dir="auto">{b.metric_name}</p>
                  </div>
                  {canControl && (
                    <Button variant="danger-ghost" size="sm" onClick={() => removeBaseline(b.id)} title={t('consumption.stopTrackingTitle')}>
                      {t('consumption.stopTracking')}
                    </Button>
                  )}
                </div>
                <div className="mt-2">
                  <Reading
                    size="lg"
                    value={scaled ? scaled.value : null}
                    unit={scaled ? scaled.unit : (b.unit || 'kWh')}
                    unknown={!scaled}
                    since={b.current_timestamp}
                  />
                </div>
                <p className="text-xs text-muted mt-2 flex flex-wrap justify-between gap-x-2 font-mono tabular">
                  <span>{t('consumption.since', { time: b.created_at ? (formatDateTime ? formatDateTime(b.created_at) : b.created_at) : '—' })}</span>
                  <span>{t('consumption.base', {
                    value: typeof b.baseline_value === 'number'
                      ? formatWithUnit(b.baseline_value, b.unit || 'kWh', { decimals: 2 })
                      : `${b.baseline_value ?? '—'} ${b.unit || 'kWh'}`,
                  })}</span>
                </p>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
