import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat';
import { normalizeLanguage } from '../../i18n/languages';
import { Button, Card, Kpi, Label, RAIL_CLASSES, StatusPill, ProvenanceBadge } from '../../ui';
import { FrameStrip } from './CaptureStrip';
import CaptureViews from './CaptureViews';
import ClarificationsPanel from './ClarificationsPanel';
import ReportActions, { RecommendationCard, groupRecommendations } from './ReportActions';
import ReportMarkdown from './ReportMarkdown';
import ReportTabs, { tabPanelProps } from './ReportTabs';
import { splitReportSections } from './splitReportSections';
import { SECTION_STATUS, SectionStatusPill, StatusMark, statusOf } from './SectionStatus';
import { ReportTextContext, reportTextProps, useReportTextProps } from './reportText';
import { dateWeekday } from './weekday';

const API_BASE = '/api';
const TAB_KEY = 'agronomist:reportTab';
const TOP_ACTIONS = 3;

// Short provider-error labels: agronomist:errorClass.<class> (unknown -> 'other').
const ERROR_CLASSES = ['billing', 'auth', 'rate_limit', 'other', 'truncated_output', 'max_tokens', 'refusal'];
const errorClassLabel = (t, c) => t(`errorClass.${ERROR_CLASSES.includes(c) ? c : 'other'}`);

// Structured reports (report.sections, since 2026-09-25): fixed order, same
// keys as the markdown splitter so a remembered tab carries across old/new.
// Tab label + card title come from agronomist:section.<key>.{label,title},
// never from report text (the English label/title stay for tests/logs).
const STRUCTURED_SECTIONS = [
  { key: 'crop', label: 'Crop', title: 'State of the Crop' },
  { key: 'irrigation', label: 'Irrigation', title: 'Irrigation & Fertigation' },
  { key: 'nutrients', label: 'Nutrients', title: 'Nutrient Status (AMIC + Lab)' },
  { key: 'risks', label: 'Risks', title: 'Risks & Anomalies' },
];
// Section keys whose tab label is ours (splitReportSections KNOWN, minus recommendations).
const LABELLED_SECTIONS = ['crop', 'irrigation', 'nutrients', 'climate', 'risks'];

/** Tab label for a section: translated for known keys ("crop", "crop-2"), else the report's own short heading. */
function sectionLabel(t, s) {
  const m = /^([a-z]+)(?:-(\d+))?$/.exec(s.key);
  if (m && LABELLED_SECTIONS.includes(m[1])) {
    const base = t(`section.${m[1]}.label`);
    return m[2] ? t('section.numbered', { label: base, n: m[2] }) : base;
  }
  return s.label;
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** report.sections -> ordered sections, or null (older reports: markdown path). */
export function structuredSections(sections) {
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) return null;
  const list = STRUCTURED_SECTIONS
    .filter(s => sections[s.key] && typeof sections[s.key] === 'object')
    .map(s => {
      const raw = sections[s.key];
      return {
        ...s,
        status: statusOf(raw.status),
        headline: str(raw.headline).trim(),
        keyNumbers: (Array.isArray(raw.key_numbers) ? raw.key_numbers : [])
          .filter(k => k && str(k.label).trim())
          .map(k => ({ label: str(k.label).trim(), value: str(k.value).trim(), unit: str(k.unit).trim(), state: statusOf(k.state) })),
        details: str(raw.details_markdown).trim(),
      };
    });
  return list.length ? list : null;
}

/** A failed regenerate newer than the content shown (content was kept). */
function keptAfterFailure(r) {
  return !!(r?.last_error_at && (!r.generated_at || String(r.last_error_at) >= String(r.generated_at)));
}
// agronomist:captureMode.<mode>; unknown modes show the raw code.
const CAPTURE_MODES = ['noon', 'manual', 'fallback_4h', 'latest', 'manual_night'];

const readTab = () => { try { return localStorage.getItem(TAB_KEY) || 'overview'; } catch { return 'overview'; } };
const writeTab = (id) => { try { localStorage.setItem(TAB_KEY, id); } catch { /* private mode etc. */ } };

// generated_at is SQLite datetime('now'): UTC without a zone marker (toEpochMs handles it).
function fmtGenerated(fmt, s) {
  if (!s) return '';
  return fmt.dateTime(s, { year: undefined, second: undefined, fallback: String(s) });
}

