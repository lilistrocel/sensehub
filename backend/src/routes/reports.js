const express = require('express');
const { db } = require('../utils/database');

const router = express.Router();

// Equipment IDs — water is Irrigation 1, fertigation is Irrigation 2
// In the future these could come from config/tags
const WATER_EQUIPMENT_ID = 1;
const FERTIGATION_EQUIPMENT_ID = 2;

/**
 * GET /api/reports/daily?days=7
 *
 * Returns per-day summaries for the last N days:
 *   - water:       total ON-time (seconds) for Waveshare Irrigation 1
 *   - fertigation: total ON-time (seconds) for Waveshare Irrigation 2
 *   - automations: runs, failures, skipped-by-dependency count
 *   - drift:       relay state drift events
 */
router.get('/daily', (req, res) => {
  const days = parseInt(req.query.days) || 7;

  try {
    const report = [];

    // Discover power meters: any equipment that has logged an "Energy Imported" reading in kWh.
    const powerMeters = db.prepare(`
      SELECT DISTINCT r.equipment_id, e.name
      FROM readings r
      JOIN equipment e ON e.id = r.equipment_id
      WHERE r.name = 'Energy Imported' AND r.unit = 'kWh'
      ORDER BY r.equipment_id
    `).all();

    for (let d = 0; d < days; d++) {
      const dayOffset = d;
      const dateStr = db.prepare(
        "SELECT date('now', ? || ' days') as d"
      ).get(`-${dayOffset}`).d;

      const dayStart = `${dateStr} 00:00:00`;
      const dayEnd = `${dateStr} 23:59:59`;

      // Calculate ON-duration by pairing ON events with next OFF event
      const calcOnTime = (equipmentId) => {
        const onEvents = db.prepare(`
          SELECT re1.channel, re1.created_at as on_time,
            (SELECT MIN(re2.created_at) FROM relay_events re2
             WHERE re2.equipment_id = re1.equipment_id AND re2.channel = re1.channel
             AND re2.state = 0 AND re2.created_at > re1.created_at) as off_time
          FROM relay_events re1
          WHERE re1.equipment_id = ? AND re1.state = 1
            AND re1.created_at BETWEEN ? AND ?
        `).all(equipmentId, dayStart, dayEnd);

        let totalSeconds = 0;
        let eventCount = 0;
        const channelSeconds = {};

        for (const ev of onEvents) {
          if (!ev.off_time) continue; // still ON or no matching OFF
          const onMs = new Date(ev.on_time + 'Z').getTime();
          const offMs = new Date(ev.off_time + 'Z').getTime();
          const dur = Math.round((offMs - onMs) / 1000);
          if (dur > 0 && dur < 86400) { // sanity: skip >24h durations
            totalSeconds += dur;
            eventCount++;
            const ch = ev.channel;
            channelSeconds[ch] = (channelSeconds[ch] || 0) + dur;
          }
        }

        return { total_seconds: totalSeconds, events: eventCount, by_channel: channelSeconds };
      };

      const water = calcOnTime(WATER_EQUIPMENT_ID);
      const fertigation = calcOnTime(FERTIGATION_EQUIPMENT_ID);

      // Calculate liters using relay_channel_config flow rates
      const calcLiters = (onTimeResult, equipmentId) => {
        let totalLiters = 0;
        const channelLiters = {};
        const channelDetails = {};

        for (const [ch, seconds] of Object.entries(onTimeResult.by_channel || {})) {
          const config = db.prepare(
            'SELECT rcc.*, fi.name as ingredient_name_lookup, fm.name as mixture_name FROM relay_channel_config rcc ' +
            'LEFT JOIN fertigation_ingredients fi ON rcc.ingredient_name = fi.name ' +
            'LEFT JOIN fertigation_mixtures fm ON rcc.mixture_id = fm.id ' +
            'WHERE rcc.equipment_id = ? AND rcc.channel = ?'
          ).get(equipmentId, parseInt(ch));

          if (config && config.flow_rate > 0) {
            const liters = (seconds / 60) * config.flow_rate;
            totalLiters += liters;
            channelLiters[ch] = Math.round(liters * 100) / 100;
            channelDetails[ch] = {
              liters: channelLiters[ch],
              seconds,
              flow_rate: config.flow_rate,
              flow_unit: config.flow_unit,
              ingredient: config.ingredient_name || null,
              mixture: config.mixture_name || null
            };
          }
        }

        return { total_liters: Math.round(totalLiters * 100) / 100, by_channel: channelLiters, details: channelDetails };
      };

      const waterLiters = calcLiters(water, WATER_EQUIPMENT_ID);
      const fertLiters = calcLiters(fertigation, FERTIGATION_EQUIPMENT_ID);

      // Automation stats
      const autoStats = db.prepare(`
        SELECT
          COUNT(*) as total_runs,
          SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) as failures,
          SUM(CASE WHEN message LIKE '%skipped by dependency%' THEN 1 ELSE 0 END) as skipped_runs
        FROM automation_logs
        WHERE triggered_at BETWEEN ? AND ?
      `).get(dayStart, dayEnd);

      // Count individual skipped actions from message text (extract the number)
      const skippedActions = db.prepare(`
        SELECT message FROM automation_logs
        WHERE triggered_at BETWEEN ? AND ? AND message LIKE '%skipped by dependency%'
      `).all(dayStart, dayEnd);

      let totalSkippedActions = 0;
      for (const row of skippedActions) {
        const match = row.message.match(/(\d+) action/);
        if (match) totalSkippedActions += parseInt(match[1]);
      }

      // Drift events
      const driftCount = db.prepare(`
        SELECT COUNT(*) as count FROM relay_drift_log
        WHERE created_at BETWEEN ? AND ?
      `).get(dayStart, dayEnd).count;

      // Power consumption per meter: daily kWh imported = MAX(value) - MIN(value)
      // "Energy Imported" is a monotonically increasing cumulative counter, so the
      // delta between first and last sample of the day is the day's consumption.
      const power = {};
      let powerTotalKwh = 0;
      for (const pm of powerMeters) {
        // readings.timestamp is stored in ISO-Z form (e.g. 2026-05-17T13:00:54.027Z),
        // so match by extracted date rather than a space-separated BETWEEN range.
        const row = db.prepare(`
          SELECT MIN(value) as start_v, MAX(value) as end_v, COUNT(*) as samples
          FROM readings
          WHERE equipment_id = ? AND name = 'Energy Imported'
            AND date(timestamp) = ?
        `).get(pm.equipment_id, dateStr);
        const kwh = (row && row.samples > 0 && row.start_v != null && row.end_v != null)
          ? Math.max(0, row.end_v - row.start_v)
          : 0;
        const rounded = Math.round(kwh * 100) / 100;
        power[pm.equipment_id] = {
          equipment_id: pm.equipment_id,
          name: pm.name,
          kwh: rounded,
          start: row?.start_v ?? null,
          end: row?.end_v ?? null,
          samples: row?.samples ?? 0,
        };
        powerTotalKwh += rounded;
      }

      report.push({
        date: dateStr,
        water: {
          total_seconds: water.total_seconds,
          total_minutes: Math.round(water.total_seconds / 60),
          total_liters: waterLiters.total_liters,
          events: water.events,
          by_channel: water.by_channel,
          liters_by_channel: waterLiters.by_channel,
          channel_details: waterLiters.details
        },
        fertigation: {
          total_seconds: fertigation.total_seconds,
          total_minutes: Math.round(fertigation.total_seconds / 60),
          total_liters: fertLiters.total_liters,
          events: fertigation.events,
          by_channel: fertigation.by_channel,
          liters_by_channel: fertLiters.by_channel,
          channel_details: fertLiters.details
        },
        automations: {
          total_runs: autoStats.total_runs || 0,
          failures: autoStats.failures || 0,
          skipped_runs: autoStats.skipped_runs || 0,
          skipped_actions: totalSkippedActions
        },
        drift_events: driftCount,
        power: {
          total_kwh: Math.round(powerTotalKwh * 100) / 100,
          by_meter: power,
        }
      });
    }

    // Equipment names for context
    const waterEq = db.prepare('SELECT name FROM equipment WHERE id = ?').get(WATER_EQUIPMENT_ID);
    const fertEq = db.prepare('SELECT name FROM equipment WHERE id = ?').get(FERTIGATION_EQUIPMENT_ID);

    res.json({
      days,
      water_equipment: { id: WATER_EQUIPMENT_ID, name: waterEq?.name },
      fertigation_equipment: { id: FERTIGATION_EQUIPMENT_ID, name: fertEq?.name },
      power_meters: powerMeters,
      report
    });
  } catch (err) {
    console.error('[Reports] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
