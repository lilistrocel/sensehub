/**
 * Stop irrigation API — stops ONLY the irrigation side (requirement 2026-09-27).
 *
 *   POST /api/irrigation/stop   admin + operator (viewer 403)
 *
 * Operators used Stop All (POST /api/automations/stop-all) to end irrigation runs;
 * it switches every relay on every board OFF, including the 7 fan boards
 * (incidents 2026-09-26 09:43 and 15:39, 2026-09-27 14:15:54 and 14:16:55 — fans
 * off at ~35 °C, boards 15/16 off ~6 min). This endpoint writes OFF only the
 * irrigation board (pump, mixing pump, zones 1-4) and the dosing board (pH Down,
 * Tanks A-D), cancels their pending starts, aborts the dose cycle and marks the run
 * stopped — IrrigationFlowWatchService.stopIrrigation(). Works while disarmed (OFF
 * only). Idempotent.
 *
 * Answers 200 with the per-channel result (ok: false + error when any OFF is not
 * confirmed), or 202 { inProgress: true } when the writes are still running after
 * STOP_HTTP_DEADLINE_MS (dead gateway: each write times out); the final result is
 * broadcast as `stop_irrigation_result` either way.
 *
 * i18n: `message`, `error` and `untouched` of the HTTP answer are rendered in the
 * request language (req.lang); `message_en` / `error_en` and the raw
 * message_key / message_params (error_key / error_params) come along. The WebSocket
 * broadcast keeps English `message` / `error` (backward compatible) and adds
 * message_i18n / error_i18n = { en, tr, ar } and the raw keys.
 */
const express = require('express');
const { requireRole } = require('../middleware/auth');
const i18n = require('../i18n');

/** The service's English result (+ keys) rendered for an HTTP answer in `lang`. */
function localizeStopResult(result, lang = 'en') {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result, message_en: result.message ?? null, error_en: result.error ?? null };
  try {
    if (result.message_key) out.message = i18n.t(lang, result.message_key, result.message_params || {});
    if (result.error_key) out.error = i18n.t(lang, result.error_key, result.error_params || {});
    if (result.untouched_key) out.untouched = i18n.t(lang, result.untouched_key);
  } catch (_) { /* keep English */ }
  return out;
}

/** WebSocket payload: English as before + every language. */
function broadcastStopResult(result) {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };
  try {
    if (result.message_key) out.message_i18n = i18n.renderAll({ key: result.message_key, params: result.message_params || {} });
    if (result.error_key) out.error_i18n = i18n.renderAll({ key: result.error_key, params: result.error_params || {} });
  } catch (_) { /* English only */ }
  return out;
}

/** A route-level failure text: English + key/params (rendered by the caller). */
const failure = (err) => ({ key: 'irrigation_stop.failed', params: { error: err.message } });

const STOP_HTTP_DEADLINE_MS = 20000;

function createIrrigationStopRouter({ getService, broadcast = null, deadlineMs = STOP_HTTP_DEADLINE_MS } = {}) {
  const router = express.Router();
  const emit = (type, data) => {
    try {
      const b = broadcast || global.broadcast;
      if (b) b(type, data);
    } catch (_) { /* a broadcast never fails the stop */ }
  };

  router.post('/stop', requireRole('admin', 'operator'), async (req, res) => {
    const userEmail = (req.user && req.user.email) || null;
    let stop;
    try {
      stop = getService().stopIrrigation({ userEmail });
    } catch (err) {
      console.error('[StopIrrigation] failed to start:', err.message);
      const f = failure(err);
      return res.status(500).json({ ok: false, error: i18n.t(req.lang, f.key, f.params), error_en: i18n.t('en', f.key, f.params), error_key: f.key, error_params: f.params });
    }
    stop.then(
      (result) => emit('stop_irrigation_result', broadcastStopResult({ ...result, inProgress: false })),
      (err) => {
        const f = failure(err);
        emit('stop_irrigation_result', broadcastStopResult({ ok: false, inProgress: false, stopped_by: userEmail, error: i18n.t('en', f.key, f.params), error_key: f.key, error_params: f.params }));
      },
    );
    let timer = null;
    const TIMED_OUT = Symbol('deadline');
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), deadlineMs); });
    try {
      const raced = await Promise.race([stop, deadline]);
      if (raced === TIMED_OUT) {
        console.warn(`[StopIrrigation] still switching off after ${deadlineMs} ms (requested by ${userEmail || 'unknown'}) — answering 202`);
        return res.status(202).json({
          ok: false, inProgress: true, stopped_by: userEmail,
          message: i18n.t(req.lang, 'irrigation_stop.still_switching'), message_en: i18n.t('en', 'irrigation_stop.still_switching'),
          message_key: 'irrigation_stop.still_switching', message_params: {},
        });
      }
      console.log(`[StopIrrigation] by ${userEmail || 'unknown'}: ok=${raced.ok}, ${raced.channels.filter(c => c.confirmed).length}/${raced.channels.length} OFF confirmed`);
      return res.json(localizeStopResult(raced, req.lang));
    } catch (err) {
      console.error('[StopIrrigation] failed:', err.message);
      const f = failure(err);
      return res.status(500).json({ ok: false, error: i18n.t(req.lang, f.key, f.params), error_en: i18n.t('en', f.key, f.params), error_key: f.key, error_params: f.params });
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  return router;
}

module.exports = createIrrigationStopRouter({
  getService: () => require('../services/IrrigationFlowWatchService').getFlowWatchService(),
});
module.exports.createIrrigationStopRouter = createIrrigationStopRouter;
module.exports.STOP_HTTP_DEADLINE_MS = STOP_HTTP_DEADLINE_MS;
module.exports.localizeStopResult = localizeStopResult;
module.exports.broadcastStopResult = broadcastStopResult;
