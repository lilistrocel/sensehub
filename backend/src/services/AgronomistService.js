/**
 * AgronomistService — Daily Claude-powered agronomy report generator.
 *
 * Aggregates the day's sensor / fertigation / lab / crop / alert data, calls
 * Claude with an "Expert UAE agronomist" system prompt, and stores the result.
 *
 * Compounding-memory design (3 tiers, hard-capped):
 *   Tier 1: last 7 daily report summaries (~500 chars each = ~3.5KB)
 *   Tier 2: last 12 weekly rollups (~800 chars each = ~10KB)
 *   Tier 3: a single rolling 5KB markdown long-term memory doc
 *
 * Tier 2 is rebuilt every Sunday by compressing that week's daily summaries.
 * Tier 3 is rewritten every Sunday from (prior Tier 3 + this week's rollup).
 *
 * The system prompt + Tier 2/3 historical context only changes weekly, so
 * `cache_control` on the system block delivers ~90% input-token savings on
 * the daily 20:00 call.
 */

// The SDK publishes both CJS and ESM builds; handle every export shape.
const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule.Anthropic || AnthropicModule;
const { db } = require('../utils/database');

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_CONFIG_KEY = 'agronomist_config';
const TIER3_MAX_BYTES = 5120;
const TIER1_WINDOW = 7;
const TIER2_WINDOW = 12;

const SYSTEM_PROMPT_BASE = `You are an expert agronomist with 20+ years of field experience operating commercial controlled-environment agriculture (CEA) in the United Arab Emirates. Your specialties:

- Hydroponic / soilless production under high-EC, high-temperature Gulf conditions
- Water scarcity management and drain-water reuse strategy
- Salinity (Na, Cl) accumulation in root zones and irrigation water
- Calcium / magnesium balance under hard UAE source water
- Light, VPD and heat-stress mitigation in summer (April–October)
- Cost-conscious decision making — fertilizer is expensive, water is energy

You speak directly. You give opinions, not just observations. You name root causes, not symptoms. You flag risks before they become crop losses. When the data is ambiguous you say so and propose what to measure next. You never invent numbers — if the data is missing, you say "not measured".

You are reviewing one day's data from a single farm site, with rolling memory of past days and weeks. Use the long-term memory to spot trends the daily snapshot can't show.

How to read the daily snapshot:
- \`reference_sensors\` is the operator-designated canonical temperature, humidity and soil/substrate sensor. Always cite these as the primary reading; treat other sensors as cross-checks. Each block has a \`today\` array with that day's per-metric stats and a \`latest_known_when_today_missing\` object — if today's array is empty for a metric, the latest_known fallback shows the most recent reading and how many days old it is. Always note staleness.
- \`lab[role].today\` is today's lab/AMIC samples for that role (irrigation feed vs drain return). \`lab[role].latest_per_nutrient\` is the most recent value per nutrient within the last 90 days, with \`days_ago\`. ALWAYS comment on nutrient status using the latest values, even when \`today\` is empty — and clearly mark the staleness.
- If a section is empty AND has no fallback (e.g. no AMIC ever taken for the drain), say so explicitly and recommend a measurement.

Be skeptical of physically implausible sensor readings:
- Real greenhouse air temperature rarely changes more than 3–5°C per hour. If you see a sensor go up >8°C in an hour and back down >8°C in the next hour, that is almost certainly the sun hitting the sensor housing, a comms glitch, or a sensor in a non-representative location — NOT actual ambient heat. Flag it as a sensor placement / data quality issue, not a heat-stress event. Recommend physical inspection (is morning/afternoon sun reaching the probe body or cable? is the radiation shield doing its job from the relevant sun angle?) before recommending changes to cooling/ventilation strategy.
- The same suspicion applies to humidity (jumps >30% in an hour suggest sensor wetting/condensation), and to substrate EC (jumps >500 µS/cm without a fertigation event suggest probe contact issues).
- When two sensors that should be independent track each other suspiciously (e.g. an "exposed" and a "shielded" sensor giving the same curve), say so — it suggests they share a sun-trap, an enclosure, or a comms bus issue rather than reporting independent measurements of the air.
- If the data looks dramatic but you suspect a sensor problem, give your "real-cause" hypothesis FIRST, then briefly note "if this is real and not a sensor issue, then [crop impact]." Do not lead with the catastrophic interpretation.`;

