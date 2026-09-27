import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { Button, Card, SectionHeader } from '../ui';
import ConfirmDialog from '../components/ConfirmDialog';
import AutomationRow from '../components/automations/AutomationRow';
import StopIrrigationButton from '../components/irrigation/StopIrrigationButton';
import AutomationBuilderModal from '../components/automations/AutomationBuilderModal';
import AutomationDetailModal from '../components/automations/AutomationDetailModal';
import { TemplateManagerModal, TemplatesModal } from '../components/automations/TemplateModals';
import { INPUT, API_BASE } from '../components/automations/formStyles';
import {
  buildEquipmentIndex, summarizeAutomation, classifyAutomation, offlineTargets, findDuplicateNames, isEnabled,
  parseAutomation, collectTargets, formatDuration, actionWord, CATEGORY_ORDER, CATEGORY_LABELS, TRIGGER_ORDER, TRIGGER_LABELS,
} from '../components/automations/automationSummary';
import { useSummaryLocale } from '../components/automations/useSummaryLocale';

/**
 * Automations: every rule says WHAT it does and WHEN, grouped by purpose.
 * Actions are quiet (ghost/secondary); "New" is the only filled button.
 * Run and Delete confirm through ConfirmDialog with the channel list.
 */
/** Rule names are data: isolate them so "1.STOP EVERYTHING" keeps its order inside Arabic text. */
const nameIso = (name) => `\u2068${name}\u2069`;

