/**
 * /api/ai/data-sources — which farm systems the AI jobs (daily agronomist report,
 * nightly planner) may look at. Shared setting, see services/AiDataSources.js.
 */
const express = require('express');
const { aiDataSources, SOURCES } = require('../services/AiDataSources');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

function respond(res) {
  const eff = aiDataSources.effective();
  res.json({
    sources: eff.sources,               // per key: enabled, reason, until, effective_enabled, expired, label, feeds
    order: SOURCES.map(s => s.key),     // display order
    excluded_equipment_ids: eff.excluded_equipment_ids,
    disabled: eff.disabled,
    out_of_service_note: aiDataSources.outOfServiceNote({ effective: eff }),
  });
}

// GET /api/ai/data-sources — effective config (any authenticated user)
router.get('/', (req, res) => {
  try {
    respond(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/ai/data-sources — partial update (admin/operator). Unknown keys are rejected.
// Body: { sources?: { <key>: { enabled, reason, until } }, excluded_equipment_ids?: [int] }
router.put('/', requireRole('admin', 'operator'), (req, res) => {
  try {
    aiDataSources.setConfig(req.body || {});
    respond(res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
