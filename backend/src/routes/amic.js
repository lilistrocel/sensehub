const express = require('express');
const { amicService } = require('../services/AmicService');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/amic/status - Current state, cal/meas checks, measurements
router.get('/status', async (req, res) => {
  try {
    const status = await amicService.getStatus();
    res.json(status);
  } catch (err) {
    res.status(503).json({ connected: false, error: err.message });
  }
});

// GET /api/amic/channels - Channel config (labels, ion types)
router.get('/channels', (req, res) => {
  res.json(amicService.getChannels());
});

// PUT /api/amic/channels - Update channel labels/ion types
router.put('/channels', requireRole('admin', 'operator'), (req, res) => {
  const { channels } = req.body;
  if (!Array.isArray(channels)) return res.status(400).json({ error: 'channels array required' });
  try {
    amicService.saveChannels(channels);
    res.json({ ok: true, channels: amicService.getChannels() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/amic/measure - Run measurement cycle (~5 min)
router.post('/measure', requireRole('admin', 'operator'), async (req, res) => {
  try {
    await amicService.triggerMeasure();
    res.json({ ok: true, message: 'Measurement cycle started (~5 minutes)' });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// POST /api/amic/calibrate - Run automatic calibration cycle (~20 min)
router.post('/calibrate', requireRole('admin', 'operator'), async (req, res) => {
  try {
    await amicService.triggerCalibrate();
    res.json({ ok: true, message: 'Calibration cycle started (~20 minutes)' });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// POST /api/amic/drain - Drain cycle
router.post('/drain', requireRole('admin', 'operator'), async (req, res) => {
  try {
    await amicService.triggerDrain();
    res.json({ ok: true, message: 'Drain cycle started' });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// POST /api/amic/empty-system - Empty system / cleaning
router.post('/empty-system', requireRole('admin', 'operator'), async (req, res) => {
  try {
    await amicService.triggerEmptySystem();
    res.json({ ok: true, message: 'Empty system cycle started' });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// POST /api/amic/condition - Conditioning (electrode prep, ~120 min)
router.post('/condition', requireRole('admin', 'operator'), async (req, res) => {
  try {
    await amicService.triggerCondition();
    res.json({ ok: true, message: 'Conditioning cycle started (~120 minutes)' });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// POST /api/amic/calibrate-ph - Manual pH calibration (advanced; raw integer values)
// Body: { mv_at_ph4: number, mv_at_ph7: number }
router.post('/calibrate-ph', requireRole('admin', 'operator'), async (req, res) => {
  const { mv_at_ph4, mv_at_ph7 } = req.body;
  if (mv_at_ph4 === undefined || mv_at_ph7 === undefined) {
    return res.status(400).json({ error: 'mv_at_ph4 and mv_at_ph7 are required (raw × 100)' });
  }
  try {
    const result = await amicService.calibratePh(mv_at_ph4, mv_at_ph7);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// POST /api/amic/ph-buffers - Set the actual buffer pH values used for calibration
// Body: { buffer_low: number, buffer_high: number }
// SenseHub computes an offset and applies it to pH readings on display
router.post('/ph-buffers', requireRole('admin', 'operator'), (req, res) => {
  const { buffer_low, buffer_high } = req.body;
  if (buffer_low === undefined || buffer_high === undefined) {
    return res.status(400).json({ error: 'buffer_low and buffer_high required' });
  }
  if (buffer_high <= buffer_low) {
    return res.status(400).json({ error: 'buffer_high must be greater than buffer_low' });
  }
  try {
    const data = amicService.setPhOffset(parseFloat(buffer_low), parseFloat(buffer_high));
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/amic/capture-ph/:point — Capture live mV as a calibration point.
// Body (optional): { buffer_low: number, buffer_high: number }
//   When provided, the SenseHub-side offset config is updated atomically with the
//   capture. This prevents the device cal and the SenseHub offset from drifting
//   apart when an operator changes buffer values but only clicks Capture (not
//   "Save buffer values"). The button you're clicking determines which Modbus
//   register is written; the buffer_low/buffer_high values in the body update
//   the offset record so future readings are interpreted correctly.
router.post('/capture-ph/:point', requireRole('admin', 'operator'), async (req, res) => {
  const point = req.params.point;
  if (point !== 'low' && point !== 'high') {
    return res.status(400).json({ error: 'point must be "low" (pH 4.0) or "high" (pH 7.0)' });
  }
  const { buffer_low, buffer_high } = req.body || {};
  try {
    const result = await amicService.capturePhCalibration(point);
    let phOffset = null;
    if (buffer_low != null && buffer_high != null) {
      const bl = parseFloat(buffer_low);
      const bh = parseFloat(buffer_high);
      if (isFinite(bl) && isFinite(bh) && bh > bl) {
        phOffset = amicService.setPhOffset(bl, bh);
      }
    }
    res.json({ ok: true, ...result, ph_offset: phOffset });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// PUT /api/amic/pump-times — set PMP_INPUT_TIME / PMP_OUTPUT_TIME (admin only).
// Body: { input_seconds?: number, output_seconds?: number }  (omit a field to leave unchanged)
router.put('/pump-times', requireRole('admin'), async (req, res) => {
  const { input_seconds, output_seconds } = req.body || {};
  if (input_seconds != null && (input_seconds < 1 || input_seconds > 120)) {
    return res.status(400).json({ error: 'input_seconds must be 1-120' });
  }
  if (output_seconds != null && (output_seconds < 1 || output_seconds > 120)) {
    return res.status(400).json({ error: 'output_seconds must be 1-120' });
  }
  if (input_seconds == null && output_seconds == null) {
    return res.status(400).json({ error: 'pass at least one of input_seconds or output_seconds' });
  }
  try {
    const result = await amicService.setPumpTimes(input_seconds, output_seconds);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// GET /api/amic/cycle-history — last N completed cycles with per-channel cal/meas check flags
//   ?with_trace=1 to include the full live mV trace JSON in each row (heavier)
router.get('/cycle-history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const includeTrace = req.query.with_trace === '1' || req.query.with_trace === 'true';
  res.json(amicService.listCycleHistory(limit, includeTrace));
});

// GET /api/amic/cycle-history/:id — full row including live mV trace for one cycle
router.get('/cycle-history/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const row = amicService.getCycleHistoryById(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// GET /api/amic/schedule — current calibration schedule + computed next firing time
router.get('/schedule', (req, res) => {
  const { amicSchedulerService } = require('../services/AmicSchedulerService');
  const schedule = amicService.getSchedule();
  // Also include the most recent scheduled-cycle outcome from history (if any)
  const lastScheduled = require('../utils/database').db.prepare(
    "SELECT id, started_at, ended_at, duration_seconds, cal_check, measurement_check, live_mv_min, live_mv_max, live_mv_samples FROM amic_cycle_history WHERE source='scheduled' AND cycle_state='calibrating' ORDER BY started_at DESC LIMIT 1"
  ).get();
  let lastScheduledParsed = null;
  if (lastScheduled) {
    try {
      lastScheduledParsed = {
        ...lastScheduled,
        cal_check: lastScheduled.cal_check ? JSON.parse(lastScheduled.cal_check) : [],
        measurement_check: lastScheduled.measurement_check ? JSON.parse(lastScheduled.measurement_check) : [],
        mv_swing: (lastScheduled.live_mv_max != null && lastScheduled.live_mv_min != null)
          ? +(lastScheduled.live_mv_max - lastScheduled.live_mv_min).toFixed(1) : null,
      };
    } catch {}
  }
  res.json({
    schedule,
    next_firing_at: amicSchedulerService.nextFiringTime(schedule),
    last_scheduled_calibration: lastScheduledParsed,
  });
});

// PUT /api/amic/schedule — admin only. Body: { enabled, times: [...] }
router.put('/schedule', requireRole('admin'), (req, res) => {
  try {
    const saved = amicService.saveSchedule(req.body || {});
    res.json({ ok: true, schedule: saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/amic/live-trace — in-memory trace for the currently-active cycle (live diagnostic).
// Frontend can poll this every few seconds during a calibration to see if the pH probe
// is actually picking up mV swings as the standards alternate.
router.get('/live-trace', (req, res) => {
  res.json(amicService.getActiveLiveTrace());
});

// POST /api/amic/save-to-lab - Save last measurement values to lab_readings
// Body: { zone_id?: number, sample_date?: ISO string }
router.post('/save-to-lab', requireRole('admin', 'operator'), async (req, res) => {
  const { zone_id, sample_date } = req.body;
  try {
    const created = await amicService.saveLastMeasurementToLab(zone_id || null, sample_date || null);
    res.json({ ok: true, count: created.length, entries: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