export default function Automations() {
  // 'templates' (template modals) and 'irrigation' (Stop irrigation button)
  // load with the page, so opening a modal never suspends the whole page.
  const { t } = useTranslation(['automations', 'templates', 'irrigation']);
  const loc = useSummaryLocale();
  const { token, user } = useAuth();
  const { showError, showSuccess } = useToast();
  const canEdit = user?.role === 'admin' || user?.role === 'operator';

  const [automations, setAutomations] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [doseProgramsById, setDoseProgramsById] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [groupBy, setGroupBy] = useState('purpose');

  const [showBuilderModal, setShowBuilderModal] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [showTemplatesModal, setShowTemplatesModal] = useState(false);
  const [showTemplateManager, setShowTemplateManager] = useState(false);
  const [selectedAutomation, setSelectedAutomation] = useState(null);
  const [isNewAutomation, setIsNewAutomation] = useState(false);

  // { kind: 'run' | 'delete', auto, summary, targets }
  const [confirm, setConfirm] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [busy, setBusy] = useState({}); // { [id]: { toggle, run, duplicate } }

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }), [token]);

  const fetchAutomations = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch(`${API_BASE}/automations`, { headers: authHeaders });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setAutomations(await response.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    if (!token) return;
    fetchAutomations();
    // Equipment once: channel labels, online state and metrics for the builder.
    fetch(`${API_BASE}/equipment`, { headers: authHeaders })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(list => setEquipment(Array.isArray(list) ? list : []))
      .catch(err => showError(t('errors.loadEquipment', { error: err.message })));
    fetch(`${API_BASE}/fertigation/dose-programs`, { headers: authHeaders })
      .then(r => (r.ok ? r.json() : []))
      .then(list => {
        const m = {};
        for (const p of Array.isArray(list) ? list : []) m[p.id] = p;
        setDoseProgramsById(m);
      })
      .catch(err => showError(t('errors.loadDosePrograms', { error: err.message })));
  }, [token, authHeaders, fetchAutomations]);

  const equipIndex = useMemo(() => buildEquipmentIndex(equipment), [equipment]);
  const duplicateNames = useMemo(() => findDuplicateNames(automations), [automations]);

  const enriched = useMemo(() => automations.map(auto => ({
    auto,
    summary: summarizeAutomation(auto, equipIndex, loc),
    category: classifyAutomation(auto),
    enabled: isEnabled(auto),
    offline: offlineTargets(auto, equipIndex),
    duplicate: duplicateNames.has(String(auto.name || '').trim().toLowerCase()),
  })), [automations, equipIndex, duplicateNames, loc]);

  const filtered = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return enriched.filter(({ auto, summary, enabled }) => {
      const matchesSearch = !q
        || String(auto.name || '').toLowerCase().includes(q)
        || String(auto.description || '').toLowerCase().includes(q)
        || summary.text.toLowerCase().includes(q);
      const matchesStatus = !statusFilter || (statusFilter === 'enabled' ? enabled : !enabled);
      return matchesSearch && matchesStatus;
    });
  }, [enriched, searchTerm, statusFilter]);

  const groups = useMemo(() => {
    const order = groupBy === 'trigger' ? TRIGGER_ORDER : CATEGORY_ORDER;
    const labels = groupBy === 'trigger' ? TRIGGER_LABELS : CATEGORY_LABELS;
    const ns = groupBy === 'trigger' ? 'trigger' : 'category';
    const byKey = new Map();
    for (const item of filtered) {
      const key = groupBy === 'trigger' ? item.summary.triggerType : item.category;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(item);
    }
    const keys = [...order.filter(k => byKey.has(k)), ...[...byKey.keys()].filter(k => !order.includes(k))];
    return keys.map(key => ({ key, label: t(`${ns}.${key}`, { defaultValue: labels[key] || key }), items: byKey.get(key) }));
  }, [filtered, groupBy, t]);

  const enabledCount = enriched.filter(e => e.enabled).length;

  // ----- row actions -----
  const setRowBusy = (id, key, value) => setBusy(prev => ({ ...prev, [id]: { ...(prev[id] || {}), [key]: value } }));

  const handleToggle = async (auto) => {
    setRowBusy(auto.id, 'toggle', true);
    try {
      const response = await fetch(`${API_BASE}/automations/${auto.id}/toggle`, { method: 'POST', headers: authHeaders });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      showSuccess(t(data.enabled ? 'toast.enabled' : 'toast.disabled', { name: nameIso(auto.name) }));
      await fetchAutomations();
    } catch (err) {
      showError(t('errors.toggle', { name: nameIso(auto.name), error: err.message }));
    } finally {
      setRowBusy(auto.id, 'toggle', false);
    }
  };

  const handleDuplicate = async (auto) => {
    setRowBusy(auto.id, 'duplicate', true);
    try {
      const response = await fetch(`${API_BASE}/automations/${auto.id}/duplicate`, { method: 'POST', headers: authHeaders });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      showSuccess(t('toast.duplicated', { message: result.message || t('toast.duplicatedDefault') }));
      await fetchAutomations();
    } catch (err) {
      showError(t('errors.duplicate', { name: nameIso(auto.name), error: err.message }));
    } finally {
      setRowBusy(auto.id, 'duplicate', false);
    }
  };

  const openConfirm = (kind, item) => {
    const { actions } = parseAutomation(item.auto);
    setConfirm({ kind, auto: item.auto, summary: item.summary, targets: collectTargets(actions, equipIndex, loc), actions });
  };

  const runConfirmed = async () => {
    const auto = confirm.auto;
    setConfirmBusy(true);
    setRowBusy(auto.id, 'run', true);
    try {
      const response = await fetch(`${API_BASE}/automations/${auto.id}/trigger`, { method: 'POST', headers: authHeaders });
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);
      showSuccess(data?.message || t('toast.triggered', { name: nameIso(auto.name) }));
      setConfirm(null);
      await fetchAutomations();
    } catch (err) {
      showError(t('errors.run', { name: nameIso(auto.name), error: err.message }));
    } finally {
      setConfirmBusy(false);
      setRowBusy(auto.id, 'run', false);
    }
  };

  const deleteConfirmed = async () => {
    const auto = confirm.auto;
    setConfirmBusy(true);
    try {
      const response = await fetch(`${API_BASE}/automations/${auto.id}`, { method: 'DELETE', headers: authHeaders });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      showSuccess(t('toast.deleted', { name: nameIso(auto.name) }));
      setConfirm(null);
      await fetchAutomations();
    } catch (err) {
      showError(t('errors.delete', { name: nameIso(auto.name), error: err.message }));
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleNew = () => { setSelectedAutomation(null); setIsNewAutomation(true); setShowBuilderModal(true); };
  const handleEdit = (auto) => { setSelectedAutomation(auto); setIsNewAutomation(false); setShowBuilderModal(true); };
  const handleView = (auto) => { setSelectedAutomation(auto); setShowDetailModal(true); };
  const handleTemplateCreated = (newAutomation) => {
    fetchAutomations();
    setSelectedAutomation(newAutomation);
    setIsNewAutomation(false);
    setShowBuilderModal(true);
  };

  const confirmCopy = useMemo(() => {
    if (!confirm) return null;
    const { kind, auto, summary, targets, actions } = confirm;
    // Labels only: the channel list itself (targets) and the run / delete
    // calls are unchanged. Channel and board names are data (isolated in RTL).
    // The action comes FIRST in each item: ConfirmDialog truncates items on a
    // phone, and the part that gets cut must be the board name, never what the
    // channel will do.
    const iso = (s) => `\u2068${s}\u2069`;
    const items = targets.map((x) => {
      const detail = [
        `${actionWord(x.action, loc)}${x.value !== null && x.value !== undefined && x.action === 'set' ? ` ${x.value}` : ''}`,
        x.duration ? t('confirm.for', { duration: formatDuration(x.duration, loc) }) : '',
        x.windows > 1 ? `× ${x.windows}` : '',
        x.delay ? t(x.windows > 1 ? 'confirm.firstAfter' : 'confirm.after', { delay: formatDuration(x.delay, loc) }) : '',
      ].filter(Boolean).join(' ');
      return t('confirm.item', { detail, channel: iso(x.label), board: iso(x.eqName) });
    });
    const alerts = actions.filter(a => a?.type === 'alert').length;
    const logs = actions.filter(a => a?.type === 'log').length;
    const extrasList = [];
    if (alerts) extrasList.push(t('confirm.alertCount', { count: alerts }));
    if (logs) extrasList.push(t('confirm.logCount', { count: logs }));
    const extras = extrasList.length === 2 ? t('confirm.extrasPair', { a: extrasList[0], b: extrasList[1] }) : extrasList[0] || '';
    const boards = [...new Set(targets.map(x => x.eqName))].map(iso).join(t('summary.joinComma'));
    const channels = t('confirm.channelCount', { count: targets.length });
    const whatText = targets.length
      ? t('confirm.switches', { channels, boards, what: summary.what })
      : (extras ? t('confirm.noRelaysWith', { extras }) : t('confirm.noRelays'));
    if (kind === 'run') {
      return {
        title: t('confirm.runTitle', { name: nameIso(auto.name) }),
        body: <>{whatText}{extras && targets.length ? ` ${t('confirm.alsoSends', { extras })}` : ''}</>,
        items,
        confirmLabel: t('confirm.runNow'),
        variant: 'primary',
      };
    }
    return {
      title: t('confirm.deleteTitle', { name: nameIso(auto.name) }),
      body: <>
        <span className="font-mono tabular text-ink">{summary.text}</span>
        <br />
        {targets.length ? `${t('confirm.targets', { channels, boards })} ` : ''}
        {t('confirm.cannotUndo')}
      </>,
      items,
      confirmLabel: t('common:actions.delete'),
      variant: 'danger',
    };
  }, [confirm, t, loc]);

  // ----- render -----
  if (loading) {
    return <p className="text-sm text-muted py-12 text-center">{t('page.loading')}</p>;
  }

  if (error) {
    return (
      <div role="alert" className="p-4 rounded-card border border-alarm-200 dark:border-alarm-700 border-s-[3px] border-s-state-alarm bg-alarm-50 dark:bg-alarm-900/30 text-sm text-alarm-700 dark:text-alarm-300">
        <p>{t('errors.loadAutomations', { error })}</p>
        <Button variant="secondary" className="mt-3" onClick={() => { setLoading(true); fetchAutomations(); }}>{t('common:actions.tryAgain')}</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">{t('page.title')}</h1>
          <p className="text-sm text-muted font-mono tabular">{t('page.counts', { rules: t('page.ruleCount', { count: automations.length }), enabled: t('page.enabledCount', { count: enabledCount }) })}</p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => setShowTemplateManager(true)}>{t('page.templates')}</Button>
            <Button variant="secondary" onClick={() => setShowTemplatesModal(true)}>{t('page.fromTemplate')}</Button>
            <Button variant="primary" onClick={handleNew}>{t('page.new')}</Button>
          </div>
        )}
      </div>

      <Card padding="sm">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1">
            <label htmlFor="automation-search" className="sr-only">{t('page.searchLabel')}</label>
            <input
              id="automation-search"
              type="search"
              className={INPUT}
              placeholder={t('page.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <div>
              <label htmlFor="status-filter" className="sr-only">{t('page.statusFilterLabel')}</label>
              <select id="status-filter" className={`${INPUT} sm:w-40`} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">{t('page.allStatuses')}</option>
                <option value="enabled">{t('common:status.enabled')}</option>
                <option value="disabled">{t('common:status.disabled')}</option>
              </select>
            </div>
            <div>
              <label htmlFor="group-by" className="sr-only">{t('page.groupByLabel')}</label>
              <select id="group-by" className={`${INPUT} sm:w-44`} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                <option value="purpose">{t('page.groupPurpose')}</option>
                <option value="trigger">{t('page.groupTrigger')}</option>
              </select>
            </div>
          </div>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Card className="text-center py-10">
          <p className="font-display font-semibold text-ink">{t('page.emptyTitle')}</p>
          <p className="text-sm text-muted mt-1">
            {automations.length === 0 ? t('page.emptyFirst') : t('page.emptyFiltered')}
          </p>
          {automations.length === 0 && canEdit && <Button variant="primary" className="mt-4" onClick={handleNew}>{t('page.newAutomation')}</Button>}
        </Card>
      ) : (
        groups.map(group => (
          <section key={group.key} aria-label={group.label}>
            <SectionHeader
              title={group.label}
              right={<span className="text-sm font-mono tabular text-muted">{group.items.length}</span>}
            />
            {group.key === 'irrigation' && <StopIrrigationButton className="mb-2 bg-panel border border-line rounded-card p-3" />}
            <ul className="space-y-2">
              {group.items.map(item => (
                <AutomationRow
                  key={item.auto.id}
                  auto={item.auto}
                  summary={item.summary}
                  enabled={item.enabled}
                  offline={item.offline}
                  duplicate={item.duplicate}
                  doseProgram={item.auto.dose_program_id ? doseProgramsById[item.auto.dose_program_id] : null}
                  doseMissing={!!item.auto.dose_program_id && Object.keys(doseProgramsById).length > 0 && !doseProgramsById[item.auto.dose_program_id]}
                  canEdit={canEdit}
                  busy={busy[item.auto.id]}
                  onView={() => handleView(item.auto)}
                  onEdit={() => handleEdit(item.auto)}
                  onToggle={() => handleToggle(item.auto)}
                  onRun={() => openConfirm('run', item)}
                  onDuplicate={() => handleDuplicate(item.auto)}
                  onDelete={() => openConfirm('delete', item)}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      {automations.length > 0 && (
        <p className="text-xs font-mono tabular text-muted">{t('page.showing', { shown: filtered.length, total: automations.length })}</p>
      )}

      <AutomationBuilderModal
        isOpen={showBuilderModal}
        onClose={() => { setShowBuilderModal(false); setSelectedAutomation(null); }}
        automation={selectedAutomation}
        token={token}
        onSave={fetchAutomations}
        isNew={isNewAutomation}
        equipment={equipment}
        automations={automations}
      />

      <AutomationDetailModal
        isOpen={showDetailModal}
        onClose={() => { setShowDetailModal(false); setSelectedAutomation(null); }}
        automation={selectedAutomation}
        summary={selectedAutomation ? summarizeAutomation(selectedAutomation, equipIndex, loc) : null}
        equipIndex={equipIndex}
        onEdit={handleEdit}
        canEdit={canEdit}
        token={token}
      />

      <TemplatesModal
        isOpen={showTemplatesModal}
        onClose={() => setShowTemplatesModal(false)}
        token={token}
        onSelectTemplate={handleTemplateCreated}
      />

      <TemplateManagerModal
        isOpen={showTemplateManager}
        onClose={() => setShowTemplateManager(false)}
        token={token}
        onTemplateUpdated={fetchAutomations}
      />

      <ConfirmDialog
        open={!!confirm}
        title={confirmCopy?.title}
        body={confirmCopy?.body}
        items={confirmCopy?.items}
        variant={confirmCopy?.variant}
        confirmLabel={confirmCopy?.confirmLabel}
        busy={confirmBusy}
        onConfirm={confirm?.kind === 'run' ? runConfirmed : deleteConfirmed}
        onCancel={() => { if (!confirmBusy) setConfirm(null); }}
      />
    </div>
  );
}
