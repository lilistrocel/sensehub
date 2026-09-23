const express = require('express');
const { db } = require('../utils/database');
const { requireRole } = require('../middleware/auth');
const { executeAutomation, stopAllRelays } = require('../services/AutomationExecutor');
const { relayTimerService } = require('../services/RelayTimerService');
const { automationArmingService } = require('../services/AutomationArmingService');
const { validateAutomationActions } = require('../services/RelayInterlockService');

const lookupEquipment = (id) => db.prepare('SELECT * FROM equipment WHERE id = ?').get(id) || null;

const router = express.Router();

// GET /api/automations - List all automations
router.get('/', (req, res) => {
  const automations = db.prepare('SELECT * FROM automations ORDER BY priority ASC, name ASC').all();
  res.json(automations);
});

// POST /api/automations - Create automation (optionally from a template)
// Resolve & validate a dose_program_id passed from the form.
// Returns the numeric id to persist, or null if no program is selected.
// Throws if the id is unknown or points to a non-published program.
function resolveDoseProgramId(raw) {
  if (raw == null || raw === '' || raw === 0 || raw === '0') return null;
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  const prog = db.prepare("SELECT id, status FROM fertigation_dose_programs WHERE id = ?").get(id);
  if (!prog) {
    const err = new Error(`dose_program_id ${id} does not exist`);
    err.status = 400; throw err;
  }
  if (prog.status !== 'published') {
    const err = new Error(`dose_program_id ${id} is in '${prog.status}' status; only published programs can be assigned`);
    err.status = 400; throw err;
  }
  return id;
}

router.post('/', requireRole('admin', 'operator'), (req, res) => {
  const { name, description, trigger_config, conditions, condition_logic, actions, priority, template_id, dose_program_id } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Bad Request', message: 'Name is required' });
  }

  let doseProgId = null;
  try { doseProgId = resolveDoseProgramId(dose_program_id); }
  catch (e) { return res.status(e.status || 400).json({ error: 'Bad Request', message: e.message }); }

  // If template_id is provided, pull actions/conditions from the template
  let finalConditions = conditions || [];
  let finalConditionLogic = condition_logic || 'AND';
  let finalActions = actions || [];

  if (template_id) {
    const template = db.prepare('SELECT * FROM automation_templates WHERE id = ?').get(template_id);
    if (!template) {
      return res.status(400).json({ error: 'Bad Request', message: 'Template not found' });
    }
    try {
      finalConditions = JSON.parse(template.conditions || '[]');
      finalConditionLogic = template.condition_logic || 'AND';
      finalActions = JSON.parse(template.actions || '[]');
    } catch (e) {
      // fallback to request body values
    }
  }

  // Hard interlock: refuse to save an automation that would energise both
  // members of an interlocked relay pair.
  const interlockError = validateAutomationActions(finalActions, lookupEquipment);
  if (interlockError) {
    return res.status(400).json({ error: 'Bad Request', message: interlockError, code: 'INTERLOCK_VIOLATION' });
  }

  const result = db.prepare(
    'INSERT INTO automations (name, description, trigger_config, conditions, condition_logic, actions, priority, template_id, dose_program_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    name,
    description,
    JSON.stringify(trigger_config || {}),
    JSON.stringify(finalConditions),
    finalConditionLogic,
    JSON.stringify(finalActions),
    priority || 0,
    template_id || null,
    doseProgId,
  );

  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(automation);
});