/** Whole days between a YYYY-MM-DD report date and today (local). */
function ageDays(reportDate) {
  const today = new Date();
  const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const [y, m, d] = String(reportDate || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return Math.round((t - Date.UTC(y, m - 1, d)) / 86400000);
}

// Text-only markers for <option> (no pills possible): square = failed, triangle = caution.
function optionLabel(t, lng, r) {
  const s = `${r.report_date} · ${dateWeekday(r.report_date, lng)}`;
  if (r.status === 'failure') return `${s} ■ ${t('header.optionFailed', { reason: errorClassLabel(t, r.error_class) })}`;
  if (keptAfterFailure(r)) return `${s} ▲ ${t('header.optionRegenFailed')}`;
  if (r.excluded_sources?.length) return `${s} ▲ ${t('header.optionExcluded', { count: r.excluded_sources.length })}`;
  return s;
}

/**
 * Operator tasks this report created, for the Actions tab (server-side
 * source_report_id filter). Refetched when the report changes or the page
 * reloads its report list (generate / retry / regenerate create new tasks).
 */
function useAgronomistTasks(headers, reportId, refreshKey) {
  const [state, setState] = useState({ tasks: null, error: null });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/operator-tasks?status=all&source=agronomist&source_report_id=${encodeURIComponent(reportId)}&limit=500`, { headers });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!cancelled) setState({ tasks: Array.isArray(data) ? data : [], error: null });
      } catch (err) {
        if (!cancelled) setState({ tasks: null, error: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, [reportId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

// Older = back = left in LTR; mirrored in RTL (older on the right, like the Arabic reading order).
function ChevronIcon({ dir }) {
  return (
    <svg aria-hidden="true" className="w-5 h-5 rtl:-scale-x-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d={dir === 'left' ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7'} />
    </svg>
  );
}


/**
 * Where the report text on screen comes from (tr / ar UI only): automatic
 * translation, English original on request, translation in progress (the page
 * checks again by itself), failed, or English-only. Admins can request a
 * translation (one paid API call, queued server-side).
 */
function TranslationNote({ report, showingOriginal, isAdmin, onToggleOriginal, onTranslate, translating }) {
  const { t, i18n } = useTranslation('agronomist');
  const ui = normalizeLanguage(i18n.language) || 'en';
  if (ui === 'en' || report.status !== 'success') return null;
  const status = showingOriginal ? 'shown-original' : (report.translation_status || 'original');

  let pill = null;
  let text;
  let action = null;
  const translateButton = (labelKey) => (isAdmin && onTranslate ? (
    <Button variant="secondary" size="sm" onClick={onTranslate} disabled={translating} data-testid="report-translate">
      {translating ? t('translation.requesting') : t(labelKey)}
    </Button>
  ) : null);

  if (status === 'shown-original') {
    text = t('translation.showingOriginal');
    action = <Button variant="ghost" size="sm" onClick={onToggleOriginal} data-testid="report-show-translation">{t('translation.showTranslation')}</Button>;
  } else if (status === 'ready') {
    text = t('translation.autoTranslated');
    action = <Button variant="ghost" size="sm" onClick={onToggleOriginal} data-testid="report-show-original">{t('translation.showOriginal')}</Button>;
  } else if (status === 'pending') {
    pill = <StatusPill state="idle" pulse text={t('translation.inProgress')} />;
    text = t('translation.inProgressHelp');
  } else if (status === 'failed') {
    pill = <StatusPill state="caution" filled text={t('translation.failed')} />;
    text = t('translation.failedHelp');
    action = translateButton('translation.retry');
  } else {
    text = t('translation.englishOnly');
    action = translateButton('translation.translate');
  }

  return (
    <div
      className="mt-3 pt-2 border-t border-line flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted"
      data-testid="report-translation"
      data-translation-status={status}
      role="status"
    >
      <svg aria-hidden="true" className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
      </svg>
      {pill}
      <span className="min-w-0 flex-1">{text}</span>
      {action}
    </div>
  );
}

/** Date navigation + opinion headline + state pills. Works for failed reports too. */
function ReportHeader({ report, reports, excluded, onSelect, pending, translation }) {
  const { t, i18n } = useTranslation('agronomist');
  const fmt = useFormat();
  const textProps = useReportTextProps();
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
          aria-label={older ? t('header.olderAria', { date: older.report_date }) : t('header.noOlder')}
          title={older ? t('header.olderTitle', { date: older.report_date }) : t('header.noOlder')}
          className="!px-2.5 shrink-0"
          data-testid="report-prev"
        >
          <ChevronIcon dir="left" />
        </Button>
        <label htmlFor="report-date-select" className="sr-only">{t('header.reportDate')}</label>
        <select
          id="report-date-select"
          value={report.id}
          onChange={e => onSelect(Number(e.target.value))}
          className="min-w-0 flex-1 sm:flex-none sm:w-80 min-h-touch font-mono text-sm"
          data-testid="report-date-select"
        >
          {idx < 0 && <option value={report.id}>{optionLabel(t, i18n.language, report)}</option>}
          {reports.map(r => <option key={r.id} value={r.id}>{optionLabel(t, i18n.language, r)}</option>)}
        </select>
        <Button
          variant="secondary"
          onClick={() => newer && onSelect(newer.id)}
          disabled={!newer}
          aria-label={newer ? t('header.newerAria', { date: newer.report_date }) : t('header.noNewer')}
          title={newer ? t('header.newerTitle', { date: newer.report_date }) : t('header.isLatest')}
          className="!px-2.5 shrink-0"
          data-testid="report-next"
        >
          <ChevronIcon dir="right" />
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!failed && <ProvenanceBadge kind="ai" data-testid="report-ai-badge" />}
        {failed && (
          <StatusPill state="alarm" filled text={t('header.failedPill', { reason: errorClassLabel(t, report.error_class) })} />
        )}
        {!isLatest && idx >= 0 && <StatusPill state="idle" text={t('header.olderReport')} title={t('header.olderReportTitle')} />}
        {isLatest && age != null && age >= 2 && (
          <StatusPill state="caution" text={t('header.daysOld', { count: age })} title={t('header.daysOldTitle')} />
        )}
        {!failed && keptAfterFailure(report) && (
          <StatusPill
            state="caution"
            filled
            className="max-w-full !whitespace-normal"
            text={t('header.regenFailedPill', { reason: errorClassLabel(t, report.last_error_class) })}
            title={t('header.regenFailedTitle', {
              failedAt: fmtGenerated(fmt, report.last_error_at),
              generatedAt: fmtGenerated(fmt, report.generated_at),
              error: report.last_error || '',
            })}
            data-testid="report-regen-failed"
          />
        )}
        {excluded.length > 0 && (
          <StatusPill
            state="caution"
            filled
            className="max-w-full !whitespace-normal"
            text={t('header.sourcesExcluded', { count: excluded.length })}
            title={t('header.sourcesExcludedTitle', { names: excluded.join(', ') })}
            data-testid="report-excluded"
          />
        )}
        {report.generated_at && (
          <span className="font-mono text-xs text-muted">{t('header.generatedAt', { time: fmtGenerated(fmt, report.generated_at) })}</span>
        )}
        {pending && <StatusPill state="idle" pulse text={t('common:status.loadingShort')} />}
      </div>

      {!failed && report.opinion && (
        <p {...textProps} className="mt-3 font-display text-[17px] sm:text-xl font-semibold leading-snug text-ink break-words max-w-3xl" data-testid="report-opinion">
          {report.opinion}
        </p>
      )}

      {translation}
    </Card>
  );
}

function FailureCard({ report }) {
  const { t } = useTranslation('agronomist');
  return (
    <Card rail="alarm" data-testid="report-failure">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-base font-semibold text-ink">{t('failure.title', { date: report.report_date })}</h2>
        <StatusPill state="alarm" filled text={ERROR_CLASSES.includes(report.error_class) || !report.error_class ? errorClassLabel(t, report.error_class) : report.error_class} />
      </div>
      <p className="mt-1 text-sm text-muted">{t('failure.body')}</p>
      {report.error && (
        <pre dir="ltr" className="mt-3 p-3 text-xs font-mono whitespace-pre-wrap break-words bg-field border border-line rounded-md text-ink max-h-64 overflow-y-auto text-start">{report.error}</pre>
      )}
    </Card>
  );
}

/** One tile per key number: status mark + label, value as a Reading (em dash when unknown). */
function KeyNumber({ k }) {
  const { t } = useTranslation('agronomist');
  const textProps = useReportTextProps();
  const st = statusOf(k.state);
  const unknown = st === 'unknown';
  const shownValue = unknown ? null : k.value;
  const hint = unknown && k.value && !/^[-—–]+$/.test(k.value)
    ? t('keyNumber.notCurrent', { value: `${k.value}${k.unit ? ` ${k.unit}` : ''}` })
    : null;
  return (
    <Kpi
      padding="sm"
      rail={SECTION_STATUS[st].rail}
      className="min-w-0"
      size={String(k.value).length > 8 ? 'sm' : 'md'}
      label={<span className="inline-flex items-center gap-1.5 min-w-0"><StatusMark status={st} /><span {...textProps} className="truncate">{k.label}</span></span>}
      value={shownValue}
      unit={k.unit || undefined}
      unknown={unknown}
      hint={hint}
      data-key-number-state={st}
    />
  );
}

/** A section tab of a structured report: status + headline, key numbers, then bullets. */
function StructuredSection({ section }) {
  const { t } = useTranslation('agronomist');
  const textProps = useReportTextProps();
  const st = statusOf(section.status);
  return (
    <Card rail={SECTION_STATUS[st].rail} data-testid={`section-${section.key}`} data-section-status={st}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-lg font-semibold text-ink break-words">{t(`section.${section.key}.title`, { defaultValue: section.title })}</h2>
        <SectionStatusPill status={st} />
      </div>
      {section.headline && (
        <p {...textProps} className="mt-2 font-display text-[16px] sm:text-lg font-semibold leading-snug text-ink max-w-3xl break-words" data-testid="section-headline">
          {section.headline}
        </p>
      )}
      {section.keyNumbers.length > 0 && (
        <div className="mt-3 grid grid-cols-2 lg:grid-cols-4 gap-2" data-testid="section-key-numbers">
          {section.keyNumbers.map((k, i) => <KeyNumber key={`${k.label}-${i}`} k={k} />)}
        </div>
      )}
      {section.details
        ? <ReportMarkdown markdown={section.details} className="mt-4" />
        : <p className="mt-3 text-sm text-muted">{t('section.noDetail')}</p>}
    </Card>
  );
}

/** Overview's "status at a glance": every section's status + headline, tap to open it. */
function GlanceCard({ sections, onOpenTab }) {
  const { t } = useTranslation('agronomist');
  const textProps = useReportTextProps();
  return (
    <Card data-testid="report-glance">
      <Label as="h3" className="mb-2">{t('overview.glance')}</Label>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {sections.map(s => {
          const st = statusOf(s.status);
          return (
            <li key={s.key} className="min-w-0">
              <button
                type="button"
                onClick={() => onOpenTab(s.key)}
                className={`w-full h-full text-start min-h-touch p-3 rounded-md border border-line bg-field hover:border-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${RAIL_CLASSES[SECTION_STATUS[st].rail] || ''}`}
                data-chip={s.key}
                data-section-status={st}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <StatusMark status={st} />
                  <span className="font-semibold text-ink">{sectionLabel(t, s)}</span>
                  <SectionStatusPill status={st} className="ms-auto" />
                </span>
                {s.headline && <span {...textProps} className="mt-1 block text-sm leading-snug text-muted break-words">{s.headline}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Overview({ report, intro, chips, glance, onOpenTab, taskCount }) {
  const { t } = useTranslation('agronomist');
  const textProps = useReportTextProps();
  const frames = report.captures?.length ? report.captures : report.capture ? [report.capture] : [];
  const recs = report.recommendations || [];
  const top = groupRecommendations(recs)
    .filter(g => g.priority === 'critical' || g.priority === 'high')
    .flatMap(g => g.items)
    .slice(0, TOP_ACTIONS);
  const hasText = !!(report.summary || intro);

  return (
    <div className="space-y-4">
      {glance && <GlanceCard sections={glance} onOpenTab={onOpenTab} />}

      {frames.length > 0 && (
        <Card data-testid="report-frames">
          <div className="flex flex-wrap items-baseline gap-x-2 mb-2">
            <Label as="h3">{t(report.capture_layout === 'views' ? 'overview.viewsUsed' : 'overview.framesUsed')}</Label>
            {report.capture_mode && (
              <span className="text-xs text-muted">{CAPTURE_MODES.includes(report.capture_mode) ? t(`captureMode.${report.capture_mode}`) : report.capture_mode}</span>
            )}
          </div>
          {report.capture_layout === 'views'
            ? <CaptureViews views={report.capture_views} frames={frames} />
            : <FrameStrip frames={frames} bestId={report.capture_id ?? report.capture?.id ?? null} />}
          {/* photo_line is not among the backend's translated fields: let the text pick its own direction. */}
          {report.photo_line && <p dir="auto" className="mt-2 text-sm text-muted max-w-prose break-words">{report.photo_line}</p>}
        </Card>
      )}

      <Card data-testid="report-summary">
        <Label as="h3" className="mb-2">{t('overview.summary')}</Label>
        {report.summary && <p {...textProps} className="max-w-prose text-[15px] leading-7 text-ink break-words">{report.summary}</p>}
        {intro && <ReportMarkdown markdown={intro} className={report.summary ? 'mt-3' : ''} />}
        {!hasText && <p className="text-sm text-muted">{t('overview.noSummary')}</p>}

        {!glance && chips.length > 0 && (
          <div className="mt-4 pt-3 border-t border-line">
            <Label className="mb-2">{t('overview.readReport')}</Label>
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
                  {sectionLabel(t, s)}
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      {(recs.length > 0 || taskCount > 0) && (
        <section aria-label={t('overview.topActions')} data-testid="report-top-actions">
          <div className="flex items-baseline justify-between gap-2 mb-2">
            <Label as="h3">{top.length ? t('overview.topActions') : t('tabs.actions')}</Label>
            <button type="button" onClick={() => onOpenTab('actions')} className="inline-flex items-center gap-1 text-sm font-semibold text-brand hover:underline min-h-[36px] px-1">
              {t('overview.seeAllActions')}
              <span aria-hidden="true" className="inline-block rtl:-scale-x-100">→</span>
            </button>
          </div>
          {top.length > 0 ? (
            <ul className="space-y-2">{top.map((rec, i) => <RecommendationCard key={i} rec={rec} compact />)}</ul>
          ) : (
            <Card padding="sm" className="text-sm text-muted">
              {recs.length > 0
                ? t('overview.noHighPriority', { count: recs.length })
                : t('overview.onlyTasks', { count: taskCount })}
            </Card>
          )}
        </section>
      )}
    </div>
  );
}

/** Model, tokens and the raw input snapshot, collapsed at the bottom (admin only). */
function ReportDetails({ report, excluded }) {
  const { t } = useTranslation('agronomist');
  const fmt = useFormat();
  const rows = [
    ['model', report.model],
    ['generated', report.generated_at ? `${fmtGenerated(fmt, report.generated_at)} (${report.generated_at} UTC)` : null],
    ['tokens', report.input_tokens != null ? `${fmt.int(report.input_tokens)} / ${fmt.int(report.output_tokens)}` : null],
    ['cache', (report.cache_read_tokens || report.cache_creation_tokens) ? `${fmt.int(report.cache_read_tokens || 0)} / ${fmt.int(report.cache_creation_tokens || 0)}` : null],
    ['captureIds', report.capture_ids?.length ? report.capture_ids.join(', ') : null],
    ['excluded', excluded?.length ? excluded.join(', ') : null],
    ['translation', report.translation_status === 'ready' && report.translation_model
      ? `${report.translation_language} · ${report.translation_model}${report.translated_at ? ` · ${fmtGenerated(fmt, report.translated_at)}` : ''}`
      : null],
  ].filter(([, v]) => v != null && v !== '');

  return (
    <Card as="details" padding="none" className="group" data-testid="report-details">
      <summary className="cursor-pointer list-none min-h-touch px-4 py-2 flex items-center gap-2 hover:bg-field rounded-card">
        <svg aria-hidden="true" className="w-4 h-4 text-muted transition-transform rtl:-scale-x-100 group-open:rotate-90 rtl:group-open:-rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
        <span className="text-sm font-semibold text-ink">{t('details.title')}</span>
        <span className="min-w-0 truncate font-mono text-xs text-muted">{report.model}</span>
      </summary>
      <div className="px-4 pb-4 pt-1 space-y-3">
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
          {rows.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt className="text-muted">{t(`details.${k}`)}</dt>
              <dd className="font-mono text-ink break-words min-w-0" dir="ltr" style={{ textAlign: 'start' }}>{v}</dd>
            </React.Fragment>
          ))}
        </dl>
        {report.input_snapshot != null && (
          <details className="border border-line rounded-md">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink hover:bg-field">{t('details.inputSnapshot')}</summary>
            <pre dir="ltr" className="p-3 text-xs font-mono overflow-auto bg-field text-ink max-h-96 border-t border-line text-start">
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
 * Translation (tr / ar): see TranslationNote; the parent refetches the report
 * with ?original=1 for "Show original" and polls while a translation is pending.
 */
export default function ReportView({
  report, reports, onSelect, pending, isAdmin, canControl, headers, onClarificationUpdated,
  showingOriginal = false, onToggleOriginal, onTranslate, translating = false,
}) {
  const { t, i18n } = useTranslation('agronomist');
  const idBase = useId().replace(/:/g, '');
  const tabsRef = useRef(null);
  const [preferredTab, setPreferredTab] = useState(readTab);
  const { tasks: allTasks, error: tasksError } = useAgronomistTasks(headers, report.id, reports);
  const textProps = useMemo(() => reportTextProps(report, i18n.language), [report, i18n.language]);

  const { intro, sections } = useMemo(() => splitReportSections(report.full_markdown), [report.full_markdown]);
  // Structured reports drive the tabs from report.sections; older ones (sections
  // null) keep the markdown-splitter path unchanged. full_markdown is composed
  // server-side for structured reports too (English `## ` headings, also for a
  // translated report), so the Recommendations notes come from it either way.
  const structured = useMemo(() => structuredSections(report.sections), [report.sections]);
  const contentSections = structured || sections.filter(s => s.key !== 'recommendations');
  const notes = sections.find(s => s.key === 'recommendations')?.body || '';
  // The API filters by source_report_id; the client-side filter stays as a guard.
  const tasks = useMemo(() => (allTasks || []).filter(x => x.source_report_id === report.id), [allTasks, report.id]);
  const recCount = report.recommendations?.length || 0;
  const noteCount = report.clarifications?.length || 0;

  // The full report (GET /reports/:id) has no excluded_sources; the list row does.
  const excluded = report.excluded_sources || reports.find(r => r.id === report.id)?.excluded_sources || [];

  const tabs = [
    { id: 'overview', label: t('tabs.overview') },
    ...contentSections.map(s => ({ id: s.key, label: sectionLabel(t, s), icon: structured ? <StatusMark status={s.status} /> : null })),
    { id: 'actions', label: t('tabs.actions'), badge: recCount, badgeLabel: t('count.recommendation', { count: recCount }) },
    { id: 'discussion', label: t('tabs.discussion'), badge: noteCount, badgeLabel: t('count.note', { count: noteCount }) },
  ];

  // A report without the remembered tab falls back to Overview; the preference
  // itself is kept so the next report that has the tab opens on it again.
  const active = tabs.some(x => x.id === preferredTab) ? preferredTab : 'overview';

  const selectTab = (id, { reveal = false } = {}) => {
    setPreferredTab(id);
    writeTab(id);
    if (reveal) {
      const el = tabsRef.current;
      if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  };

  const translation = (
    <TranslationNote
      report={report}
      showingOriginal={showingOriginal}
      isAdmin={isAdmin}
      onToggleOriginal={onToggleOriginal}
      onTranslate={onTranslate}
      translating={translating}
    />
  );

  if (report.status === 'failure') {
    return (
      <ReportTextContext.Provider value={textProps}>
        <div className="space-y-4">
          <ReportHeader report={report} reports={reports} excluded={excluded} onSelect={onSelect} pending={pending} translation={translation} />
          <FailureCard report={report} />
          {isAdmin && <ReportDetails report={report} excluded={excluded} />}
        </div>
      </ReportTextContext.Provider>
    );
  }

  const section = contentSections.find(s => s.key === active);

  return (
    <ReportTextContext.Provider value={textProps}>
      <div className="space-y-4">
        <ReportHeader report={report} reports={reports} excluded={excluded} onSelect={onSelect} pending={pending} translation={translation} />

        <div ref={tabsRef} className="scroll-mt-4">
          <ReportTabs tabs={tabs} active={active} onChange={id => selectTab(id)} idBase={idBase} label={t('tabs.label')} />
        </div>

        <div {...tabPanelProps(idBase, active)} className={`focus:outline-none ${pending ? 'opacity-60' : ''}`} data-testid={`report-panel-${active}`}>
          {active === 'overview' && (
            <Overview
              report={report}
              intro={structured ? '' : intro}
              chips={contentSections}
              glance={structured}
              taskCount={tasks.length}
              onOpenTab={id => selectTab(id, { reveal: true })}
            />
          )}
          {section && structured && <StructuredSection section={section} />}
          {section && !structured && (
            <Card>
              <h2 {...textProps} className="font-display text-lg font-semibold text-ink mb-3 break-words">{section.title}</h2>
              {section.body
                ? <ReportMarkdown markdown={section.body} />
                : <p className="text-sm text-muted">{t('section.empty')}</p>}
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
    </ReportTextContext.Provider>
  );
}
