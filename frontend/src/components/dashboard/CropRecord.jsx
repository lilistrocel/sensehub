import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Label } from '../../ui';
import { API_BASE } from './constants';

/**
 * Compact one-line card of the crop assignment synced from the cloud. It is
 * labelled "Cloud crop record" because it is NOT local truth (it currently
 * reports a crop that is not in the greenhouse).
 */
export default function CropRecord({ token, formatDate, notifyError }) {
  const { t } = useTranslation('dashboard');
  const [crops, setCrops] = useState(null);

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    fetch(`${API_BASE}/crops`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => { if (!cancelled) setCrops(Array.isArray(data) ? data : []); })
      .catch((e) => { if (!cancelled) { setCrops([]); notifyError?.(t('crop.unavailable', { error: e.message }), 'crops'); } });
    return () => { cancelled = true; };
  }, [token, notifyError, t]);

  return (
    <Card rail="idle" padding="sm" data-testid="crop-record">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <Label as="span" className="!inline">{t('crop.title')}</Label>
        {crops === null ? (
          <span className="text-muted">{t('common:status.loadingShort')}</span>
        ) : crops.length === 0 ? (
          <span className="text-muted">{t('crop.noneSynced')}</span>
        ) : crops.map((c) => (
          <span key={c.sensehub_crop_id || c.id} className="inline-flex flex-wrap items-baseline gap-x-2 text-ink">
            <span className="font-semibold">{c.crop?.name || c.crop_name || t('crop.unnamed')}</span>
            {c.zone_name && <span className="text-muted">{c.zone_name}</span>}
            {c.current_stage && <span className="font-mono tabular text-xs text-muted">{c.current_stage}</span>}
            {c.timing?.planted_date && formatDate && (
              <span className="font-mono tabular text-xs text-muted">{t('crop.planted', { date: formatDate(c.timing.planted_date) })}</span>
            )}
          </span>
        ))}
        <span className="text-xs text-muted">{t('crop.notVerified')}</span>
      </div>
    </Card>
  );
}