// GET /api/automations/templates - Get automation templates (from DB)
router.get('/templates', (req, res) => {
  try {
    const templates = db.prepare('SELECT * FROM automation_templates ORDER BY is_system DESC, category, name').all();
    const parsed = templates.map(t => ({
      ...t,
      conditions: JSON.parse(t.conditions || '[]'),
      actions: JSON.parse(t.actions || '[]')
    }));
    res.json(parsed);
  } catch (err) {
    console.error('Error fetching automation templates:', err);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

// Stop-all / emergency-stop share one HTTP deadline: the coil sweep is bounded
// per board (2 s timeout, 1 attempt, 3 s connect) but a fleet of dead boards
// can still add up. We answer within STOP_ALL_HTTP_DEADLINE_MS either way —
// 200 with the final summary, or 202 with the summary-so-far while the sweep
// keeps running — and broadcast `stop_all_progress` when the sweep finishes.
const STOP_ALL_HTTP_DEADLINE_MS = 15000;
const STOP_ALL_TIMED_OUT = Symbol('stop-all-deadline');

/**
 * Run stopAllRelays() under the HTTP deadline.
 * @returns {Promise<{status: number, body: object}>}
 */
async function runStopAllWithDeadline(label, extra = {}) {
  const progress = {};
  const sweep = stopAllRelays({ progress });

  // Broadcast the final summary once the sweep completes, whether or not the
  // HTTP response has already gone out.
  sweep.then(
    (summary) => {
      try { global.broadcast('stop_all_progress', { ...summary, ...extra, label, inProgress: false }); } catch (e) {}
    },
    (err) => {
      console.error(`[Automation] ${label}: stopAllRelays failed:`, err.message);
      try {
        global.broadcast('stop_all_progress', { ...progress, ...extra, label, inProgress: false, partial: true, ok: false, error: err.message });
      } catch (e) {}
    }
  );

  let timer = null;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(STOP_ALL_TIMED_OUT), STOP_ALL_HTTP_DEADLINE_MS); });
  try {
    const raced = await Promise.race([sweep, deadline]);
    if (raced === STOP_ALL_TIMED_OUT) {
      console.warn(`[Automation] ${label}: sweep still running after ${STOP_ALL_HTTP_DEADLINE_MS}ms — responding 202 with progress so far ` +
        `(${progress.boardsDone}/${progress.boardsTotal} boards, ${progress.succeeded}/${progress.attempted} channels)`);
      return { status: 202, body: { ...progress, ...extra, partial: true, inProgress: true } };
    }
    return { status: 200, body: { ...raced, ...extra } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// POST /api/automations/stop-all - Emergency stop.
// Cancels every pending relay timer FIRST (so nothing re-energises behind us),
// then drives every writable coil of every Modbus relay equipment OFF.
// Declared before the /:id routes so it can never be swallowed by them.
router.post('/stop-all', requireRole('admin', 'operator'), async (req, res) => {
  try {
    const { status, body } = await runStopAllWithDeadline('Stop-all');
    console.log(`[Automation] Stop-all requested by ${req.user?.email || 'unknown'}: ` +
      `${body.timersCancelled} timer(s) cancelled, ${body.succeeded}/${body.attempted} channel(s) off, ${body.failed.length} failure(s)` +
      (body.inProgress ? ' (still in progress)' : ''));
    res.status(status).json(body);
  } catch (err) {
    console.error('[Automation] Stop-all failed:', err.message);
    res.status(500).json({ error: 'Stop-all failed', message: err.message });
  }
});

// GET /api/automations/timers - Pending in-memory relay timers (delayed starts,
// auto-offs, transition reverts). Read-only, any authenticated role.
// Declared before the /:id routes so it can never be swallowed by them.
router.get('/timers', (req, res) => {
  try {
    res.json(relayTimerService.getActiveTimers());
  } catch (err) {
    console.error('Error fetching relay timers:', err);
    res.status(500).json({ error: 'Failed to fetch relay timers' });
  }
});

// POST /api/automations/emergency-stop - Stop everything AND disarm.
// Same one-shot stop as /stop-all, but the disarm flag is set FIRST so no
// scheduler, watchdog rearm or armed timer can re-energise a coil behind the
// stop. Stays disarmed across a backend restart until re-armed (or until
// autoReArmMinutes elapses). Declared before the /:id routes.
// Body: { autoReArmMinutes?: number, reason?: string }
router.post('/emergency-stop', requireRole('admin', 'operator'), async (req, res) => {
  const requestedBy = req.user?.email || 'unknown';
  const { autoReArmMinutes, reason } = req.body || {};

  let armedState;
  try {
    // Disarm BEFORE stopping — a stop performed while still armed can be undone
    // by the very next scheduler tick.
    armedState = automationArmingService.disarm({
      by: req.user?.email || null,
      reason: typeof reason === 'string' && reason.trim() ? reason.trim() : null,
      autoReArmMinutes,
    });
  } catch (err) {
    console.error('[Automation] Emergency-stop failed to disarm:', err.message);
    return res.status(500).json({ error: 'Emergency stop failed', message: `Could not disarm automations: ${err.message}` });
  }

  try {
    const { status, body } = await runStopAllWithDeadline('Emergency-stop', { armedState });
    console.log(`[Automation] Emergency-stop requested by ${requestedBy}: ` +
      `${body.timersCancelled} timer(s) cancelled, ${body.succeeded}/${body.attempted} channel(s) off, ${body.failed.length} failure(s)` +
      (body.inProgress ? ' (still in progress)' : '') + '; ' +
      `automations disarmed${armedState.autoReArmAt ? ` until ${armedState.autoReArmAt}` : ' until manually re-armed'}`);
    res.status(status).json(body);
  } catch (err) {
    // The disarm stands even if the coil sweep failed — staying stopped is the
    // safe outcome, and the operator can retry the stop.
    console.error('[Automation] Emergency-stop: stopAllRelays failed (automations remain disarmed):', err.message);
    res.status(500).json({ error: 'Emergency stop failed', message: err.message, armedState });
  }
});

// POST /api/automations/re-arm - Clear the emergency-stop disarm flag.
// Declared before the /:id routes.
router.post('/re-arm', requireRole('admin', 'operator'), (req, res) => {
  try {
    const armedState = automationArmingService.reArm({ by: req.user?.email || null });
    console.log(`[Automation] Re-arm requested by ${req.user?.email || 'unknown'}`);
    res.json(armedState);
  } catch (err) {
    console.error('[Automation] Re-arm failed:', err.message);
    res.status(500).json({ error: 'Re-arm failed', message: err.message });
  }
});

// GET /api/automations/armed-state - Current emergency-stop arming state.
// Read-only, any authenticated role. Declared before the /:id routes.
router.get('/armed-state', (req, res) => {
  try {
    res.json(automationArmingService.getState());
  } catch (err) {
    console.error('[Automation] Failed to read armed state:', err.message);
    res.status(500).json({ error: 'Failed to read armed state', message: err.message });
  }
});

// GET /api/automations/:id - Get automation details
router.get('/:id', (req, res) => {
  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id);

  if (!automation) {
    return res.status(404).json({ error: 'Not Found', message: 'Automation not found' });
  }

  // Get run history
  const logs = db.prepare(
    'SELECT * FROM automation_logs WHERE automation_id = ? ORDER BY triggered_at DESC LIMIT 50'
  ).all(req.params.id);

  res.json({ ...automation, logs });
});

// PUT /api/automations/:id - Update automation
router.put('/:id', requireRole('admin', 'operator'), (req, res) => {
  const { name, description, trigger_config, conditions, condition_logic, actions, priority, enabled, template_id, dose_program_id } = req.body;
  const automationId = req.params.id;

  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(automationId);

  if (!automation) {
    return res.status(404).json({ error: 'Not Found', message: 'Automation not found' });
  }

  // dose_program_id: only override when the field is explicitly present in the
  // payload (so PATCH-style partial updates don't accidentally clear an existing link).
  let finalDoseProgId = automation.dose_program_id;
  if (dose_program_id !== undefined) {
    try { finalDoseProgId = resolveDoseProgramId(dose_program_id); }
    catch (e) { return res.status(e.status || 400).json({ error: 'Bad Request', message: e.message }); }
  }

  // If linking to a template, pull actions/conditions from it
  let finalConditions = conditions ? JSON.stringify(conditions) : automation.conditions;
  let finalConditionLogic = condition_logic ?? automation.condition_logic ?? 'AND';
  let finalActions = actions ? JSON.stringify(actions) : automation.actions;
  let finalTemplateId = template_id !== undefined ? template_id : automation.template_id;

  if (template_id) {
    const template = db.prepare('SELECT * FROM automation_templates WHERE id = ?').get(template_id);
    if (template) {
      finalConditions = template.conditions;
      finalConditionLogic = template.condition_logic || 'AND';
      finalActions = template.actions;
    }
  }

  // Hard interlock validation on the actions that will actually be stored.
  try {
    const parsedActions = typeof finalActions === 'string' ? JSON.parse(finalActions || '[]') : (finalActions || []);
    const interlockError = validateAutomationActions(parsedActions, lookupEquipment);
    if (interlockError) {
      return res.status(400).json({ error: 'Bad Request', message: interlockError, code: 'INTERLOCK_VIOLATION' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'Bad Request', message: `Invalid actions: ${e.message}` });
  }

  db.prepare(
    "UPDATE automations SET name = ?, description = ?, trigger_config = ?, conditions = ?, condition_logic = ?, actions = ?, priority = ?, enabled = ?, template_id = ?, dose_program_id = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(
    name ?? automation.name,
    description ?? automation.description,
    trigger_config ? JSON.stringify(trigger_config) : automation.trigger_config,
    finalConditions,
    finalConditionLogic,
    finalActions,
    priority ?? automation.priority,
    enabled !== undefined ? (enabled ? 1 : 0) : automation.enabled,
    finalTemplateId,
    finalDoseProgId,
    automationId
  );

  const updated = db.prepare('SELECT * FROM automations WHERE id = ?').get(automationId);
  res.json(updated);
});

// DELETE /api/automations/:id - Delete automation
router.delete('/:id', requireRole('admin', 'operator'), (req, res) => {
  const result = db.prepare('DELETE FROM automations WHERE id = ?').run(req.params.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Not Found', message: 'Automation not found' });
  }

  res.json({ message: 'Automation deleted successfully' });
});

// Comparison operators shared by trigger/condition dry-run evaluation.
// PURE — no side effects. Mirrors the operators used by the scheduler/executor.
function _compare(a, op, b) {
  switch (op) {
    case 'gt':  return a > b;
    case 'gte': return a >= b;
    case 'lt':  return a < b;
    case 'lte': return a <= b;
    case 'eq':  return a === b;
    case 'neq': return a !== b;
    default:    return false;
  }
}

// Extract a numeric reading for a given sensor/field name from an equipment's
// stored last_reading. READ-ONLY: only reads equipment.last_reading from the DB,
// never writes anything, never touches Modbus/relays. Mirrors the resolution
// logic in AutomationSchedulerService._isThresholdMet so the dry-run sees the
// same value the real scheduler would.
// Returns { value: number|null, found: boolean }.
function _resolveCurrentValue(equipmentId, sensorType) {
  if (!equipmentId || !sensorType) return { value: null, found: false };
  const equipment = db.prepare('SELECT last_reading FROM equipment WHERE id = ?').get(equipmentId);
  if (!equipment || !equipment.last_reading) return { value: null, found: false };

  let reading;
  try {
    reading = typeof equipment.last_reading === 'string'
      ? JSON.parse(equipment.last_reading)
      : equipment.last_reading;
  } catch (e) {
    return { value: null, found: false };
  }

  const extractNumber = (v) => {
    if (v != null && typeof v === 'object' && v.value !== undefined) return parseFloat(v.value);
    return parseFloat(v);
  };

  let currentValue = null;
  if (reading[sensorType] !== undefined) {
    currentValue = extractNumber(reading[sensorType]);
  }
  if ((currentValue === null || Number.isNaN(currentValue)) && reading.registers) {
    for (const [key, val] of Object.entries(reading.registers)) {
      if (key.toLowerCase().includes(String(sensorType).toLowerCase())) {
        currentValue = extractNumber(val);
        break;
      }
    }
  }
  if ((currentValue === null || Number.isNaN(currentValue)) && reading.values) {
    for (const [key, val] of Object.entries(reading.values)) {
      if (key.toLowerCase().includes(String(sensorType).toLowerCase())) {
        currentValue = extractNumber(val);
        break;
      }
    }
  }

  if (currentValue === null || Number.isNaN(currentValue)) return { value: null, found: false };
  return { value: currentValue, found: true };
}

const _OP_SYM = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '==', neq: '!=' };

// POST /api/automations/:id/test - Dry-run an automation against CURRENT readings.
// Genuinely evaluates the threshold trigger and conditions against the equipment's
// latest stored readings and reports whether the automation WOULD fire. This path
// is strictly read-only: it never actuates a relay/pump, sends a Modbus command,
// or enqueues a real action. Actions are described, not executed.
router.post('/:id/test', requireRole('admin', 'operator'), (req, res) => {
  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id);

  if (!automation) {
    return res.status(404).json({ error: 'Not Found', message: 'Automation not found' });
  }

  // Parse automation configuration
  let triggerConfig, conditions, actions;
  try {
    triggerConfig = typeof automation.trigger_config === 'string'
      ? JSON.parse(automation.trigger_config)
      : automation.trigger_config || {};
    conditions = typeof automation.conditions === 'string'
      ? JSON.parse(automation.conditions)
      : automation.conditions || [];
    actions = typeof automation.actions === 'string'
      ? JSON.parse(automation.actions)
      : automation.actions || [];
  } catch (e) {
    triggerConfig = {};
    conditions = [];
    actions = [];
  }

  // Build trigger evaluation result
  const triggerEvaluation = {
    type: triggerConfig.type || 'manual',
    would_fire: true,
    details: {}
  };

  if (triggerConfig.type === 'schedule') {
    triggerEvaluation.details = {
      schedule_type: triggerConfig.schedule_type || 'daily',
      time: triggerConfig.time || '08:00',
      next_run: 'Next scheduled run calculated based on configuration'
    };
  } else if (triggerConfig.type === 'threshold') {
    const equipment = triggerConfig.equipment_id
      ? db.prepare('SELECT * FROM equipment WHERE id = ?').get(triggerConfig.equipment_id)
      : null;
    const sensorType = triggerConfig.sensor_type || 'temperature';
    const operator = triggerConfig.operator || 'gt';
    const threshold = parseFloat(triggerConfig.threshold_value);
    const { value: currentValue, found } = _resolveCurrentValue(triggerConfig.equipment_id, sensorType);

    let wouldTrigger = false;
    let currentValueLabel;
    if (!found) {
      currentValueLabel = 'No current reading available';
    } else if (Number.isNaN(threshold)) {
      currentValueLabel = `${currentValue} (invalid threshold configured)`;
    } else {
      wouldTrigger = _compare(currentValue, operator, threshold);
      currentValueLabel = `${currentValue}${triggerConfig.unit || ''}`;
    }

    // would_fire reflects the genuine evaluation against the latest reading.
    triggerEvaluation.would_fire = wouldTrigger;
    triggerEvaluation.details = {
      equipment: equipment?.name || 'Any equipment',
      sensor_type: sensorType,
      condition: `${operator} ${triggerConfig.threshold_value || 0}${triggerConfig.unit || ''}`,
      current_value: currentValueLabel,
      would_trigger: found && !Number.isNaN(threshold)
        ? (wouldTrigger ? 'Yes (threshold met)' : 'No (threshold not met)')
        : 'Unknown (no reading)'
    };
  } else if (triggerConfig.type === 'manual') {
    triggerEvaluation.details = {
      message: 'Manual trigger - fires when user clicks Run button'
    };
  }

  // Evaluate conditions against current readings (read-only).
  // A condition may carry an equipment binding (equipment_id + sensor field/metric).
  // When it does, we resolve the live value and compute a genuine pass/fail.
  // When it does not (no equipment_id, or no current reading), we report the result
  // as indeterminate rather than faking a PASS — would_pass is null in that case.
  const conditionResults = conditions.map((cond, idx) => {
    const sensorField = cond.field || cond.metric || cond.sensor_type;
    const equipmentId = cond.equipment_id;
    const threshold = parseFloat(cond.value);
    const result = {
      index: idx + 1,
      field: cond.field,
      operator: cond.operator,
      expected_value: cond.value
    };

    if (!equipmentId || !sensorField) {
      result.current_value = 'N/A (no equipment binding)';
      result.would_pass = null;
      result.test_result = 'INDETERMINATE (no equipment binding)';
      return result;
    }

    const { value: currentValue, found } = _resolveCurrentValue(equipmentId, sensorField);
    if (!found) {
      result.current_value = 'No current reading available';
      result.would_pass = null;
      result.test_result = 'INDETERMINATE (no reading)';
      return result;
    }
    if (Number.isNaN(threshold)) {
      result.current_value = currentValue;
      result.would_pass = null;
      result.test_result = 'INDETERMINATE (invalid threshold)';
      return result;
    }

    const ok = _compare(currentValue, cond.operator, threshold);
    const opSym = _OP_SYM[cond.operator] || cond.operator;
    result.current_value = currentValue;
    result.would_pass = ok;
    result.test_result = ok
      ? `PASS (${currentValue} ${opSym} ${threshold})`
      : `FAIL (${currentValue} not ${opSym} ${threshold})`;
    return result;
  });

  const conditionLogic = automation.condition_logic || 'AND';
  // Indeterminate conditions (would_pass === null) are treated as NOT met so the
  // dry-run never over-reports success. With AND, any indeterminate blocks; with OR,
  // a confirmed true still wins.
  const allConditionsMet = conditionResults.length === 0 ||
    (conditionLogic === 'AND'
      ? conditionResults.every(c => c.would_pass === true)
      : conditionResults.some(c => c.would_pass === true));

  // Simulate actions (no real execution)
  const actionResults = actions.map((action, idx) => {
    const result = {
      index: idx + 1,
      type: action.type,
      simulated: true,
      would_execute: allConditionsMet
    };

    if (action.type === 'alert') {
      result.details = {
        severity: action.severity || 'info',
        message: action.message,
        simulation_note: 'Would create alert in alerts table (NOT CREATED during test)'
      };
    } else if (action.type === 'control') {
      const equipment = action.equipment_id
        ? db.prepare('SELECT * FROM equipment WHERE id = ?').get(action.equipment_id)
        : null;
      result.details = {
        action: action.action,
        equipment: equipment?.name || action.equipment_name || 'Unknown',
        equipment_id: action.equipment_id,
        channel: action.channel != null ? action.channel : 'all',
        channel_name: action.channel_name || null,
        delay_seconds: action.delay_seconds || null,
        duration_seconds: action.duration_seconds || null,
        value: action.value,
        simulation_note: action.channel != null
          ? `Would${action.delay_seconds ? ` wait ${action.delay_seconds}s then` : ''} send FC05 to coil ${action.channel}${action.duration_seconds ? ` with ${action.duration_seconds}s auto-off` : ''} (NOT SENT during test)`
          : 'Would send control command to equipment (NOT SENT during test)'
      };
    } else if (action.type === 'log') {
      result.details = {
        message: action.message,
        simulation_note: 'Would log event (NOT LOGGED during test)'
      };
    }

    return result;
  });

  // Build comprehensive test result
  const testResult = {
    automation_id: automation.id,
    automation_name: automation.name,
    status: allConditionsMet ? 'success' : 'conditions_not_met',
    simulated: true,
    mode: 'TEST MODE - No actual actions executed',
    timestamp: new Date().toISOString(),
    summary: {
      trigger_would_fire: triggerEvaluation.would_fire,
      conditions_evaluated: conditionResults.length,
      conditions_logic: conditionLogic,
      all_conditions_met: allConditionsMet,
      actions_to_execute: actionResults.filter(a => a.would_execute).length,
      total_actions: actions.length
    },
    trigger: triggerEvaluation,
    conditions: conditionResults,
    actions: actionResults,
    message: allConditionsMet
      ? `Test completed successfully. ${actionResults.length} action(s) would be executed.`
      : `Test completed. Conditions not met - ${actionResults.length} action(s) would NOT execute.`
  };

  res.json(testResult);
});

// POST /api/automations/:id/toggle - Toggle automation enabled state
router.post('/:id/toggle', requireRole('admin', 'operator'), (req, res) => {
  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id);

  if (!automation) {
    return res.status(404).json({ error: 'Not Found', message: 'Automation not found' });
  }

  const newState = automation.enabled ? 0 : 1;
  db.prepare("UPDATE automations SET enabled = ?, updated_at = datetime('now') WHERE id = ?")
    .run(newState, req.params.id);

  res.json({ enabled: newState === 1 });
});