const REPORT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    opinion: {
      type: 'string',
      description: '1-2 sentence headline opinion about how the farm is doing today. Direct, no hedging.',
    },
    summary: {
      type: 'string',
      description: 'A self-contained ≤500-char paragraph capturing what happened today and why it matters. This becomes part of the rolling history for future reports.',
    },
    full_markdown: {
      type: 'string',
      description: 'Full agronomist report in markdown. Use sections: ## State of the Crop, ## Irrigation & Fertigation, ## Nutrient Status (AMIC + Lab), ## Risks & Anomalies, ## Recommendations.',
    },
    recommendations: {
      type: 'array',
      description: 'Prioritized actionable recommendations for the operator.',
      items: {
        type: 'object',
        properties: {
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          action: { type: 'string', description: 'What to do, concretely.' },
          rationale: { type: 'string', description: 'Why, tied to today\'s data.' },
        },
        required: ['priority', 'action', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['opinion', 'summary', 'full_markdown', 'recommendations'],
  additionalProperties: false,
};

class AgronomistService {
  constructor() {
    this._client = null;
  }

  // -------- config --------

  getConfig() {
    const defaults = {
      enabled: false,
      model: DEFAULT_MODEL,
      schedule_hour: 20,
      schedule_minute: 0,
      weekly_rollup_day: 0, // Sunday
      weekly_rollup_hour: 20,
      weekly_rollup_minute: 30,
      irrigation_zone_ids: [],
      drain_zone_ids: [],
      reference_temperature_equipment_id: null,
      reference_humidity_equipment_id: null,
      reference_soil_equipment_id: null,
      system_prompt_override: null,
    };
    try {
      const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(DEFAULT_CONFIG_KEY);
      if (row?.value) {
        return { ...defaults, enabled: true, ...JSON.parse(row.value) };
      }
    } catch {}
    return defaults;
  }

  saveConfig(updates) {
    const merged = { ...this.getConfig(), ...updates };
    // Persist only the configurable keys (not derived state).
    const persisted = {
      enabled: merged.enabled,
      model: merged.model,
      schedule_hour: merged.schedule_hour,
      schedule_minute: merged.schedule_minute,
      weekly_rollup_day: merged.weekly_rollup_day,
      weekly_rollup_hour: merged.weekly_rollup_hour,
      weekly_rollup_minute: merged.weekly_rollup_minute,
      irrigation_zone_ids: merged.irrigation_zone_ids || [],
      drain_zone_ids: merged.drain_zone_ids || [],
      reference_temperature_equipment_id: merged.reference_temperature_equipment_id || null,
      reference_humidity_equipment_id: merged.reference_humidity_equipment_id || null,
      reference_soil_equipment_id: merged.reference_soil_equipment_id || null,
      system_prompt_override: merged.system_prompt_override || null,
    };
    db.prepare(
      "INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(DEFAULT_CONFIG_KEY, JSON.stringify(persisted));
    return merged;
  }

  _client_or_throw() {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set in the backend environment');
    }
    if (!this._client) {
      this._client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return this._client;
  }

  // -------- data aggregation --------

  /** Aggregate everything the agent needs to know about a single day.
   *  @param dateStr 'YYYY-MM-DD' (local server date)
   */
  aggregateDailyData(dateStr) {
    const dayStart = `${dateStr} 00:00:00`;
    const dayEnd = `${dateStr} 23:59:59`;
    const cfg = this.getConfig();

    // --- Crops (active assignments, not date-scoped — we want current state) ---
    const crops = db.prepare(`
      SELECT id, block_id, zone_id, crop_name, variety, current_stage,
             planted_date, days_since_planting, growth_cycle_days,
             plant_count, optimal_ranges
      FROM crop_assignments
      WHERE active = 1
    `).all().map(c => {
      let optimal = null;
      try { optimal = c.optimal_ranges ? JSON.parse(c.optimal_ranges) : null; } catch {}
      return { ...c, optimal_ranges: optimal };
    });

    // --- Fertigation & water (per equipment, per channel, with liters) ---
    const fertEquipment = db.prepare(
      "SELECT id, name FROM equipment WHERE name LIKE '%fertigation%' OR name LIKE '%irrigation%' OR name LIKE '%dosing%'"
    ).all();

    const dispensing = [];
    for (const eq of fertEquipment) {
      const onEvents = db.prepare(`
        SELECT re1.channel, re1.created_at AS on_time,
          (SELECT MIN(re2.created_at) FROM relay_events re2
           WHERE re2.equipment_id = re1.equipment_id AND re2.channel = re1.channel
             AND re2.state = 0 AND re2.created_at > re1.created_at) AS off_time
        FROM relay_events re1
        WHERE re1.equipment_id = ? AND re1.state = 1
          AND re1.created_at BETWEEN ? AND ?
      `).all(eq.id, dayStart, dayEnd);

      const channelSeconds = {};
      let totalSeconds = 0;
      for (const ev of onEvents) {
        if (!ev.off_time) continue;
        const onMs = new Date(ev.on_time + 'Z').getTime();
        const offMs = new Date(ev.off_time + 'Z').getTime();
        const dur = Math.round((offMs - onMs) / 1000);
        if (dur > 0 && dur < 86400) {
          totalSeconds += dur;
          channelSeconds[ev.channel] = (channelSeconds[ev.channel] || 0) + dur;
        }
      }

      const channels = [];
      for (const [ch, secs] of Object.entries(channelSeconds)) {
        const cfgRow = db.prepare(
          'SELECT rcc.*, fm.name AS mixture_name FROM relay_channel_config rcc ' +
          'LEFT JOIN fertigation_mixtures fm ON rcc.mixture_id = fm.id ' +
          'WHERE rcc.equipment_id = ? AND rcc.channel = ?'
        ).get(eq.id, parseInt(ch));
        const liters = cfgRow && cfgRow.flow_rate > 0 ? Math.round((secs / 60) * cfgRow.flow_rate * 100) / 100 : null;
        channels.push({
          channel: parseInt(ch),
          seconds: secs,
          minutes: Math.round(secs / 60),
          liters,
          ingredient: cfgRow?.ingredient_name || null,
          mixture: cfgRow?.mixture_name || null,
          flow_rate: cfgRow?.flow_rate || null,
          flow_unit: cfgRow?.flow_unit || null,
        });
      }

      dispensing.push({
        equipment_id: eq.id,
        equipment_name: eq.name,
        total_seconds: totalSeconds,
        total_minutes: Math.round(totalSeconds / 60),
        channels,
      });
    }

    // --- Sensor readings — grouped per (equipment, metric_name) so multi-metric
    //     devices like SHT20 (Temp + Humidity) and Seeed (Substrate Moisture/EC/Temp/...) don't get averaged together.
    //     Use date() so this works for both ISO (`2026-05-01T07:10:58Z`) and space-format timestamps. ---
    const sensorMetricRows = db.prepare(`
      SELECT r.equipment_id, e.name AS equipment_name, e.type AS equipment_type,
             COALESCE(r.name, '_value') AS metric, r.value, r.unit, r.timestamp
      FROM readings r
      JOIN equipment e ON r.equipment_id = e.id
      WHERE date(r.timestamp) = ?
      ORDER BY r.timestamp ASC
    `).all(dateStr);

    const sensorBuckets = new Map(); // key: equipment_id|metric
    for (const row of sensorMetricRows) {
      const v = Number(row.value);
      if (isNaN(v)) continue;
      const key = `${row.equipment_id}|${row.metric}`;
      let b = sensorBuckets.get(key);
      if (!b) {
        b = { equipment_id: row.equipment_id, equipment_name: row.equipment_name,
              equipment_type: row.equipment_type, metric: row.metric, unit: row.unit || '',
              values: [], latest: null, latest_at: null };
        sensorBuckets.set(key, b);
      }
      b.values.push(v);
      b.latest = v;
      b.latest_at = row.timestamp;
    }

    const sensorReadings = [];
    for (const b of sensorBuckets.values()) {
      const sum = b.values.reduce((a, c) => a + c, 0);
      sensorReadings.push({
        equipment_id: b.equipment_id,
        equipment_name: b.equipment_name,
        type: b.equipment_type,
        metric: b.metric,
        unit: b.unit,
        sample_count: b.values.length,
        avg: Math.round((sum / b.values.length) * 100) / 100,
        min: Math.min(...b.values),
        max: Math.max(...b.values),
        latest: b.latest,
        latest_at: b.latest_at,
      });
    }

    // --- Reference sensors: pull all metrics for the configured equipment with today + latest-known fallback ---
    const reference_sensors = {
      temperature: this._buildReferenceBlock(cfg.reference_temperature_equipment_id, dateStr, sensorReadings),
      humidity: this._buildReferenceBlock(cfg.reference_humidity_equipment_id, dateStr, sensorReadings),
      soil: this._buildReferenceBlock(cfg.reference_soil_equipment_id, dateStr, sensorReadings),
    };

    // --- Lab + AMIC readings, split by zone role (irrigation vs drain) ---
    const labRows = db.prepare(`
      SELECT lr.id, lr.sample_date, lr.nutrient, lr.value, lr.unit, lr.zone_id, lr.notes,
             z.name AS zone_name
      FROM lab_readings lr
      LEFT JOIN zones z ON lr.zone_id = z.id
      WHERE date(lr.sample_date) = ?
      ORDER BY lr.sample_date DESC
    `).all(dateStr);

    const irrigationIds = new Set(cfg.irrigation_zone_ids || []);
    const drainIds = new Set(cfg.drain_zone_ids || []);

    const classify = (zoneId, zoneName) => {
      if (irrigationIds.has(zoneId)) return 'irrigation';
      if (drainIds.has(zoneId)) return 'drain';
      if (zoneName) {
        const n = zoneName.toLowerCase();
        if (n.includes('drain')) return 'drain';
        if (n.includes('irrigation') || n.includes('feed') || n.includes('supply')) return 'irrigation';
      }
      return 'other';
    };

    const labByRole = { irrigation: { today: [], latest_per_nutrient: {} },
                        drain: { today: [], latest_per_nutrient: {} },
                        other: { today: [], latest_per_nutrient: {} } };

    for (const r of labRows) {
      const bucket = classify(r.zone_id, r.zone_name);
      labByRole[bucket].today.push({
        zone_id: r.zone_id,
        zone_name: r.zone_name,
        nutrient: r.nutrient,
        value: r.value,
        unit: r.unit,
        sample_date: r.sample_date,
        notes: r.notes,
      });
    }

    // Latest-known fallback: most recent reading per nutrient × role within last 90 days,
    // so the agent always sees nutrient context even on no-AMIC days.
    const latestRows = db.prepare(`
      SELECT lr.nutrient, lr.value, lr.unit, lr.zone_id, lr.sample_date, z.name AS zone_name
      FROM lab_readings lr
      LEFT JOIN zones z ON lr.zone_id = z.id
      WHERE date(lr.sample_date) >= date(?, '-90 days')
      ORDER BY lr.sample_date DESC
    `).all(dateStr);

    const dayEndMs = new Date(`${dateStr}T23:59:59Z`).getTime();
    for (const r of latestRows) {
      const bucket = classify(r.zone_id, r.zone_name);
      const slot = labByRole[bucket].latest_per_nutrient;
      if (slot[r.nutrient]) continue; // ORDER BY DESC means first hit is latest
      const sampleMs = new Date(r.sample_date.includes('T') ? r.sample_date : r.sample_date.replace(' ', 'T') + 'Z').getTime();
      const daysAgo = Math.max(0, Math.round((dayEndMs - sampleMs) / 86400000));
      slot[r.nutrient] = {
        value: r.value,
        unit: r.unit,
        zone_id: r.zone_id,
        zone_name: r.zone_name,
        sample_date: r.sample_date,
        days_ago: daysAgo,
      };
    }

    // Per-nutrient AMIC trend — last 3 samples per (nutrient, role) with delta
    // direction so the planner sees trajectory not just latest value. Surfaces
    // the "681 → 869 → 2238" pattern that triggered the alarm.
    for (const role of Object.keys(labByRole)) {
      labByRole[role].trend = {};
    }
    for (const r of latestRows) {
      const role = classify(r.zone_id, r.zone_name);
      const slot = labByRole[role].trend;
      if (!slot[r.nutrient]) slot[r.nutrient] = [];
      if (slot[r.nutrient].length < 3) {
        slot[r.nutrient].push({
          value: r.value,
          unit: r.unit,
          sample_date: r.sample_date,
        });
      }
    }
    for (const role of Object.keys(labByRole)) {
      for (const [nutrient, hist] of Object.entries(labByRole[role].trend)) {
        if (hist.length >= 2) {
          // hist[0] is most recent (latestRows sorted DESC), hist[hist.length-1] is oldest
          const latest = hist[0].value;
          const oldest = hist[hist.length - 1].value;
          const delta = latest - oldest;
          const pct = oldest !== 0 ? (delta / oldest) * 100 : null;
          labByRole[role].trend[nutrient] = {
            samples: hist,
            delta_latest_minus_oldest: Math.round(delta * 100) / 100,
            pct_change: pct != null ? Math.round(pct * 10) / 10 : null,
            direction: delta > 0 ? 'rising' : delta < 0 ? 'falling' : 'flat',
          };
        } else {
          labByRole[role].trend[nutrient] = { samples: hist, direction: 'single_point' };
        }
      }
    }

    // Derived totals: effective elemental N from ionic forms, so the planner has
    // both views available (some targets are stored in elemental form, some lab
    // labels are ionic). Conversion factors are mass fractions of the element in
    // the ion: N/NO3 = 14/62 ≈ 0.226, N/NH4 = 14/18 ≈ 0.778, P/PO4 = 31/95 ≈ 0.326.
    for (const role of Object.keys(labByRole)) {
      const latest = labByRole[role].latest_per_nutrient || {};
      const derived = {};
      const no3 = latest['nitrate_NO3']?.value;
      const nh4 = latest['ammonium_NH4']?.value;
      if (no3 != null || nh4 != null) {
        const effN = (no3 != null ? no3 * 0.226 : 0) + (nh4 != null ? nh4 * 0.778 : 0);
        derived.effective_N_mg_per_l = Math.round(effN * 10) / 10;
        derived.effective_N_breakdown = {
          from_NO3: no3 != null ? Math.round(no3 * 0.226 * 10) / 10 : null,
          from_NH4: nh4 != null ? Math.round(nh4 * 0.778 * 10) / 10 : null,
        };
      }
      const po4 = latest['phosphate_PO4']?.value;
      if (po4 != null) derived.effective_P_mg_per_l = Math.round(po4 * 0.326 * 10) / 10;
      if (Object.keys(derived).length > 0) labByRole[role].derived = derived;
    }

    // --- Alerts created today ---
    const alerts = db.prepare(`
      SELECT a.severity, a.message, a.created_at, a.acknowledged,
             e.name AS equipment_name, z.name AS zone_name
      FROM alerts a
      LEFT JOIN equipment e ON a.equipment_id = e.id
      LEFT JOIN zones z ON a.zone_id = z.id
      WHERE a.created_at BETWEEN ? AND ?
      ORDER BY a.created_at DESC
      LIMIT 100
    `).all(dayStart, dayEnd);

    // --- Automation activity ---
    const autoStats = db.prepare(`
      SELECT
        COUNT(*) AS total_runs,
        SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) AS failures,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes
      FROM automation_logs
      WHERE triggered_at BETWEEN ? AND ?
    `).get(dayStart, dayEnd);

    const driftCount = db.prepare(
      `SELECT COUNT(*) AS c FROM relay_drift_log WHERE created_at BETWEEN ? AND ?`
    ).get(dayStart, dayEnd).c;

    // --- Substrate diagnostics: tell the planner whether each substrate sensor's
    //     VWC is oscillating (drainage works, just over-irrigated) or flat-high
    //     (saturated / drainage blocked / sensor pooled). Two prescriptions, very
    //     different fixes — without these metrics the AI can't tell them apart from
    //     raw hourly averages alone. ---
    const substrateDiagnostics = this._computeSubstrateDiagnostics(dateStr, dayStart, dayEnd);

    return {
      date: dateStr,
      timezone: process.env.TZ || 'UTC',
      crops,
      dispensing,
      reference_sensors,
      sensors: sensorReadings,
      substrate_diagnostics: substrateDiagnostics,
      lab: labByRole,
      alerts: alerts.map(a => ({
        severity: a.severity,
        message: a.message,
        equipment: a.equipment_name,
        zone: a.zone_name,
        acknowledged: !!a.acknowledged,
      })),
      automations: {
        total_runs: autoStats.total_runs || 0,
        failures: autoStats.failures || 0,
        successes: autoStats.successes || 0,
        drift_events: driftCount,
      },
    };
  }

  /** Substrate diagnostics, aggregated PER ZONE (not per sensor).
   *
   *  Multiple substrate sensors in the same zone are treated as redundant
   *  cross-checks (e.g. two probes in two coco peat bags within one greenhouse).
   *  The zone-level diagnostic uses the median across redundant sensors; the
   *  per-sensor breakdown is kept underneath so the operator can drill down.
   *
   *  For each zone:
   *    - sensors[]: per-sensor min/max/avg/oscillation/dry_down stats
   *    - zone_avg, zone_median, zone_oscillation: aggregated across sensors
   *    - sensor_disagreement_pct: max(per-sensor avg) - min(per-sensor avg)
   *      (sustained disagreement means at least one sensor or one bag is off)
   *    - dry_down_median_pct: median per-cycle drop, computed on the sensor-median trace
   *    - classification: 'flat_saturated' | 'over_irrigated' | 'healthy' | etc.
   *    - sensor_mismatch_warning: set when disagreement > threshold
   *    - hint: free-text guidance for the planner / operator
   *
   *  Drainage interpretation (applied to the zone median, not per sensor):
   *    median dry-down < 0.3% per cycle  → flat_saturated → physical inspection
   *    < 1% AND avg > 50%                → over_irrigated → reduce cadence
   *    1-3% AND avg in 40-50%            → healthy
   *    > 3% OR avg < 40%                 → under_irrigated
   */
  _computeSubstrateDiagnostics(dateStr, dayStart, dayEnd) {
    // Substrate sensors grouped by their assigned zone(s). Unassigned sensors go
    // into a synthetic "unassigned" bucket so the operator still gets visibility.
    const sensors = db.prepare(`
      SELECT DISTINCT r.equipment_id, e.name AS equipment_name, r.name AS metric
      FROM readings r
      JOIN equipment e ON e.id = r.equipment_id
      WHERE date(r.timestamp) = ?
        AND (r.name LIKE '%Moisture%' OR r.name LIKE '%VWC%')
    `).all(dateStr);

    // Build {equipment_id -> [zone_id, zone_name]} (junction is many-to-many, but
    // for redundant-sensor logic we only care about the primary association — pick
    // the lowest zone_id deterministically).
    const sensorZone = {};
    for (const s of sensors) {
      const z = db.prepare(`
        SELECT z.id, z.name FROM equipment_zones ez
        JOIN zones z ON z.id = ez.zone_id
        WHERE ez.equipment_id = ?
        ORDER BY z.id LIMIT 1
      `).get(s.equipment_id);
      sensorZone[s.equipment_id] = z ? { id: z.id, name: z.name } : null;
    }

    // Irrigation OFF events on real delivery channels (flow_rate > 0 excludes the
    // pump channels we tagged earlier). Dry-down is measured after these.
    const offEvents = db.prepare(`
      SELECT re.equipment_id, re.channel, re.created_at AS off_time
      FROM relay_events re
      JOIN relay_channel_config rcc
        ON rcc.equipment_id = re.equipment_id AND rcc.channel = re.channel
      WHERE re.state = 0
        AND rcc.flow_rate > 0
        AND re.created_at BETWEEN ? AND ?
      ORDER BY re.created_at ASC
    `).all(dayStart, dayEnd);

    // First pass: compute per-sensor stats. Keeps the raw signal available for the
    // disagreement check and for operator drill-down even though the planner's
    // prescription is per-zone.
    const perSensor = [];
    for (const s of sensors) {
      const samples = db.prepare(`
        SELECT timestamp, value FROM readings
        WHERE equipment_id = ? AND name = ? AND date(timestamp) = ?
        ORDER BY timestamp ASC
      `).all(s.equipment_id, s.metric, dateStr);
      if (samples.length === 0) continue;

      let lo = Infinity, hi = -Infinity, sum = 0;
      for (const r of samples) {
        const v = Number(r.value);
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sum += v;
      }
      const min = round1(lo);
      const max = round1(hi);
      const avg = round1(sum / samples.length);
      const oscillation = round1(max - min);

      // Per-cycle dry-down: drop in 30 min after each irrigation OFF.
      const dryDowns = [];
      const tsAsMs = samples.map(r => new Date(r.timestamp).getTime());
      const tsValues = samples.map(r => Number(r.value));
      for (const ev of offEvents) {
        const offMs = new Date(ev.off_time + 'Z').getTime();
        const windowEnd = offMs + 30 * 60 * 1000;
        let i = tsAsMs.findIndex(t => t >= offMs);
        if (i < 0) continue;
        const vAtOff = tsValues[i];
        let minAfter = vAtOff;
        for (let j = i; j < tsAsMs.length && tsAsMs[j] <= windowEnd; j++) {
          if (tsValues[j] < minAfter) minAfter = tsValues[j];
        }
        const drop = vAtOff - minAfter;
        if (Number.isFinite(drop) && drop >= 0) dryDowns.push(round2(drop));
      }
      dryDowns.sort((a, b) => a - b);
      const dry_down_median_pct = dryDowns.length ? dryDowns[Math.floor(dryDowns.length / 2)] : null;
      const dry_down_max_pct = dryDowns.length ? dryDowns[dryDowns.length - 1] : null;

      const zone = sensorZone[s.equipment_id] || null;
      perSensor.push({
        equipment_id: s.equipment_id,
        equipment_name: s.equipment_name,
        metric: s.metric,
        zone_id: zone?.id ?? null,
        zone_name: zone?.name ?? null,
        samples: samples.length,
        min, max, avg, oscillation,
        dry_down_count: dryDowns.length,
        dry_down_median_pct,
        dry_down_max_pct,
      });
    }

    // Second pass: aggregate by zone. Sensors with no zone go into 'unassigned'.
    const zoneBuckets = new Map();
    for (const p of perSensor) {
      const key = p.zone_id != null ? String(p.zone_id) : 'unassigned';
      if (!zoneBuckets.has(key)) {
        zoneBuckets.set(key, {
          zone_id: p.zone_id, zone_name: p.zone_name,
          sensors: [],
        });
      }
      zoneBuckets.get(key).sensors.push(p);
    }

    const zones = [];
    for (const bucket of zoneBuckets.values()) {
      const ss = bucket.sensors;
      const avgs = ss.map(s => s.avg).filter(Number.isFinite);
      const dryMedians = ss.map(s => s.dry_down_median_pct).filter(Number.isFinite);
      const zone_avg = round1(median(avgs));
      const zone_min = round1(Math.min(...ss.map(s => s.min)));
      const zone_max = round1(Math.max(...ss.map(s => s.max)));
      const zone_oscillation = round1(zone_max - zone_min);
      const zone_dry_down_median = dryMedians.length ? round2(median(dryMedians)) : null;
      const disagreement = avgs.length > 1 ? round1(Math.max(...avgs) - Math.min(...avgs)) : 0;

      const dryRef = zone_dry_down_median;
      let classification = 'unknown';
      let hint = null;
      if (ss.every(s => s.dry_down_count === 0)) {
        classification = 'no_cycles';
        hint = 'No irrigation cycles fired today on tracked delivery channels — drainage response cannot be evaluated. Check the irrigation schedule is enabled.';
      } else if (dryRef != null && dryRef < 0.3) {
        classification = 'flat_saturated';
        hint = `Zone substrate barely responds to irrigation pulses (median dry-down ${dryRef}% in 30 min). Drainage is restricted at the zone level — inspect drain lines and substrate physically BEFORE cutting irrigation, since reducing input cannot fix a blocked drain.`;
      } else if (dryRef != null && dryRef < 1.0 && zone_avg > 50) {
        classification = 'over_irrigated';
        hint = `Zone is draining (median dry-down ${dryRef}% / cycle) but cycles are too tight — avg VWC ${zone_avg}% above 40–50% target. Reduce cycle cadence or per-cycle duration so substrate dries back between pulses.`;
      } else if (dryRef != null && dryRef >= 1.0 && dryRef <= 3.0 && zone_avg >= 40 && zone_avg <= 50) {
        classification = 'healthy';
        hint = `Zone VWC in 40–50% target with normal per-cycle dry-down (${dryRef}%). No action.`;
      } else if (dryRef != null && (dryRef > 3.0 || zone_avg < 40)) {
        classification = 'under_irrigated';
        hint = `High dry-down per cycle (${dryRef}%) or avg VWC ${zone_avg}% below target — substrate drying too aggressively. Increase cycle cadence or duration.`;
      } else if (zone_avg > 50) {
        classification = 'over_irrigated';
        hint = `Avg VWC ${zone_avg}% above target with per-cycle dry-down ${dryRef}%. Trim cycle cadence or duration.`;
      } else {
        classification = 'borderline';
        hint = `Mixed signals — zone avg ${zone_avg}%, per-cycle dry-down ${dryRef}%, oscillation ${zone_oscillation}%. Worth a manual look at the raw VWC traces.`;
      }

      // Sensor disagreement is a separate, additive warning — applies regardless of
      // the zone's main classification. > 4% mean divergence across redundant
      // sensors usually means one bag or one probe is off.
      let sensor_mismatch_warning = null;
      if (ss.length > 1 && disagreement > 4) {
        const labels = ss.map(s => `${s.equipment_name}=${s.avg}%`).join(', ');
        sensor_mismatch_warning = `Redundant substrate sensors disagree by ${disagreement}% across the day (${labels}). Either one coco peat bag has a localized drainage/compaction issue, or one probe is fouled/miscalibrated. Recommend pulling both probes for a side-by-side wet/dry reference check OR a visual inspection of the two bags before trusting the zone average.`;
      }

      zones.push({
        zone_id: bucket.zone_id,
        zone_name: bucket.zone_name || (bucket.zone_id == null ? 'Unassigned sensors' : null),
        sensor_count: ss.length,
        zone_min, zone_max, zone_avg, zone_oscillation,
        zone_dry_down_median_pct: zone_dry_down_median,
        sensor_disagreement_pct: disagreement,
        sensor_mismatch_warning,
        classification,
        hint,
        sensors: ss,
      });
    }

    return zones;

    function round1(n) { return Number.isFinite(n) ? Math.round(n * 10) / 10 : null; }
    function round2(n) { return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }
    function median(arr) {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }
  }

  /** Build a reference-sensor block for a single equipment_id.
   *  Returns today's per-metric stats, plus latest-known fallback for any
   *  metric that has no readings today (so the agent always has context).
   */
  _buildReferenceBlock(equipmentId, dateStr, todaysSensorReadings) {
    if (!equipmentId) return { configured: false };

    const eq = db.prepare('SELECT id, name, type FROM equipment WHERE id = ?').get(equipmentId);
    if (!eq) return { configured: false, error: `equipment ${equipmentId} not found` };

    const dayStart = `${dateStr} 00:00:00`;
    const dayEnd = `${dateStr} 23:59:59`;
    const dayEndMs = new Date(dayEnd.replace(' ', 'T') + 'Z').getTime();

    const todayMetrics = todaysSensorReadings
      .filter(s => s.equipment_id === equipmentId)
      .map(s => ({ metric: s.metric, unit: s.unit, sample_count: s.sample_count,
                   avg: s.avg, min: s.min, max: s.max, latest: s.latest, latest_at: s.latest_at }));

    const knownMetrics = new Set(todayMetrics.map(m => m.metric));

    // For each metric this equipment has ever produced, fill in latest-known if missing today
    const allMetricNames = db.prepare(
      `SELECT DISTINCT COALESCE(name, '_value') AS metric FROM readings WHERE equipment_id = ?`
    ).all(equipmentId).map(r => r.metric);

    const latestKnown = {};
    for (const metric of allMetricNames) {
      if (knownMetrics.has(metric)) continue;
      const r = db.prepare(`
        SELECT value, unit, timestamp FROM readings
        WHERE equipment_id = ? AND COALESCE(name, '_value') = ?
        ORDER BY timestamp DESC LIMIT 1
      `).get(equipmentId, metric);
      if (!r) continue;
      const ts = new Date(r.timestamp).getTime();
      latestKnown[metric] = {
        value: r.value,
        unit: r.unit || '',
        sample_at: r.timestamp,
        days_ago: Math.max(0, Math.round((dayEndMs - ts) / 86400000)),
      };
    }

    return {
      configured: true,
      equipment_id: eq.id,
      equipment_name: eq.name,
      today: todayMetrics,
      latest_known_when_today_missing: latestKnown,
    };
  }

  // -------- compounding history --------

  _getTier1History() {
    // Last N daily summaries (excluding today's, if it already exists)
    const rows = db.prepare(`
      SELECT report_date, opinion, summary FROM agronomist_reports
      WHERE status = 'success'
      ORDER BY report_date DESC
      LIMIT ?
    `).all(TIER1_WINDOW);
    return rows.reverse();
  }

  _getTier2History() {
    const rows = db.prepare(`
      SELECT week_start, week_end, rollup FROM agronomist_weekly_rollups
      ORDER BY week_start DESC
      LIMIT ?
    `).all(TIER2_WINDOW);
    return rows.reverse();
  }

  _getTier3Memory() {
    const row = db.prepare(
      `SELECT version, content, byte_size, created_at FROM agronomist_longterm_memory
       ORDER BY version DESC LIMIT 1`
    ).get();
    return row || null;
  }

  _formatHistoryBlock() {
    const tier1 = this._getTier1History();
    const tier2 = this._getTier2History();
    const tier3 = this._getTier3Memory();

    let block = '# Long-term knowledge of this farm\n\n';
    if (tier3) {
      block += `${tier3.content.trim()}\n\n`;
    } else {
      block += '_(No long-term knowledge built up yet — this is one of the first reports.)_\n\n';
    }

    block += '# Weekly rollups (most recent last)\n\n';
    if (tier2.length === 0) {
      block += '_(No weekly rollups yet.)_\n\n';
    } else {
      for (const w of tier2) {
        block += `**Week of ${w.week_start} → ${w.week_end}:** ${w.rollup}\n\n`;
      }
    }

    block += '# Recent daily summaries (most recent last)\n\n';
    if (tier1.length === 0) {
      block += '_(No prior daily reports.)_\n\n';
    } else {
      for (const d of tier1) {
        block += `**${d.report_date}** — ${d.opinion}\n${d.summary}\n\n`;
      }
    }

    return block;
  }

  // -------- core: generate a daily report --------

  /** Generate (and persist) the agronomist report for a given date.
   *  @param dateStr 'YYYY-MM-DD' (local). Defaults to today.
   *  @param opts.force if true, overwrite any existing report for that date.
   */
  async generateDailyReport(dateStr = null, opts = {}) {
    const cfg = this.getConfig();
    const date = dateStr || this._localDateStr(new Date());

    const existing = db.prepare(
      'SELECT id FROM agronomist_reports WHERE report_date = ? AND status = ?'
    ).get(date, 'success');
    if (existing && !opts.force) {
      const err = new Error(`Report for ${date} already exists. Pass force=true to regenerate.`);
      err.code = 'ALREADY_EXISTS';
      throw err;
    }

    const snapshot = this.aggregateDailyData(date);
    const historyBlock = this._formatHistoryBlock();
    const systemPrompt = (cfg.system_prompt_override || SYSTEM_PROMPT_BASE).trim() + '\n\n' + historyBlock;

    // Pull clarifications for this date so a regeneration honors prior user feedback.
    // Clarifications are matched by report_id; on first generation there are none.
    const clarifications = this._getClarificationsForDate(date);
    const clarificationsBlock = this._formatClarificationsBlock(clarifications);

    const userMessageParts = [
      `Today is ${date} (timezone: ${snapshot.timezone}).`,
      '',
      'Here is the day\'s data from the SenseHub edge controller:',
      '',
      '```json',
      JSON.stringify(snapshot, null, 2),
      '```',
      '',
      'Write the daily report. Be specific — name zones, ingredients, ions, equipment by their actual names from the data. Quantify (mg/L, L, °C). Tie every recommendation to the data point that justifies it. The Nutrient Status section MUST address every nutrient that appears in `lab[*].latest_per_nutrient` — if `today` is empty, use the latest_per_nutrient values and call out that they are N days old. Treat `reference_sensors` as the canonical environment readings. If something is missing entirely (no AMIC ever, no soil reading), call it out and recommend a measurement.',
    ];
    if (clarificationsBlock) {
      userMessageParts.push('', clarificationsBlock);
    }
    const userMessage = userMessageParts.join('\n');

    const client = this._client_or_throw();

    let response;
    try {
      response = await client.messages.create({
        model: cfg.model || DEFAULT_MODEL,
        max_tokens: 16000,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        output_config: {
          format: {
            type: 'json_schema',
            schema: REPORT_OUTPUT_SCHEMA,
          },
        },
        messages: [{ role: 'user', content: userMessage }],
      });
    } catch (err) {
      // Persist the failure so it shows up in the UI for debugging
      db.prepare(`
        INSERT INTO agronomist_reports
          (report_date, model, input_snapshot, summary, full_markdown, status, error)
        VALUES (?, ?, ?, ?, ?, 'failure', ?)
        ON CONFLICT(report_date) DO UPDATE SET
          generated_at = CURRENT_TIMESTAMP,
          model = excluded.model,
          input_snapshot = excluded.input_snapshot,
          status = 'failure',
          error = excluded.error
      `).run(date, cfg.model || DEFAULT_MODEL, JSON.stringify(snapshot),
            '', '', String(err?.message || err));
      throw err;
    }

    // Extract the structured JSON output
    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) throw new Error('Claude returned no text block');

    let parsed;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch (err) {
      throw new Error(`Claude returned invalid JSON: ${err.message}`);
    }

    const usage = response.usage || {};

    db.prepare(`
      INSERT INTO agronomist_reports
        (report_date, model, input_snapshot, summary, full_markdown,
         recommendations, opinion, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', NULL)
      ON CONFLICT(report_date) DO UPDATE SET
        generated_at = CURRENT_TIMESTAMP,
        model = excluded.model,
        input_snapshot = excluded.input_snapshot,
        summary = excluded.summary,
        full_markdown = excluded.full_markdown,
        recommendations = excluded.recommendations,
        opinion = excluded.opinion,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens,
        status = 'success',
        error = NULL
    `).run(
      date,
      response.model || cfg.model || DEFAULT_MODEL,
      JSON.stringify(snapshot),
      parsed.summary,
      parsed.full_markdown,
      JSON.stringify(parsed.recommendations || []),
      parsed.opinion,
      usage.input_tokens || 0,
      usage.output_tokens || 0,
      usage.cache_read_input_tokens || 0,
      usage.cache_creation_input_tokens || 0,
    );

    return this.getReportByDate(date);
  }

  // -------- weekly rollup (Tier 2) --------

  /** Rebuild the weekly rollup for the week containing the given date (or last week if Sunday). */
  async runWeeklyRollup(referenceDate = null) {
    const ref = referenceDate ? new Date(referenceDate) : new Date();
    // We want the most recently completed Mon-Sun week.
    // If ref is Sunday, that week is Mon (ref-6) → Sun (ref).
    // Otherwise, last week ended on the previous Sunday.
    const day = ref.getDay(); // 0=Sun
    const sundayOffset = day === 0 ? 0 : day; // distance back to most recent Sunday
    const weekEnd = new Date(ref);
    weekEnd.setDate(ref.getDate() - sundayOffset);
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekEnd.getDate() - 6);

    const startStr = this._localDateStr(weekStart);
    const endStr = this._localDateStr(weekEnd);

    const reports = db.prepare(`
      SELECT id, report_date, opinion, summary FROM agronomist_reports
      WHERE status = 'success' AND report_date BETWEEN ? AND ?
      ORDER BY report_date ASC
    `).all(startStr, endStr);

    if (reports.length === 0) {
      return { skipped: true, reason: 'no daily reports in that week', week_start: startStr, week_end: endStr };
    }

    const dailyDigest = reports.map(r => `**${r.report_date}** — ${r.opinion}\n${r.summary}`).join('\n\n');

    const client = this._client_or_throw();
    const cfg = this.getConfig();
    const response = await client.messages.create({
      model: cfg.model || DEFAULT_MODEL,
      max_tokens: 1200,
      system: 'You are an expert UAE agronomist compressing a week of daily farm reports into one paragraph.',
      messages: [{
        role: 'user',
        content:
`Below are this week's daily agronomist summaries (${startStr} → ${endStr}):

${dailyDigest}

Write ONE paragraph (target 600-800 characters, hard max 1000) that captures what happened this week and what changed. Focus on:
- Trends (rising/falling EC, drift in nutrient ratios, recurring alerts)
- Interventions made and whether they worked
- Outstanding risks carried into next week

Do NOT just bullet the days. Synthesize. Drop ephemeral details. Output ONLY the paragraph, no headings, no markdown.`,
      }],
    });

    const text = response.content.find(b => b.type === 'text')?.text?.trim() || '';
    const truncated = text.length > 1000 ? text.slice(0, 1000) : text;

    db.prepare(`
      INSERT INTO agronomist_weekly_rollups (week_start, week_end, rollup, generated_from_report_ids)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(week_start) DO UPDATE SET
        week_end = excluded.week_end,
        rollup = excluded.rollup,
        generated_from_report_ids = excluded.generated_from_report_ids,
        created_at = CURRENT_TIMESTAMP
    `).run(startStr, endStr, truncated, JSON.stringify(reports.map(r => r.id)));

    // After updating Tier 2, refresh Tier 3 with the new week's rollup
    await this.updateLongTermMemory({ trigger: 'weekly_rollup', new_week_start: startStr });

    return { week_start: startStr, week_end: endStr, rollup: truncated, reports: reports.length };
  }

  // -------- long-term memory (Tier 3) --------

  async updateLongTermMemory({ trigger = 'manual', new_week_start = null } = {}) {
    const previous = this._getTier3Memory();
    const tier2 = this._getTier2History();

    const newWeek = new_week_start
      ? tier2.find(w => w.week_start === new_week_start)
      : tier2[tier2.length - 1];

    const client = this._client_or_throw();
    const cfg = this.getConfig();

    const prompt = [
      `You maintain a single rolling long-term knowledge document about this UAE hydroponic farm. The document has a HARD CAP of ${TIER3_MAX_BYTES} bytes (UTF-8). When you rewrite it, you must preserve durable patterns and drop ephemeral details.`,
      '',
      'Previous version of the long-term knowledge document:',
      '',
      '```markdown',
      previous?.content || '_(none yet)_',
      '```',
      '',
      newWeek
        ? `New weekly rollup just produced (week ${newWeek.week_start} → ${newWeek.week_end}):\n\n${newWeek.rollup}`
        : '_(No new weekly rollup — synthesize from existing knowledge only.)_',
      '',
      'Recent weekly rollups (most recent last) for context:',
      '',
      tier2.map(w => `- Week ${w.week_start}: ${w.rollup}`).join('\n'),
      '',
      `Rewrite the long-term knowledge document. Output ONLY the new markdown document, no commentary, no fences. Stay under ${TIER3_MAX_BYTES} bytes. Structure with these sections (omit a section if you have nothing durable to say about it yet):`,
      '',
      '## Crop history & patterns',
      '## Water & fertigation patterns',
      '## Recurring nutrient / EC / pH issues',
      '## Equipment quirks & known issues',
      '## Operational lessons',
    ].join('\n');

    const response = await client.messages.create({
      model: cfg.model || DEFAULT_MODEL,
      max_tokens: 4000,
      system: 'You are an expert UAE agronomist maintaining a compact long-term knowledge document about a single farm.',
      messages: [{ role: 'user', content: prompt }],
    });

    let content = response.content.find(b => b.type === 'text')?.text?.trim() || '';
    // Hard cap by bytes
    const buf = Buffer.from(content, 'utf-8');
    if (buf.length > TIER3_MAX_BYTES) {
      content = buf.slice(0, TIER3_MAX_BYTES).toString('utf-8');
    }
    const byteSize = Buffer.byteLength(content, 'utf-8');

    const nextVersion = (db.prepare('SELECT MAX(version) AS v FROM agronomist_longterm_memory').get().v || 0) + 1;

    db.prepare(`
      INSERT INTO agronomist_longterm_memory (version, content, byte_size, triggered_by)
      VALUES (?, ?, ?, ?)
    `).run(nextVersion, content, byteSize, trigger);

    // Keep only last 5 versions for rollback (immutable history)
    db.prepare(`
      DELETE FROM agronomist_longterm_memory
      WHERE version <= (SELECT MAX(version) - 5 FROM agronomist_longterm_memory)
    `).run();

    return { version: nextVersion, byte_size: byteSize };
  }

  // -------- queries --------

  listReports(limit = 30, offset = 0) {
    return db.prepare(`
      SELECT id, report_date, generated_at, model, opinion, summary, status, error,
             input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
      FROM agronomist_reports
      ORDER BY report_date DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  getReportByDate(dateStr) {
    const row = db.prepare(`
      SELECT * FROM agronomist_reports WHERE report_date = ?
    `).get(dateStr);
    if (!row) return null;
    return {
      ...row,
      input_snapshot: row.input_snapshot ? JSON.parse(row.input_snapshot) : null,
      recommendations: row.recommendations ? JSON.parse(row.recommendations) : [],
      clarifications: this.listClarifications(row.id),
    };
  }

  getReportById(id) {
    const row = db.prepare(`SELECT * FROM agronomist_reports WHERE id = ?`).get(id);
    if (!row) return null;
    return {
      ...row,
      input_snapshot: row.input_snapshot ? JSON.parse(row.input_snapshot) : null,
      recommendations: row.recommendations ? JSON.parse(row.recommendations) : [],
      clarifications: this.listClarifications(row.id),
    };
  }

  deleteReport(id) {
    return db.prepare('DELETE FROM agronomist_reports WHERE id = ?').run(id).changes;
  }

  getMemoryHistory() {
    return db.prepare(`
      SELECT version, byte_size, triggered_by, created_at, content
      FROM agronomist_longterm_memory
      ORDER BY version DESC
    `).all();
  }

  // -------- clarifications (user feedback on a daily report) --------

  /** List all clarifications attached to a report, oldest first. */
  listClarifications(reportId) {
    return db.prepare(`
      SELECT id, report_id, user_id, user_name, message, triggered_regenerate, created_at
      FROM agronomist_report_clarifications
      WHERE report_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(reportId);
  }

  /** Append a clarification to a report. Returns the inserted row. */
  addClarification(reportId, { userId = null, userName = null, message, triggeredRegenerate = false }) {
    if (!message || !message.trim()) throw new Error('Clarification message cannot be empty');
    const result = db.prepare(`
      INSERT INTO agronomist_report_clarifications
        (report_id, user_id, user_name, message, triggered_regenerate)
      VALUES (?, ?, ?, ?, ?)
    `).run(reportId, userId, userName, message.trim(), triggeredRegenerate ? 1 : 0);
    return db.prepare(
      'SELECT id, report_id, user_id, user_name, message, triggered_regenerate, created_at FROM agronomist_report_clarifications WHERE id = ?'
    ).get(result.lastInsertRowid);
  }

  /** Look up clarifications by date — used during generation since a regeneration carries the
   *  same report_date but may be regenerating an existing row. */
  _getClarificationsForDate(dateStr) {
    const row = db.prepare('SELECT id FROM agronomist_reports WHERE report_date = ?').get(dateStr);
    if (!row) return [];
    return this.listClarifications(row.id);
  }

  _formatClarificationsBlock(clarifications) {
    if (!clarifications || clarifications.length === 0) return null;
    const lines = clarifications.map(c => {
      const when = (c.created_at || '').replace('T', ' ').slice(0, 16);
      const who = c.user_name ? ` — ${c.user_name}` : '';
      return `- [${when}${who}] ${c.message}`;
    });
    return [
      '## User clarifications and corrections from prior generations of this report',
      '',
      'The farm operator has left the following clarifications. Treat each as authoritative — if a sensor or process is flagged as broken, miscalibrated, or unreliable, factor that into your analysis. If a previous draft of this report made a recommendation based on data the user has explicitly said is wrong, drop or revise it. Acknowledge the correction in the report (e.g. "Note: pH readings are excluded from this analysis because the AMIC pH probe has not been calibrated yet, per operator note") so the audit trail is clear.',
      '',
      ...lines,
    ].join('\n');
  }

  // -------- helpers --------

  _localDateStr(date) {
    // Return YYYY-MM-DD in the server's local time (TZ env var honored)
    const tz = process.env.TZ;
    if (tz) {
      // Use Intl to get the date in the server's configured TZ
      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      return fmt.format(date);
    }
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
}

const agronomistService = new AgronomistService();

module.exports = { agronomistService, AgronomistService };
