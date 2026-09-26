const express = require('express');
const { db } = require('../utils/database');
const { buildDailyReport } = require('../services/DailyReportService');

const router = express.Router();

/**
 * GET /api/reports/daily?days=7
 *
 * Per farm-local-day summaries for the last N days (read-only):
 *   - water / fertigation: ESTIMATED from relay ON-time x configured flow
 *   - measured:            MEASURED by the MQTT irrigation monitor, when present
 *                          (flow meter, per-tank dosing counters, irrigation cycles,
 *                          estimated-vs-measured comparison and fault flags)
 *   - automations, drift, power
 * See services/DailyReportService.js for the exact semantics.
 */
router.get('/daily', (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
  try {
    res.json(buildDailyReport(db, { days }));
  } catch (err) {
    console.error('[Reports] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