// POST /api/automations/:id/duplicate - Duplicate an automation
router.post('/:id/duplicate', requireRole('admin', 'operator'), (req, res) => {
  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id);

  if (!automation) {
    return res.status(404).json({ error: 'Not Found', message: 'Automation not found' });
  }

  // Create a new name with "Copy" suffix
  let newName = `${automation.name} (Copy)`;

  // Check if this name already exists, and increment the copy number if needed
  let copyNumber = 1;
  while (db.prepare('SELECT id FROM automations WHERE name = ?').get(newName)) {
    copyNumber++;
    newName = `${automation.name} (Copy ${copyNumber})`;
  }

  // Insert the duplicated automation
  const result = db.prepare(
    'INSERT INTO automations (name, description, trigger_config, conditions, condition_logic, actions, priority, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    newName,
    automation.description,
    automation.trigger_config,
    automation.conditions,
    automation.condition_logic || 'AND',
    automation.actions,
    automation.priority || 0,
    0  // Start disabled for safety
  );

  const duplicated = db.prepare('SELECT * FROM automations WHERE id = ?').get(result.lastInsertRowid);

  res.status(201).json({
    success: true,
    message: `Automation duplicated as "${newName}"`,
    automation: duplicated
  });
});

// POST /api/automations/:id/trigger - Manually trigger an automation
router.post('/:id/trigger', requireRole('admin', 'operator'), async (req, res) => {
  const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id);

  if (!automation) {
    return res.status(404).json({ error: 'Not Found', message: 'Automation not found' });
  }

  // Emergency stop gate: running an automation by hand is still running an
  // automation. Direct equipment control (POST /api/equipment/:id/control)
  // stays open so an operator can still intervene by hand during the stop.
  const arming = automationArmingService.getState();
  if (arming.disarmed) {
    console.log(`[Automation] Manual trigger of "${automation.name}" refused — automations are disarmed (requested by ${req.user?.email || 'unknown'})`);
    return res.status(409).json({
      error: 'Automations disarmed',
      message: 'An emergency stop is active. Re-arm automations before triggering this automation.',
      armedState: arming,
    });
  }

  let triggerConfig;
  try {
    triggerConfig = typeof automation.trigger_config === 'string'
      ? JSON.parse(automation.trigger_config)
      : automation.trigger_config;
  } catch (e) {
    triggerConfig = {};
  }

  try {
    const { executedActions } = await executeAutomation(automation, 'manual');
    const updated = db.prepare('SELECT * FROM automations WHERE id = ?').get(automation.id);

    res.json({
      success: true,
      automation_id: automation.id,
      automation_name: automation.name,
      trigger_type: triggerConfig?.type || 'manual',
      executed_actions: executedActions,
      run_count: updated.run_count,
      last_run: updated.last_run,
      message: `Automation "${automation.name}" triggered successfully`
    });
  } catch (err) {
    console.error(`[Automation] Manual trigger failed for "${automation.name}":`, err.message);
    res.status(500).json({ error: 'Execution failed', message: err.message });
  }
});

module.exports = router;
