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
 */
const express = require('express');
const { requireRole } = require('../middleware/auth');

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
      return res.status(500).json({ ok: false, error: `Stop irrigation failed: ${err.message} — switch off at the panel.` });
    }
    stop.then(
      (result) => emit('stop_irrigation_result', { ...result, inProgress: false }),
      (err) => emit('stop_irrigation_result', { ok: false, inProgress: false, stopped_by: userEmail, error: `Stop irrigation failed: ${err.message} — switch off at the panel.` }),
    );
    let timer = null;
    const TIMED_OUT = Symbol('deadline');
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), deadlineMs); });
    try {
      const raced = await Promise.race([stop, deadline]);
      if (raced === TIMED_OUT) {
        console.warn(`[StopIrrigation] still switching off after ${deadlineMs} ms (requested by ${userEmail || 'unknown'}) — answering 202`);
        return res.status(202).json({ ok: false, inProgress: true, stopped_by: userEmail, message: 'Still switching off (a board is slow to answer). The result follows.' });
      }
      console.log(`[StopIrrigation] by ${userEmail || 'unknown'}: ok=${raced.ok}, ${raced.channels.filter(c => c.confirmed).length}/${raced.channels.length} OFF confirmed`);
      return res.json(raced);
    } catch (err) {
      console.error('[StopIrrigation] failed:', err.message);
      return res.status(500).json({ ok: false, error: `Stop irrigation failed: ${err.message} — switch off at the panel.` });
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
