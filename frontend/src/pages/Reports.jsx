import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useSettings } from '../context/SettingsContext';
import { Card, Label, Reading, Kpi, Button, StatusPill, SectionHeader } from '../ui';
import ConsumptionTracker from '../components/reports/ConsumptionTracker';
import {
  SourceTag, SourceKpi, MeasuredDaySection, CalibrationHint, fmtL, fmtDev,
} from '../components/reports/MeasuredWater';
import { StatusMark } from '../components/agronomist/SectionStatus';

const API_BASE = '/api';

const formatDuration = (seconds) => {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

/** Farm-local "today" (report days are the farm's local days, not the browser's). */
const farmToday = (tz) => {
  try { return new Date().toLocaleDateString('en-CA', { timeZone: tz || undefined }); } catch (_) { return new Date().toLocaleDateString('en-CA'); }
};

const formatDate = (dateStr, tz) => {
  const d = new Date(dateStr + 'T12:00:00Z');
  const today = farmToday(tz);
  const y = new Date(today + 'T12:00:00Z');
  y.setUTCDate(y.getUTCDate() - 1);
  if (dateStr === today) return 'Today';
  if (dateStr === y.toISOString().slice(0, 10)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
};

/** What a day row shows for water / fertigation: measured when the monitor has it, else the estimate. */
function dayFigures(day) {
  const m = day.measured;
  const cmp = m && m.available ? m.comparison : null;
  const water = cmp && cmp.water.measured_liters !== null
    ? { liters: cmp.water.measured_liters, measured: true }
    : { liters: day.water.total_liters || 0, measured: false };
  const fert = cmp && cmp.fertigation.measured_liters !== null
    ? { liters: cmp.fertigation.measured_liters, measured: true }
    : { liters: day.fertigation.total_liters || 0, measured: false };
  const partial = !!(m && m.available && !m.coverage.complete);
  const flags = cmp ? cmp.flags.length : 0;
  return { water, fert, partial, coverage: m && m.available ? m.coverage : null, flags };
}

/** Split litres into { value, unit, precision } so Reading can render mono + tabular. */
const liters = (l, small = false) => {
  const v = Number(l) || 0;
  if (v >= 1000) return { value: v / 1000, unit: 'm³', precision: 1 };
  if (small && v < 100) return { value: v, unit: 'L', precision: 1 };
  return { value: Math.round(v), unit: 'L', precision: 0 };
};

const kwh = (v) => {
  const n = Number(v) || 0;
  if (n >= 1000) return { value: n / 1000, unit: 'MWh', precision: 2 };
  return { value: n, unit: 'kWh', precision: n < 10 ? 2 : 1 };
};

const selectCls = 'min-h-touch px-3 py-2 bg-field text-ink border border-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500';

function Bar({ fraction, tone }) {
  const pct = Math.max(0, Math.min(100, (fraction || 0) * 100));
  return (
    <div className="flex-1 bg-field rounded-full h-3 overflow-hidden" aria-hidden="true">
      <div className={`${tone} h-full rounded-full transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function dayRail(day) {
  if (day.drift_events > 0 || day.automations.failures > 0) return 'alarm';
  if (day.automations.skipped_actions > 0) return 'caution';
  if (day.measured?.available && day.measured.comparison.flags.length > 0) return 'caution';
  return 'idle';
}

/** Short source marker for the compact day row, with a caution mark when the monitor covered only part of the day. */
function RowSource({ fig, coverage }) {
  return (
    <span className="inline-flex items-center gap-1 w-14 sm:w-16 shrink-0">
      <SourceTag measured={fig.measured} short />
      {fig.measured && coverage && !coverage.complete && (
        <span title={`Monitor covered ${Math.round(coverage.fraction * 100)} % of this day`}>
          <StatusMark status="caution" label={false} />
          <span className="sr-only">partial day</span>
        </span>
      )}
    </span>
  );
}

export default function Reports() {
  const { token, user } = useAuth();
  const { showError } = useToast();
  const { formatDateTime } = useSettings();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [days, setDays] = useState(7);
  const [expandedDay, setExpandedDay] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const headers = { Authorization: `Bearer ${token}` };
  const canControl = user?.role === 'admin' || user?.role === 'operator';

  const fetchReport = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/reports/daily?days=${days}`, { headers });
      if (!res.ok) throw new Error(`Failed to load reports (HTTP ${res.status})`);
      setData(await res.json());
    } catch (err) {
      const msg = err.message || 'Failed to load reports';
      setError(msg);
      showError(msg);
    } finally {
      setLoading(false);
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchReport(); }, [days]);

  const refreshAll = () => { fetchReport(); setRefreshKey((k) => k + 1); };

  // Totals across all days
  const totals = data?.report?.reduce((acc, d) => ({
    water_seconds: acc.water_seconds + d.water.total_seconds,
    water_liters: acc.water_liters + (d.water.total_liters || 0),
    fert_seconds: acc.fert_seconds + d.fertigation.total_seconds,
    fert_liters: acc.fert_liters + (d.fertigation.total_liters || 0),
    water_events: acc.water_events + d.water.events,
    fert_events: acc.fert_events + d.fertigation.events,
    auto_runs: acc.auto_runs + d.automations.total_runs,
    failures: acc.failures + d.automations.failures,
    skipped: acc.skipped + d.automations.skipped_actions,
    drift: acc.drift + d.drift_events,
    power_kwh: acc.power_kwh + (d.power?.total_kwh || 0),
  }), { water_seconds: 0, water_liters: 0, fert_seconds: 0, fert_liters: 0, water_events: 0, fert_events: 0, auto_runs: 0, failures: 0, skipped: 0, drift: 0, power_kwh: 0 });

  // Max values for bar scaling
  const figures = data?.report ? Object.fromEntries(data.report.map(d => [d.date, dayFigures(d)])) : {};
  const maxWater = data?.report ? Math.max(...data.report.map(d => figures[d.date].water.liters), 1) : 1;
  const maxFert = data?.report ? Math.max(...data.report.map(d => figures[d.date].fert.liters), 1) : 1;
  const mt = data?.measured_totals;
  const hasMeasured = (mt?.days_with_measurement || 0) > 0;
  const devStatus = (dev) => (dev !== null && dev !== undefined && Math.abs(dev) > (mt?.threshold_pct ?? 15) ? 'caution' : 'ok');
  const maxPower = data?.report ? Math.max(...data.report.map(d => d.power?.total_kwh || 0), 1) : 1;

  // Per-meter totals across the period
  const meterTotals = (() => {
    if (!data?.power_meters?.length || !data.report) return [];
    return data.power_meters.map(pm => {
      const total = data.report.reduce((acc, d) => acc + (d.power?.by_meter?.[pm.equipment_id]?.kwh || 0), 0);
      return { ...pm, total_kwh: Math.round(total * 100) / 100 };
    });
  })();

  const tw = totals ? liters(totals.water_liters) : null;
  const tf = totals ? liters(totals.fert_liters) : null;
  const tp = totals ? kwh(totals.power_kwh) : null;

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-5 flex-wrap gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold text-ink">Daily Reports</h1>
          <p className="text-sm text-muted mt-1">Irrigation, fertigation, power and automation summary</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={days} onChange={e => setDays(parseInt(e.target.value))} className={selectCls} aria-label="Period">
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
          </select>
          <Button variant="ghost" size="sm" onClick={refreshAll} disabled={loading}>Refresh</Button>
        </div>
      </div>

      {loading && !data ? (
        <div className="text-center py-12 text-muted">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600 mx-auto mb-2" />
          Loading reports…
        </div>
      ) : error && !data ? (
        <Card rail="alarm" className="text-center py-8">
          <p className="font-semibold text-ink">Could not load reports</p>
          <p className="text-sm text-muted mt-1">{error}</p>
          <Button variant="secondary" size="sm" className="mt-4" onClick={fetchReport} disabled={loading}>Retry</Button>
        </Card>
      ) : data && (!data.report || data.report.length === 0) ? (
        <Card className="text-center py-12">
          <p className="text-ink text-lg">No report data for this period</p>
          <p className="text-sm text-muted mt-1">Try selecting a longer date range, or check back once automations have run.</p>
        </Card>
      ) : data && (
        <>
          {/* Period totals */}
          {totals && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6" data-testid="report-kpis">
              {hasMeasured ? (
                <SourceKpi label="Water" rail="water" measured value={liters(mt.water.measured_liters)}
                  status={devStatus(mt.water.deviation_pct)}
                  secondary={`est. ${fmtL(mt.water.estimated_liters)} same window · ${fmtDev(mt.water.deviation_pct)}`}
                  hint={`${mt.days_with_measurement} of ${data.report.length} days measured · ${data.report.length}-day estimate ${fmtL(totals.water_liters)}`} />
              ) : (
                <SourceKpi label="Total water" rail="water" measured={false} value={tw}
                  secondary={`${formatDuration(totals.water_seconds)} runtime · ${totals.water_events} cycles`} />
              )}
              {hasMeasured ? (
                <SourceKpi label="Fertigation" rail="water" measured value={liters(mt.fertigation.measured_liters, true)}
                  status={devStatus(mt.fertigation.deviation_pct)}
                  secondary={`est. ${fmtL(mt.fertigation.estimated_liters)} same window · ${fmtDev(mt.fertigation.deviation_pct)}`}
                  hint={`metered tanks · ${data.report.length}-day estimate ${fmtL(totals.fert_liters)}`} />
              ) : (
                <SourceKpi label="Total fertigation" rail="water" measured={false} value={tf}
                  secondary={`${formatDuration(totals.fert_seconds)} runtime · ${totals.fert_events} cycles`} />
              )}
              <Kpi label="Total power" rail="lighting" value={tp.value} unit={tp.unit} precision={tp.precision}
                hint={`${meterTotals.length} meter${meterTotals.length === 1 ? '' : 's'} imported`} />
              <Kpi label="Skipped by EC" rail={totals.skipped > 0 ? 'caution' : 'idle'} value={totals.skipped} precision={0}
                hint="actions blocked by dependency" />
              <Kpi label="Relay drift" rail={totals.drift > 0 ? 'alarm' : 'idle'} value={totals.drift} precision={0}
                hint="hardware mismatches" />
            </div>
          )}

          {/* Daily breakdown */}
          <div className="space-y-2" data-testid="report-days">
            {data.report.map((day) => {
              const open = expandedDay === day.date;
              const fig = figures[day.date];
              const w = liters(day.water.total_liters);
              const f = liters(day.fertigation.total_liters);
              const rw = liters(fig.water.liters);
              const rf = liters(fig.fert.liters, true);
              return (
                <Card key={day.date} rail={dayRail(day)} padding="none" className="overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setExpandedDay(open ? null : day.date)}
                    aria-expanded={open}
                    className="w-full px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2 hover:bg-field transition-colors text-left"
                  >
                    <div className="w-28 shrink-0">
                      <p className="font-display text-sm font-semibold text-ink">{formatDate(day.date, data.timezone)}</p>
                      <p className="text-xs font-mono tabular text-muted">{day.date}</p>
                    </div>

                    <div className="flex-1 min-w-[12rem] space-y-1.5">
                      <div className="flex items-center gap-2">
                        <Label className="w-5 shrink-0">W</Label>
                        <Reading size="sm" value={rw.value} unit={rw.unit} precision={rw.precision} className="w-20 sm:w-24 justify-end" />
                        <RowSource fig={fig.water} coverage={fig.coverage} />
                        <Bar fraction={fig.water.liters / maxWater} tone="bg-state-water" />
                      </div>
                      <div className="flex items-center gap-2">
                        <Label className="w-5 shrink-0">F</Label>
                        <Reading size="sm" value={rf.value} unit={rf.unit} precision={rf.precision} className="w-20 sm:w-24 justify-end" />
                        <RowSource fig={fig.fert} coverage={fig.coverage} />
                        <Bar fraction={fig.fert.liters / maxFert} tone="bg-water-600 dark:bg-water-300" />
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      {Array.isArray(day.measured?.runs) && day.measured.runs.length > 0 && (
                        <span className="text-xs text-muted font-mono tabular" data-testid="day-runs-count">
                          {day.measured.runs.length} run{day.measured.runs.length === 1 ? '' : 's'}
                          {day.measured.runs.some(r => r.type !== 'automated') && `, ${day.measured.runs.filter(r => r.type !== 'automated').length} manual`}
                        </span>
                      )}
                      {fig.flags > 0 && (
                        <StatusPill state="caution" filled>{fig.flags} flag{fig.flags === 1 ? '' : 's'}</StatusPill>
                      )}
                      {day.automations.skipped_actions > 0 && (
                        <StatusPill state="caution">{day.automations.skipped_actions} skipped</StatusPill>
                      )}
                      {day.drift_events > 0 && (
                        <StatusPill state="alarm" filled>{day.drift_events} drift</StatusPill>
                      )}
                      {day.automations.failures > 0 && (
                        <StatusPill state="alarm" filled>{day.automations.failures} fail</StatusPill>
                      )}
                      <svg className={`w-4 h-4 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </button>

                  {open && (
                    <div className="px-4 pb-4 border-t border-line">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-3">
                        {/* Water detail */}
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <Label className="min-w-0">Water · {data.water_equipment?.name}</Label>
                            <SourceTag measured={false} />
                          </div>
                          <Reading value={w.value} unit={w.unit} precision={w.precision} />
                          <p className="text-xs text-muted">{formatDuration(day.water.total_seconds)} runtime, {day.water.events} cycles</p>
                          {Object.keys(day.water.channel_details || {}).length > 0 && (
                            <div className="mt-2 space-y-1">
                              {Object.entries(day.water.channel_details).sort(([a], [b]) => a - b).map(([ch, d]) => (
                                <div key={ch} className="flex items-center justify-between text-xs bg-field rounded px-2 py-1">
                                  <span className="text-muted">
                                    Ch {ch} {d.ingredient && <span className="text-ink">({d.ingredient})</span>}
                                  </span>
                                  <span className="font-mono tabular text-ink">
                                    {liters(d.liters).value}{liters(d.liters).unit === 'm³' ? ' m³' : ' L'} <span className="text-muted">({formatDuration(d.seconds)})</span>
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Fertigation detail */}
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <Label className="min-w-0">Fertigation · {data.fertigation_equipment?.name}</Label>
                            <SourceTag measured={false} />
                          </div>
                          <Reading value={f.value} unit={f.unit} precision={f.precision} />
                          <p className="text-xs text-muted">{formatDuration(day.fertigation.total_seconds)} runtime, {day.fertigation.events} cycles</p>
                          {Object.keys(day.fertigation.channel_details || {}).length > 0 && (
                            <div className="mt-2 space-y-1">
                              {Object.entries(day.fertigation.channel_details).sort(([a], [b]) => a - b).map(([ch, d]) => (
                                <div key={ch} className="text-xs bg-field rounded px-2 py-1.5">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-muted min-w-0">
                                      Ch {ch}
                                      {d.mixture && <span className="text-ink font-medium ml-1">{d.mixture}</span>}
                                      {d.ingredient && !d.mixture && <span className="text-ink ml-1">({d.ingredient})</span>}
                                    </span>
                                    <span className="font-mono tabular text-ink shrink-0">{liters(d.liters).value} {liters(d.liters).unit}</span>
                                  </div>
                                  <div className="text-xs font-mono tabular text-muted mt-0.5">
                                    {formatDuration(d.seconds)} @ {d.flow_rate} {d.flow_unit}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Automations detail */}
                        <div>
                          <Label className="mb-1">Automations</Label>
                          <dl className="space-y-1 text-xs">
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted">Total runs</dt>
                              <dd className="font-mono tabular text-ink">{day.automations.total_runs}</dd>
                            </div>
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted">Failures</dt>
                              <dd className={`font-mono tabular ${day.automations.failures > 0 ? 'text-alarm-600 dark:text-alarm-300' : 'text-ink'}`}>{day.automations.failures}</dd>
                            </div>
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted">Skipped by dependency</dt>
                              <dd className={`font-mono tabular text-right ${day.automations.skipped_actions > 0 ? 'text-caution-700 dark:text-caution-300' : 'text-ink'}`}>
                                {day.automations.skipped_actions} actions in {day.automations.skipped_runs} runs
                              </dd>
                            </div>
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted">Relay drift events</dt>
                              <dd className={`font-mono tabular ${day.drift_events > 0 ? 'text-alarm-600 dark:text-alarm-300' : 'text-ink'}`}>{day.drift_events}</dd>
                            </div>
                          </dl>
                        </div>
                      </div>
                      <MeasuredDaySection day={day} data={data} />
                    </div>
                  )}
                </Card>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mt-3 text-xs text-muted">
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-state-water" aria-hidden="true" /> W · Water ({data.water_equipment?.name || 'irrigation'})</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-water-600 dark:bg-water-300" aria-hidden="true" /> F · Fertigation ({data.fertigation_equipment?.name || 'fertigation'})</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-state-lighting" aria-hidden="true" /> Power (imported kWh)</span>
            <span className="flex items-center gap-1.5"><SourceTag measured short /> {data.monitor?.name || 'irrigation monitor'}</span>
            <span className="flex items-center gap-1.5"><SourceTag measured={false} short /> relay ON-time × configured flow</span>
          </div>

          {data.monitor && (
            <CalibrationHint calibration={data.calibration} remapAt={data.fertigation_relay_remap_at} tz={data.timezone} />
          )}

          {/* Power consumption — per meter, per day */}
          {meterTotals.length > 0 && (
            <section className="mt-8" data-testid="power-section">
              <SectionHeader
                title="Power consumption"
                subtitle="Daily energy imported per meter, from the cumulative kWh counter"
              />

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-4">
                {meterTotals.map(m => {
                  const k = kwh(m.total_kwh);
                  return (
                    <Kpi key={m.equipment_id} label={m.name} rail="lighting" size="sm" padding="sm"
                      value={k.value} unit={k.unit} precision={k.precision} hint={`total over ${days} days`} />
                  );
                })}
              </div>

              <Card padding="none" className="overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-field">
                      <tr>
                        <th className="px-3 py-2 text-left w-28">Date</th>
                        {meterTotals.map(m => (
                          <th key={m.equipment_id} className="px-3 py-2 text-left">{m.name}</th>
                        ))}
                        <th className="px-3 py-2 text-right w-28">Day total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {data.report.map(day => {
                        const dayTotal = day.power?.total_kwh || 0;
                        const dt = kwh(dayTotal);
                        return (
                          <tr key={day.date}>
                            <td className="px-3 py-2 align-top">
                              <p className="text-xs font-semibold text-ink">{formatDate(day.date, data.timezone)}</p>
                              <p className="text-xs font-mono tabular text-muted">{day.date}</p>
                            </td>
                            {meterTotals.map(m => {
                              const cell = day.power?.by_meter?.[m.equipment_id];
                              const v = cell?.kwh || 0;
                              const k = kwh(v);
                              return (
                                <td key={m.equipment_id} className="px-3 py-2 align-middle">
                                  <div className="flex items-center gap-2">
                                    <Reading size="sm" value={k.value} unit={k.unit} precision={k.precision} className="w-24 justify-end" />
                                    <Bar fraction={maxPower ? v / maxPower : 0} tone="bg-state-lighting" />
                                  </div>
                                </td>
                              );
                            })}
                            <td className="px-3 py-2 text-right">
                              <Reading size="sm" value={dt.value} unit={dt.unit} precision={dt.precision} className="font-semibold" />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            </section>
          )}

          {/* Energy consumption tracker (moved from the Dashboard) */}
          <ConsumptionTracker
            token={token}
            canControl={canControl}
            showError={showError}
            formatDateTime={formatDateTime}
            refreshKey={refreshKey}
          />
        </>
      )}
    </div>
  );
}
