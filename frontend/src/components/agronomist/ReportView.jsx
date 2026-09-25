import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Card, Label, StatusPill } from '../../ui';
import { FrameStrip } from './CaptureStrip';
import ClarificationsPanel from './ClarificationsPanel';
import ReportActions, { RecommendationCard, groupRecommendations } from './ReportActions';
import ReportMarkdown from './ReportMarkdown';
import ReportTabs, { tabPanelProps } from './ReportTabs';
import { splitReportSections } from './splitReportSections';

const API_BASE = '/api';
const TAB_KEY = 'agronomist:reportTab';
const TOP_ACTIONS = 3;

export const ERROR_CLASS_LABELS = { billing: 'billing', auth: 'auth', rate_limit: 'rate limit', other: 'error' };
const CAPTURE_MODE_LABELS = {
  noon: 'noon session', manual: 'manual capture', fallback_4h: '4-hourly fallback',
  latest: 'latest available', manual_night: 'manual capture (night)',
};

const readTab = () => { try { return localStorage.getItem(TAB_KEY) || 'overview'; } catch { return 'overview'; } };
const writeTab = (id) => { try { localStorage.setItem(TAB_KEY, id); } catch { /* private mode etc. */ } };

// generated_at is SQLite datetime('now'): UTC without a zone marker.
function fmtGenerated(s) {
  if (!s) return '';
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${String(s).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Whole days between a YYYY-MM-DD report date and today (local). */
function ageDays(reportDate) {
  const today = new Date();
  const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const [y, m, d] = String(reportDate || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return Math.round((t - Date.UTC(y, m - 1, d)) / 86400000);
}

function dayName(reportDate) {
  const [y, m, d] = String(reportDate || '').split('-').map(Number);
  if (!y) return '';
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short' });
}

// Text-only markers for <option> (no pills possible): square = failed, triangle = caution.
function optionLabel(r) {
  let s = `${r.report_date} · ${dayName(r.report_date)}`;
  if (r.status === 'failure') s += ` ■ failed (${ERROR_CLASS_LABELS[r.error_class] || 'error'})`;
  else if (r.excluded_sources?.length) s += ` ▲ ${r.excluded_sources.length} excluded`;
  return s;
}

/**
 * Operator tasks the agronomist created, for the Actions tab. The tasks API has
 * no report filter, so fetch the agronomist's tasks once and match on
 * source_report_id; refetched whenever the page reloads its report list
 * (generate / retry / regenerate create new tasks).
 */
function useAgronomistTasks(headers, refreshKey) {
  const [state, setState] = useState({ tasks: null, error: null });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/operator-tasks?status=all&source=agronomist&limit=500`, { headers });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!cancelled) setState({ tasks: Array.isArray(data) ? data : [], error: null });
      } catch (err) {
        if (!cancelled) setState({ tasks: null, error: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

function ChevronIcon({ dir }) {
  return (
    <svg aria-hidden="true" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d={dir === 'left' ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7'} />
    </svg>
  );
}

/** Date navigation + opinion headline + state pills. Works for failed reports too. */
function ReportHeader({ report, reports, excluded, onSelect, pending }) {
  const idx = reports.findIndex(r => r.id === report.id);
  const older = idx >= 0 ? reports[idx + 1] : reports[0];
  const newer = idx > 0 ? reports[idx - 1] : null;
  const age = ageDays(report.report_date);
  const isLatest = idx === 0;
  const failed = report.status === 'failure';

  return (
    <Card padding="sm" data-testid="report-header" aria-busy={pending ? 'true' : 'false'}>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          onClick={() => older && onSelect(older.id)}
          disabled={!older}
          aria-label={older ? `Older report, ${older.report_date}` : 'No older report'}
          title={older ? `Older: ${older.report_date}` : 'No older report'}
          className="!px-2.5 shrink-0"
          data-testid="report-prev"
        >
          <ChevronIcon dir="left" />
        </Button>
        <label htmlFor="report-date-select" className="sr-only">Report date</label>
        <select
          id="report-date-select"
          value={report.id}
          onChange={e => onSelect(Number(e.target.value))}
          className="min-w-0 flex-1 sm:flex-none sm:w-80 min-h-touch font-mono text-sm"
          data-testid="report-date-select"
        >
          {idx < 0 && <option value={report.id}>{optionLabel(report)}</option>}
          {reports.map(r => <option key={r.id} value={r.id}>{optionLabel(r)}</option>)}
        </select>
        <Button
          variant="secondary"
          onClick={() => newer && onSelect(newer.id)}
          disabled={!newer}
          aria-label={newer ? `Newer report, ${newer.report_date}` : 'No newer report'}
          title={newer ? `Newer: ${newer.report_date}` : 'This is the latest report'}
          className="!px-2.5 shrink-0"
          data-testid="report-next"
        >
          <ChevronIcon dir="right" />
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {failed && (
          <StatusPill state="alarm" filled text={`failed · ${ERROR_CLASS_LABELS[report.error_class] || 'error'}`} />
        )}
        {!isLatest && idx >= 0 && <StatusPill state="idle" text="older report" title="A newer report exists — use the right arrow" />}
        {isLatest && age != null && age >= 2 && (
          <StatusPill state="caution" text={`${age} days old`} title="No newer report has been generated" />
        )}
        {excluded.length > 0 && (
          <StatusPill
            state="caution"
            filled
            className="max-w-full !whitespace-normal"
            text={`${excluded.length} source${excluded.length === 1 ? '' : 's'} excluded`}
            title={`Out of service when this report was built: ${excluded.join(', ')}`}
            data-testid="report-excluded"
          />
        )}
        {report.generated_at && (
          <span className="font-mono text-xs text-muted">generated {fmtGenerated(report.generated_at)}</span>
        )}
        {pending && <StatusPill state="idle" pulse text="loading" />}
      </div>

      {!failed && report.opinion && (
        <p className="mt-3 font-display text-[17px] sm:text-xl font-semibold leading-snug text-ink break-words max-w-3xl" data-testid="report-opinion">
          {report.opinion}
        </p>
      )}
    </Card>
  );
}

function FailureCard({ report }) {
  return (
    <Card rail="alarm" data-testid="report-failure">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-base font-semibold text-ink">Generation failed for {report.report_date}</h2>
        <StatusPill state="alarm" filled text={ERROR_CLASS_LABELS[report.error_class] || report.error_class || 'error'} />
      </div>
      <p className="mt-1 text-sm text-muted">No analysis was produced for this day. The error below is what the provider returned.</p>
      {report.error && (
        <pre className="mt-3 p-3 text-xs font-mono whitespace-pre-wrap break-words bg-field border border-line rounded-md text-ink max-h-64 overflow-y-auto">{report.error}</pre>
      )}
    </Card>
  );
}

function Overview({ report, intro, chips, onOpenTab, taskCount }) {
  const frames = report.captures?.length ? report.captures : report.capture ? [report.capture] : [];
  const recs = report.recommendations || [];
  const top = groupRecommendations(recs)
    .filter(g => g.priority === 'critical' || g.priority === 'high')
    .flatMap(g => g.items)
    .slice(0, TOP_ACTIONS);
  const hasText = !!(report.summary || intro);

  return (
    <div className="space-y-4">
      {frames.length > 0 && (
        <Card data-testid="report-frames">
          <div className="flex flex-wrap items-baseline gap-x-2 mb-2">
            <Label as="h3">Canopy frames used</Label>
            {report.capture_mode && (
              <span className="text-xs text-muted">{CAPTURE_MODE_LABELS[report.capture_mode] || report.capture_mode}</span>
            )}
          </div>
          <FrameStrip frames={frames} bestId={report.capture_id ?? report.capture?.id ?? null} />
          {report.photo_line && <p className="mt-2 text-sm text-muted max-w-prose break-words">{report.photo_line}</p>}
        </Card>
      )}

      <Card data-testid="report-summary">
        <Label as="h3" className="mb-2">Summary</Label>
        {report.summary && <p className="max-w-prose text-[15px] leading-7 text-ink break-words">{report.summary}</p>}
        {intro && <ReportMarkdown markdown={intro} className={report.summary ? 'mt-3' : ''} />}
        {!hasText && <p className="text-sm text-muted">This report has no summary text.</p>}

        {chips.length > 0 && (
          <div className="mt-4 pt-3 border-t border-line">
            <Label className="mb-2">Read the report</Label>
            <div className="flex flex-wrap gap-2">
              {chips.map(s => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => onOpenTab(s.key)}
                  className="min-h-[36px] px-3 rounded-full border border-line bg-field text-sm font-semibold text-ink hover:border-brand-500 hover:text-brand"
                  title={s.title}
                  data-chip={s.key}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      {(recs.length > 0 || taskCount > 0) && (
        <section aria-label="Top actions" data-testid="report-top-actions">
          <div className="flex items-baseline justify-between gap-2 mb-2">
            <Label as="h3">{top.length ? 'Top actions' : 'Actions'}</Label>
            <button type="button" onClick={() => onOpenTab('actions')} className="text-sm font-semibold text-brand hover:underline min-h-[36px] px-1">
              See all actions →
            </button>
          </div>
          {top.length > 0 ? (
            <ul className="space-y-2">{top.map((rec, i) => <RecommendationCard key={i} rec={rec} compact />)}</ul>
          ) : (
            <Card padding="sm" className="text-sm text-muted">
              {recs.length > 0
                ? `${recs.length} recommendation${recs.length === 1 ? '' : 's'}, none high priority.`
                : `No structured recommendations; ${taskCount} operator task${taskCount === 1 ? '' : 's'} from this run.`}
            </Card>
          )}
        </section>
      )}
    </div>
  );
}

/** Model, tokens and the raw input snapshot, collapsed at the bottom (admin only). */
function ReportDetails({ report, excluded }) {
  const rows = [
    ['Model', report.model],
    ['Generated', report.generated_at ? `${fmtGenerated(report.generated_at)} (${report.generated_at} UTC)` : null],
    ['Tokens in / out', report.input_tokens != null ? `${report.input_tokens} / ${report.output_tokens}` : null],
    ['Cache read / write', (report.cache_read_tokens || report.cache_creation_tokens) ? `${report.cache_read_tokens || 0} / ${report.cache_creation_tokens || 0}` : null],
    ['Capture ids', report.capture_ids?.length ? report.capture_ids.join(', ') : null],
    ['Excluded sources', excluded?.length ? excluded.join(', ') : null],
  ].filter(([, v]) => v != null && v !== '');

  return (
    <Card as="details" padding="none" className="group" data-testid="report-details">
      <summary className="cursor-pointer list-none min-h-touch px-4 py-2 flex items-center gap-2 hover:bg-field rounded-card">
        <svg aria-hidden="true" className="w-4 h-4 text-muted transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
        <span className="text-sm font-semibold text-ink">Report details</span>
        <span className="min-w-0 truncate font-mono text-xs text-muted">{report.model}</span>
      </summary>
      <div className="px-4 pb-4 pt-1 space-y-3">
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
          {rows.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt className="text-muted">{k}</dt>
              <dd className="font-mono text-ink break-words min-w-0">{v}</dd>
            </React.Fragment>
          ))}
        </dl>
        {report.input_snapshot != null && (
          <details className="border border-line rounded-md">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink hover:bg-field">Input snapshot (data sent to the agent)</summary>
            <pre className="p-3 text-xs font-mono overflow-auto bg-field text-ink max-h-96 border-t border-line">
              {JSON.stringify(report.input_snapshot, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </Card>
  );
}

/**
 * One agronomist report: header with date navigation, then tabs
 * (Overview | one per markdown section | Actions | Discussion), then the
 * admin-only details disclosure. The selected tab is remembered per viewer.
 */
export default function ReportView({ report, reports, onSelect, pending, isAdmin, canControl, headers, onClarificationUpdated }) {
  const idBase = useId().replace(/:/g, '');
  const tabsRef = useRef(null);
  const [preferredTab, setPreferredTab] = useState(readTab);
  const { tasks: allTasks, error: tasksError } = useAgronomistTasks(headers, reports);

  const { intro, sections } = useMemo(() => splitReportSections(report.full_markdown), [report.full_markdown]);
  const contentSections = sections.filter(s => s.key !== 'recommendations');
  const notes = sections.find(s => s.key === 'recommendations')?.body || '';
  const tasks = useMemo(() => (allTasks || []).filter(t => t.source_report_id === report.id), [allTasks, report.id]);
  const recCount = report.recommendations?.length || 0;
  const noteCount = report.clarifications?.length || 0;

  // The full report (GET /reports/:id) has no excluded_sources; the list row does.
  const excluded = report.excluded_sources || reports.find(r => r.id === report.id)?.excluded_sources || [];

  const tabs = [
    { id: 'overview', label: 'Overview' },
    ...contentSections.map(s => ({ id: s.key, label: s.label })),
    { id: 'actions', label: 'Actions', badge: recCount, badgeLabel: `${recCount} recommendations` },
    { id: 'discussion', label: 'Discussion', badge: noteCount, badgeLabel: `${noteCount} notes` },
  ];

  // A report without the remembered tab falls back to Overview; the preference
  // itself is kept so the next report that has the tab opens on it again.
  const active = tabs.some(t => t.id === preferredTab) ? preferredTab : 'overview';

  const selectTab = (id, { reveal = false } = {}) => {
    setPreferredTab(id);
    writeTab(id);
    if (reveal) {
      const el = tabsRef.current;
      if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  };

  if (report.status === 'failure') {
    return (
      <div className="space-y-4">
        <ReportHeader report={report} reports={reports} excluded={excluded} onSelect={onSelect} pending={pending} />
        <FailureCard report={report} />
        {isAdmin && <ReportDetails report={report} excluded={excluded} />}
      </div>
    );
  }

  const section = contentSections.find(s => s.key === active);

  return (
    <div className="space-y-4">
      <ReportHeader report={report} reports={reports} excluded={excluded} onSelect={onSelect} pending={pending} />

      <div ref={tabsRef} className="scroll-mt-4">
        <ReportTabs tabs={tabs} active={active} onChange={id => selectTab(id)} idBase={idBase} label="Report sections" />
      </div>

      <div {...tabPanelProps(idBase, active)} className={`focus:outline-none ${pending ? 'opacity-60' : ''}`} data-testid={`report-panel-${active}`}>
        {active === 'overview' && (
          <Overview
            report={report}
            intro={intro}
            chips={contentSections}
            taskCount={tasks.length}
            onOpenTab={id => selectTab(id, { reveal: true })}
          />
        )}
        {section && (
          <Card>
            <h2 className="font-display text-lg font-semibold text-ink mb-3 break-words">{section.title}</h2>
            {section.body
              ? <ReportMarkdown markdown={section.body} />
              : <p className="text-sm text-muted">This section is empty in the report.</p>}
          </Card>
        )}
        {active === 'actions' && (
          <ReportActions report={report} notes={notes} tasks={tasks} tasksError={tasksError} />
        )}
        {active === 'discussion' && (
          <ClarificationsPanel key={report.id} report={report} canControl={canControl} headers={headers} onUpdated={onClarificationUpdated} />
        )}
      </div>

      {isAdmin && <ReportDetails report={report} excluded={excluded} />}
    </div>
  );
}
