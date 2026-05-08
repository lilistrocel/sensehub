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
