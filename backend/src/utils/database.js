const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DB_PATH || path.join(dataDir, 'sensehub.db');
let db = null;

try {
  db = new Database(dbPath, { verbose: process.env.NODE_ENV === 'development' ? console.log : null });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  console.log(`Database connected: ${dbPath}`);
} catch (error) {
  console.error('Failed to connect to database:', error);
}

// Initialize schema
const initSchema = () => {
  if (!db) return false;

  db.exec(`
    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT CHECK(role IN ('admin', 'operator', 'viewer')) NOT NULL DEFAULT 'viewer',
      is_cloud_synced INTEGER DEFAULT 0,
      last_login TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Sessions table
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Equipment table
    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT,
      protocol TEXT CHECK(protocol IN ('modbus', 'mqtt', 'zigbee', 'zwave', 'other')),
      address TEXT,
      status TEXT CHECK(status IN ('online', 'offline', 'error', 'warning', 'disabled')) DEFAULT 'offline',
      enabled INTEGER DEFAULT 1,
      last_reading TEXT,
      last_communication TEXT,
      error_log TEXT,
      calibration_offset REAL DEFAULT 0,
      calibration_scale REAL DEFAULT 1,
      slave_id INTEGER,
      polling_interval_ms INTEGER DEFAULT 1000,
      register_mappings TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Zones table
    CREATE TABLE IF NOT EXISTS zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      parent_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES zones(id) ON DELETE SET NULL
    );

    -- Equipment-Zones junction table
    CREATE TABLE IF NOT EXISTS equipment_zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL,
      zone_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE,
      FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE,
      UNIQUE(equipment_id, zone_id)
    );

    -- Readings table
    CREATE TABLE IF NOT EXISTS readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL,
      value REAL,
      unit TEXT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE
    );

    -- Automations table
    CREATE TABLE IF NOT EXISTS automations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0,
      trigger_config TEXT,
      conditions TEXT,
      actions TEXT,
      last_run TEXT,
      run_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Automation logs table
    CREATE TABLE IF NOT EXISTS automation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      automation_id INTEGER NOT NULL,
      status TEXT CHECK(status IN ('success', 'failure', 'skipped')),
      message TEXT,
      triggered_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE
    );

    -- Alerts table
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER,
      zone_id INTEGER,
      severity TEXT CHECK(severity IN ('info', 'warning', 'critical')) NOT NULL,
      message TEXT NOT NULL,
      acknowledged INTEGER DEFAULT 0,
      acknowledged_by INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      acknowledged_at TEXT,
      FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE SET NULL,
      FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL,
      FOREIGN KEY (acknowledged_by) REFERENCES users(id) ON DELETE SET NULL
    );

    -- System settings table
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Sync queue table
    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      action TEXT CHECK(action IN ('create', 'update', 'delete')) NOT NULL,
      payload TEXT,
      status TEXT CHECK(status IN ('pending', 'syncing', 'synced', 'failed')) DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      synced_at TEXT
    );

    -- Cloud sync history table
    CREATE TABLE IF NOT EXISTS sync_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_type TEXT CHECK(sync_type IN ('manual', 'automatic', 'scheduled')) DEFAULT 'manual',
      status TEXT CHECK(status IN ('success', 'partial', 'failed')) DEFAULT 'success',
      items_synced INTEGER DEFAULT 0,
      items_failed INTEGER DEFAULT 0,
      message TEXT,
      triggered_by INTEGER,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (triggered_by) REFERENCES users(id) ON DELETE SET NULL
    );

    -- Equipment error logs table
    CREATE TABLE IF NOT EXISTS equipment_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL,
      error_type TEXT CHECK(error_type IN ('connection', 'timeout', 'protocol', 'validation', 'hardware', 'other')) DEFAULT 'other',
      message TEXT NOT NULL,
      details TEXT,
      resolved INTEGER DEFAULT 0,
      resolved_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE
    );

    -- User preferences table
    CREATE TABLE IF NOT EXISTS user_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      sound_alerts_enabled INTEGER DEFAULT 0,
      sound_volume REAL DEFAULT 0.5,
      alert_sound_critical TEXT DEFAULT 'alarm',
      alert_sound_warning TEXT DEFAULT 'beep',
      alert_sound_info TEXT DEFAULT 'chime',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Cloud suggested programs table
    CREATE TABLE IF NOT EXISTS cloud_suggested_programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cloud_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      trigger_config TEXT,
      conditions TEXT,
      actions TEXT,
      status TEXT CHECK(status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
      reviewed_by INTEGER,
      reviewed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
    );

    -- Device templates table for pre-configured Modbus device profiles
    CREATE TABLE IF NOT EXISTS device_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      manufacturer TEXT,
      model TEXT,
      description TEXT,
      protocol TEXT DEFAULT 'modbus',
      default_slave_id INTEGER,
      default_polling_interval_ms INTEGER DEFAULT 1000,
      register_mappings TEXT NOT NULL,
      is_system INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Cameras table
    CREATE TABLE IF NOT EXISTS cameras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      stream_url TEXT NOT NULL,
      snapshot_url TEXT,
      username TEXT,
      password TEXT,
      manufacturer TEXT,
      model TEXT,
      ip_address TEXT,
      rtsp_port INTEGER DEFAULT 554,
      http_port INTEGER DEFAULT 80,
      go2rtc_name TEXT UNIQUE NOT NULL,
      enabled INTEGER DEFAULT 1,
      status TEXT CHECK(status IN ('online', 'offline', 'error')) DEFAULT 'offline',
      error_message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Camera-Zones junction table
    CREATE TABLE IF NOT EXISTS camera_zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      camera_id INTEGER NOT NULL,
      zone_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE,
      FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE,
      UNIQUE(camera_id, zone_id)
    );

    -- Automation templates table for reusable automation blueprints
    CREATE TABLE IF NOT EXISTS automation_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT DEFAULT 'General',
      conditions TEXT DEFAULT '[]',
      condition_logic TEXT DEFAULT 'AND',
      actions TEXT DEFAULT '[]',
      is_system INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Lab readings table for manual nutrient analysis entries
    CREATE TABLE IF NOT EXISTS lab_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_date TEXT NOT NULL,
      nutrient TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT DEFAULT '',
      zone_id INTEGER REFERENCES zones(id) ON DELETE SET NULL,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Relay events table — logs every relay on/off transition
    CREATE TABLE IF NOT EXISTS relay_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL,
      channel INTEGER NOT NULL,
      state INTEGER NOT NULL,
      source TEXT CHECK(source IN ('manual', 'automation', 'automation_auto_off', 'all_channels')) NOT NULL,
      automation_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE,
      FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE SET NULL
    );

    -- Fertigation ingredients — predefined dropdown list
    CREATE TABLE IF NOT EXISTS fertigation_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Fertigation mixtures — reusable named recipes
    CREATE TABLE IF NOT EXISTS fertigation_mixtures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Fertigation mixture items — ingredients in a mixture with parts ratios
    CREATE TABLE IF NOT EXISTS fertigation_mixture_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mixture_id INTEGER NOT NULL,
      ingredient_id INTEGER NOT NULL,
      parts REAL NOT NULL DEFAULT 1,
      FOREIGN KEY (mixture_id) REFERENCES fertigation_mixtures(id) ON DELETE CASCADE,
      FOREIGN KEY (ingredient_id) REFERENCES fertigation_ingredients(id) ON DELETE CASCADE,
      UNIQUE(mixture_id, ingredient_id)
    );

    -- Fertigation tanks — physical stock containers wired to a fertigation pump channel.
    -- A tank holds a finished stock solution (water + dissolved ingredients) that the pump
    -- doses into the irrigation line. Stock volume depletes as the pump runs and is reset
    -- when a refill event is logged.
    CREATE TABLE IF NOT EXISTS fertigation_tanks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      equipment_id INTEGER,
      channel INTEGER,
      role TEXT DEFAULT 'nutrient' CHECK(role IN ('nutrient', 'ph_up', 'ph_down', 'other')),
      capacity_liters REAL DEFAULT 1000,
      water_base_liters REAL DEFAULT 1000,
      current_stock_liters REAL DEFAULT 0,
      mixture_id INTEGER,
      active INTEGER DEFAULT 1,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE SET NULL,
      FOREIGN KEY (mixture_id) REFERENCES fertigation_mixtures(id) ON DELETE SET NULL,
      UNIQUE(equipment_id, channel)
    );

    -- Fertigation tank refill log — audit trail of every refill. composition_snapshot is JSON
    -- so the record stays intact even if the upstream recipe later changes.
    CREATE TABLE IF NOT EXISTS fertigation_tank_refills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tank_id INTEGER NOT NULL,
      refilled_at TEXT DEFAULT CURRENT_TIMESTAMP,
      water_liters_added REAL NOT NULL,
      total_volume_after REAL,
      mixture_id INTEGER,
      composition_snapshot TEXT,
      user_id INTEGER,
      notes TEXT,
      FOREIGN KEY (tank_id) REFERENCES fertigation_tanks(id) ON DELETE CASCADE,
      FOREIGN KEY (mixture_id) REFERENCES fertigation_mixtures(id) ON DELETE SET NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    -- Per-element ppm targets for a crop (and optionally a specific growth stage).
    -- The AI planner uses hard_min/hard_max as inviolable bounds and weights the
    -- objective by priority (1=highest) when picking duty cycles or proposing
    -- mixture changes. crop_assignment_id=NULL acts as a fall-back default that
    -- applies when no stage-specific row exists.
    CREATE TABLE IF NOT EXISTS crop_element_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crop_assignment_id INTEGER,
      growth_stage TEXT,
      element TEXT NOT NULL,
      hard_min REAL,
      soft_target REAL,
      hard_max REAL,
      priority INTEGER NOT NULL DEFAULT 3 CHECK(priority BETWEEN 1 AND 5),
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (crop_assignment_id) REFERENCES crop_assignments(id) ON DELETE CASCADE,
      UNIQUE(crop_assignment_id, growth_stage, element)
    );

    -- Fertigation dose programs — reusable named per-tank duty-cycle recipes.
    -- A program describes "during a fertigation cycle, what % of the time should each
    -- tank's injector valve be open?". The scheduler reads this + the cycle duration
    -- to drive the Waveshare valve relays. Status='published' = planner can pick it.
    CREATE TABLE IF NOT EXISTS fertigation_dose_programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      window_seconds INTEGER NOT NULL DEFAULT 60,
      min_valve_on_seconds INTEGER NOT NULL DEFAULT 5,
      min_valve_off_seconds INTEGER NOT NULL DEFAULT 5,
      target_ec REAL,
      target_ph REAL,
      target_ppm TEXT,
      compatibility_strategy TEXT DEFAULT 'permissive' CHECK(compatibility_strategy IN ('permissive', 'time_slice')),
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'published', 'archived')),
      created_by INTEGER,
      origin TEXT DEFAULT 'manual' CHECK(origin IN ('manual', 'planner', 'agronomist')),
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    -- Per-tank duty cycle within a program. duty_pct=0 means "valve stays closed
    -- this cycle" (i.e. exclude this tank). priority orders tanks in time_slice mode.
    CREATE TABLE IF NOT EXISTS fertigation_dose_program_tanks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      program_id INTEGER NOT NULL,
      tank_id INTEGER NOT NULL,
      duty_pct REAL NOT NULL DEFAULT 0 CHECK(duty_pct >= 0 AND duty_pct <= 100),
      priority INTEGER NOT NULL DEFAULT 0,
      compatibility_slot INTEGER,
      FOREIGN KEY (program_id) REFERENCES fertigation_dose_programs(id) ON DELETE CASCADE,
      FOREIGN KEY (tank_id) REFERENCES fertigation_tanks(id) ON DELETE CASCADE,
      UNIQUE(program_id, tank_id)
    );

    -- Per-cycle execution log: each entry records one valve-toggle decision the
    -- dose scheduler made. Useful for debugging EC-trim adjustments and for the
    -- agronomist to look back at "what actually got delivered yesterday".
    CREATE TABLE IF NOT EXISTS fertigation_dose_cycle_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      program_id INTEGER,
      automation_id INTEGER,
      cycle_started_at TEXT,
      cycle_ended_at TEXT,
      duration_seconds INTEGER,
      effective_duty_pcts TEXT,
      ec_trim_applied REAL DEFAULT 0,
      status TEXT DEFAULT 'completed' CHECK(status IN ('running','completed','aborted','failed')),
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (program_id) REFERENCES fertigation_dose_programs(id) ON DELETE SET NULL,
      FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE SET NULL
    );

    -- Relay channel config — tags relay channels with dispensing info
    CREATE TABLE IF NOT EXISTS relay_channel_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL,
      channel INTEGER NOT NULL,
      ingredient_name TEXT,
      mixture_id INTEGER,
      flow_rate REAL NOT NULL,
      flow_unit TEXT DEFAULT 'L/min',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE,
      FOREIGN KEY (mixture_id) REFERENCES fertigation_mixtures(id) ON DELETE SET NULL,
      UNIQUE(equipment_id, channel)
    );

    -- Crop assignments — synced from A64Core, one active crop per block
    CREATE TABLE IF NOT EXISTS crop_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block_id TEXT NOT NULL,
      zone_id INTEGER,
      a64core_planting_id TEXT,
      crop_name TEXT NOT NULL,
      variety TEXT,
      scientific_name TEXT,
      plant_data_id TEXT,
      planted_date TEXT,
      expected_harvest_date TEXT,
      growth_cycle_days INTEGER,
      plant_count INTEGER,
      max_capacity INTEGER,
      current_stage TEXT DEFAULT 'seedling',
      optimal_ranges TEXT,
      stage_durations TEXT,
      transitioned_at TEXT,
      days_since_planting INTEGER,
      harvested_at TEXT,
      total_yield_kg REAL,
      average_quality_grade TEXT,
      harvest_count INTEGER,
      active INTEGER DEFAULT 1,
      received_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_stage_update_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL
    );

    -- Sensor calibrations — per equipment+metric linear calibration to map raw sensor → real value
    CREATE TABLE IF NOT EXISTS sensor_calibrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL,
      metric_name TEXT NOT NULL,
      lab_nutrient TEXT NOT NULL,
      slope REAL NOT NULL DEFAULT 1.0,
      intercept REAL NOT NULL DEFAULT 0.0,
      r_squared REAL DEFAULT NULL,
      n_pairs INTEGER DEFAULT 0,
      last_computed TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE,
      UNIQUE(equipment_id, metric_name)
    );

    -- Relay state drift log — records when polled hardware state doesn't match expected state
    CREATE TABLE IF NOT EXISTS relay_drift_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL,
      equipment_name TEXT,
      channel INTEGER NOT NULL,
      expected_state INTEGER,
      actual_state INTEGER NOT NULL,
      context TEXT,
      detail TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE
    );

    -- Camera snapshots — periodic captured images
    CREATE TABLE IF NOT EXISTS camera_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      camera_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      captured_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE
    );

    -- Network usage snapshots — periodic rx/tx byte deltas per interface
    CREATE TABLE IF NOT EXISTS network_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      interface TEXT NOT NULL,
      rx_bytes INTEGER NOT NULL DEFAULT 0,
      tx_bytes INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Watchdog events — persistent log of all watchdog detections and connectivity changes
    CREATE TABLE IF NOT EXISTS watchdog_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      target TEXT,
      status TEXT NOT NULL,
      message TEXT,
      detail TEXT,
      duration_seconds INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Agronomist daily reports — Claude-generated farm analysis (one per day)
    CREATE TABLE IF NOT EXISTS agronomist_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date TEXT NOT NULL UNIQUE,
      generated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      model TEXT,
      input_snapshot TEXT,
      summary TEXT NOT NULL,
      full_markdown TEXT NOT NULL,
      recommendations TEXT,
      opinion TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      status TEXT CHECK(status IN ('success','failure')) DEFAULT 'success',
      error TEXT
    );

    -- Tier 2 weekly rollups — compressed weekly paragraphs for long-horizon context
    CREATE TABLE IF NOT EXISTS agronomist_weekly_rollups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL UNIQUE,
      week_end TEXT NOT NULL,
      rollup TEXT NOT NULL,
      generated_from_report_ids TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Tier 3 long-term memory — single rolling 5KB markdown doc, versioned
    CREATE TABLE IF NOT EXISTS agronomist_longterm_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL UNIQUE,
      content TEXT NOT NULL,
      byte_size INTEGER,
      triggered_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- AMIC live mV trace columns added to amic_cycle_history (see ALTER below).
    -- AMIC cycle completion log — every Measure / Calibrate / Drain / Empty System / Condition
    -- cycle that completes (1→0 transition) is recorded here with its duration plus the
    -- per-channel cal_check / measurement_check pass-fail flags at the moment of completion.
    -- Lets us answer "when was last calibration?" and audit measurement quality over time.
    CREATE TABLE IF NOT EXISTS amic_cycle_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_state TEXT NOT NULL,           -- 'measuring'|'calibrating'|'draining'|'empty_system'|'conditioning'
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_seconds INTEGER,
      source TEXT,                         -- 'sensehub'|'panel'|'unknown'
      cal_check TEXT,                      -- JSON: [{ch, label, passed}, ...] at end of cycle
      measurement_check TEXT,              -- JSON: [{ch, label, passed}, ...] at end of cycle
      pump_input_seconds INTEGER,          -- snapshot of timing config
      pump_output_seconds INTEGER,
      live_mv_trace TEXT,                  -- JSON [{t: ISO, mv: number}, ...] — pH electrode mV sampled during the cycle.
                                           -- Diagnostic: real cal/measurement should show mV variation as standards alternate;
                                           -- a flat/saturated trace means the probe wasn't in contact with the liquid.
      live_mv_min REAL,                    -- min sampled mV across the cycle
      live_mv_max REAL,                    -- max sampled mV across the cycle
      live_mv_samples INTEGER DEFAULT 0,   -- count of samples in trace
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Operational planner — the AI planner generates a proposed automation plan for
    -- the next day, stored as preview data (no execution / no live automation creation).
    -- Each row covers one calendar day (the day the plan TARGETS). Generated the
    -- prior evening at the configured time (default 18:00).
    -- proposed_plan_json is structured output (summary, headline, proposed_automations[],
    -- changes_from_today[], risks[]) where proposed_automations[*] mirrors the shape of
    -- the automations table (name, description, enabled, trigger_config, conditions,
    -- actions) so we can later flip a switch to actually create them.
    -- status is one of pending / success / failure.
    CREATE TABLE IF NOT EXISTS operational_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_date TEXT NOT NULL,               -- the day this plan covers (YYYY-MM-DD). NOT unique: multiple versions per date allowed.
      version INTEGER NOT NULL DEFAULT 1,    -- monotonically increases for each rejection+regeneration of the same plan_date
      parent_plan_id INTEGER,                -- if this plan replaces a rejected one, points to it
      generated_for TEXT,                    -- the day the planner was run (usually plan_date - 1)
      generated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      model TEXT,
      input_snapshot TEXT,                   -- JSON: full context passed to the LLM
      headline TEXT,
      summary TEXT,
      proposed_plan_json TEXT,               -- JSON: full structured plan output (targets, yesterday_review, proposed_automations, changes_from_today, risks)
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER,
      status TEXT CHECK(status IN ('pending', 'confirmed', 'rejected', 'failure', 'success')) DEFAULT 'pending',
      error TEXT,
      rejection_feedback TEXT,               -- when status='rejected', the operator's free-text comment
      applied_at TEXT,                       -- when status='confirmed', the timestamp the plan was applied
      applied_by_user_id INTEGER,            -- when status='confirmed', the user who applied it
      applied_summary TEXT,                  -- JSON: {added:[ids], modified:[ids], disabled:[ids], kept:[ids], errors:[...]}
      consistency_warnings TEXT,             -- JSON array from the deterministic post-LLM cross-check (prose vs structured data mismatches)
      FOREIGN KEY (parent_plan_id) REFERENCES operational_plans(id) ON DELETE SET NULL,
      FOREIGN KEY (applied_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    -- NB: indexes referencing the version column are created AFTER the migration block below,
    -- because on upgrades the migration rebuilds operational_plans with the new column.

    -- User-submitted clarifications/feedback on a daily report.
    -- Injected into the prompt on regeneration so corrections (e.g. "the pH probe is uncalibrated,
    -- ignore today's pH") propagate into the new report's summary, and from there into the
    -- weekly rollup and long-term memory.
    CREATE TABLE IF NOT EXISTS agronomist_report_clarifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL,
      user_id INTEGER,
      user_name TEXT,
      message TEXT NOT NULL,
      triggered_regenerate INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (report_id) REFERENCES agronomist_reports(id) ON DELETE CASCADE
    );

    -- Plan guardrails — rules that block applying a plan whose dosing actions
    -- would worsen a low/high nutrient. Each rule checks one element against a
    -- threshold (e.g. feed Ca < 150 mg/L) and forbids a specific action class
    -- (e.g. "reduce duty of any Ca-source tank below 80% duty"). The applyPlan
    -- path evaluates every enabled rule and refuses to apply when triggered
    -- unless the operator passes a matching override (typed reason + admin role).
    --
    -- Generic by design so adding K / NO3 / Mg guardrails later requires only a
    -- new row, not new code.
    CREATE TABLE IF NOT EXISTS plan_guardrails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      severity TEXT NOT NULL DEFAULT 'high' CHECK(severity IN ('low','medium','high','critical')),
      element TEXT NOT NULL,
      comparison TEXT NOT NULL CHECK(comparison IN ('lt','lte','gt','gte','null_or_lt','null_or_lte')),
      threshold REAL NOT NULL,
      forbidden_action TEXT NOT NULL DEFAULT 'reduce_element_delivery',
      minimum_tank_duty_pct REAL,
      override_role TEXT NOT NULL DEFAULT 'admin' CHECK(override_role IN ('admin','operator','admin_or_operator')),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Plan clarifications — a non-destructive conversation thread on a plan.
    -- Operator posts a question ("explain why 3 irrigations") or a highlight
    -- ("VWC peaks at 60%, you missed this"). The planner immediately responds
    -- with reasoning grounded in the plan + current snapshot, without modifying
    -- the plan itself. If the operator later decides the concerns warrant a
    -- regenerate, the whole thread can be converted to rejection_feedback and
    -- a new plan version is generated with addressed_by_plan_id pointing back.
    --
    -- role distinguishes intent so the responder prompt can adjust tone:
    --   "question" → operator wants reasoning explained
    --   "highlight" → operator believes the plan missed something
    CREATE TABLE IF NOT EXISTS operational_plan_clarifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      user_id INTEGER,
      user_name TEXT,
      role TEXT NOT NULL DEFAULT 'question' CHECK(role IN ('question', 'highlight')),
      message TEXT NOT NULL,
      planner_response TEXT,
      response_verdict TEXT CHECK(response_verdict IN ('plan_correct', 'concern_valid', 'need_more_data', NULL)),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'addressed', 'archived')),
      addressed_by_plan_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      responded_at TEXT,
      FOREIGN KEY (plan_id) REFERENCES operational_plans(id) ON DELETE CASCADE,
      FOREIGN KEY (addressed_by_plan_id) REFERENCES operational_plans(id) ON DELETE SET NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    -- Consumption baselines: snapshot a cumulative reading (e.g. kWh) so the UI
    -- can show "consumption since {created_at}" = current_value - baseline_value.
    CREATE TABLE IF NOT EXISTS consumption_baselines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL,
      metric_name TEXT NOT NULL,
      baseline_value REAL NOT NULL,
      unit TEXT,
      label TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE
    );

    -- Create indexes for performance
    CREATE INDEX IF NOT EXISTS idx_readings_equipment ON readings(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_readings_timestamp ON readings(timestamp);
    CREATE INDEX IF NOT EXISTS idx_readings_equip_time ON readings(equipment_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged ON alerts(acknowledged);
    CREATE INDEX IF NOT EXISTS idx_automation_logs_automation ON automation_logs(automation_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status);
    CREATE INDEX IF NOT EXISTS idx_equipment_errors_equipment ON equipment_errors(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_equipment_errors_created ON equipment_errors(created_at);
    CREATE INDEX IF NOT EXISTS idx_user_preferences_user ON user_preferences(user_id);
    CREATE INDEX IF NOT EXISTS idx_cloud_suggested_programs_status ON cloud_suggested_programs(status);
    CREATE INDEX IF NOT EXISTS idx_device_templates_category ON device_templates(category);
    CREATE INDEX IF NOT EXISTS idx_cameras_go2rtc_name ON cameras(go2rtc_name);
    CREATE INDEX IF NOT EXISTS idx_cameras_status ON cameras(status);
    CREATE INDEX IF NOT EXISTS idx_camera_zones_camera ON camera_zones(camera_id);
    CREATE INDEX IF NOT EXISTS idx_camera_zones_zone ON camera_zones(zone_id);
    CREATE INDEX IF NOT EXISTS idx_automation_templates_category ON automation_templates(category);
    CREATE INDEX IF NOT EXISTS idx_lab_readings_nutrient ON lab_readings(nutrient);
    CREATE INDEX IF NOT EXISTS idx_lab_readings_sample_date ON lab_readings(sample_date);
    CREATE INDEX IF NOT EXISTS idx_lab_readings_zone ON lab_readings(zone_id);
    CREATE INDEX IF NOT EXISTS idx_relay_events_equipment ON relay_events(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_relay_events_created ON relay_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_relay_events_equip_channel ON relay_events(equipment_id, channel, created_at);
    CREATE INDEX IF NOT EXISTS idx_relay_channel_config_equipment ON relay_channel_config(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_fertigation_mixture_items_mixture ON fertigation_mixture_items(mixture_id);
    CREATE INDEX IF NOT EXISTS idx_camera_snapshots_camera ON camera_snapshots(camera_id, captured_at);
    CREATE INDEX IF NOT EXISTS idx_sensor_calibrations_equip ON sensor_calibrations(equipment_id, metric_name);
    CREATE INDEX IF NOT EXISTS idx_relay_drift_equipment ON relay_drift_log(equipment_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_relay_drift_created ON relay_drift_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_network_usage_interface ON network_usage(interface, timestamp);
    CREATE INDEX IF NOT EXISTS idx_network_usage_timestamp ON network_usage(timestamp);
    CREATE INDEX IF NOT EXISTS idx_watchdog_events_type ON watchdog_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_watchdog_events_created ON watchdog_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_watchdog_events_target ON watchdog_events(target, created_at);
    CREATE INDEX IF NOT EXISTS idx_agronomist_reports_date ON agronomist_reports(report_date);
    CREATE INDEX IF NOT EXISTS idx_agronomist_reports_generated ON agronomist_reports(generated_at);
    CREATE INDEX IF NOT EXISTS idx_agronomist_weekly_week ON agronomist_weekly_rollups(week_start);
    CREATE INDEX IF NOT EXISTS idx_agronomist_longterm_version ON agronomist_longterm_memory(version);
    CREATE INDEX IF NOT EXISTS idx_agronomist_clarifications_report ON agronomist_report_clarifications(report_id);
    CREATE INDEX IF NOT EXISTS idx_agronomist_clarifications_created ON agronomist_report_clarifications(created_at);
    CREATE INDEX IF NOT EXISTS idx_plan_clarifications_plan ON operational_plan_clarifications(plan_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_plan_clarifications_status ON operational_plan_clarifications(status);
    CREATE INDEX IF NOT EXISTS idx_amic_cycle_history_started ON amic_cycle_history(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_amic_cycle_history_state ON amic_cycle_history(cycle_state, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_operational_plans_date ON operational_plans(plan_date DESC);
    CREATE INDEX IF NOT EXISTS idx_operational_plans_generated ON operational_plans(generated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_consumption_baselines_equip_metric ON consumption_baselines(equipment_id, metric_name);
    CREATE INDEX IF NOT EXISTS idx_fertigation_tanks_equip_channel ON fertigation_tanks(equipment_id, channel);
    CREATE INDEX IF NOT EXISTS idx_fertigation_tank_refills_tank ON fertigation_tank_refills(tank_id, refilled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dose_program_tanks_program ON fertigation_dose_program_tanks(program_id);
    CREATE INDEX IF NOT EXISTS idx_dose_program_tanks_tank ON fertigation_dose_program_tanks(tank_id);
    CREATE INDEX IF NOT EXISTS idx_dose_cycle_log_program ON fertigation_dose_cycle_log(program_id, cycle_started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dose_cycle_log_automation ON fertigation_dose_cycle_log(automation_id, cycle_started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crop_element_targets_lookup ON crop_element_targets(crop_assignment_id, growth_stage, element);
    -- SQLite UNIQUE constraints treat NULLs as distinct, so the table-level UNIQUE
    -- on (crop_assignment_id, growth_stage, element) doesn't prevent dupes when
    -- BOTH FK columns are NULL (the default-target case). This partial index uses
    -- COALESCE to give NULL a sentinel so the uniqueness holds for default rows.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crop_element_targets_unique_nulls_safe
      ON crop_element_targets (COALESCE(crop_assignment_id, -1), COALESCE(growth_stage, ''), element);
  `);

  // Idempotent ALTERs in case the table already exists from a prior deploy without live-mv columns
  try {
    const cols = db.pragma('table_info(amic_cycle_history)').map(c => c.name);
    if (!cols.includes('live_mv_trace'))    db.exec("ALTER TABLE amic_cycle_history ADD COLUMN live_mv_trace TEXT");
    if (!cols.includes('live_mv_min'))      db.exec("ALTER TABLE amic_cycle_history ADD COLUMN live_mv_min REAL");
    if (!cols.includes('live_mv_max'))      db.exec("ALTER TABLE amic_cycle_history ADD COLUMN live_mv_max REAL");
    if (!cols.includes('live_mv_samples'))  db.exec("ALTER TABLE amic_cycle_history ADD COLUMN live_mv_samples INTEGER DEFAULT 0");
  } catch (err) {
    console.error('amic_cycle_history live mV columns migration failed:', err.message);
  }

  // Add calibration columns to existing equipment table if they don't exist
  try {
    const columns = db.pragma("table_info(equipment)").map(col => col.name);
    if (!columns.includes('calibration_offset')) {
      db.exec('ALTER TABLE equipment ADD COLUMN calibration_offset REAL DEFAULT 0');
      console.log('Added calibration_offset column to equipment table');
    }
    if (!columns.includes('calibration_scale')) {
      db.exec('ALTER TABLE equipment ADD COLUMN calibration_scale REAL DEFAULT 1');
      console.log('Added calibration_scale column to equipment table');
    }
  } catch (err) {
    console.log('Calibration columns already exist or migration skipped');
  }

  // Add condition_logic column to automations table if it doesn't exist
  try {
    const automationColumns = db.pragma("table_info(automations)").map(col => col.name);
    if (!automationColumns.includes('condition_logic')) {
      db.exec("ALTER TABLE automations ADD COLUMN condition_logic TEXT DEFAULT 'AND'");
      console.log('Added condition_logic column to automations table');
    }
  } catch (err) {
    console.log('condition_logic column already exists or migration skipped');
  }

  // Add Modbus configuration columns to equipment table if they don't exist
  try {
    const equipmentColumns = db.pragma("table_info(equipment)").map(col => col.name);
    if (!equipmentColumns.includes('slave_id')) {
      db.exec('ALTER TABLE equipment ADD COLUMN slave_id INTEGER');
      console.log('Added slave_id column to equipment table');
    }
    if (!equipmentColumns.includes('polling_interval_ms')) {
      db.exec('ALTER TABLE equipment ADD COLUMN polling_interval_ms INTEGER DEFAULT 1000');
      console.log('Added polling_interval_ms column to equipment table');
    }
    if (!equipmentColumns.includes('register_mappings')) {
      db.exec('ALTER TABLE equipment ADD COLUMN register_mappings TEXT');
      console.log('Added register_mappings column to equipment table');
    }
  } catch (err) {
    console.log('Modbus columns already exist or migration skipped');
  }

  // Add write_only column to equipment table for devices that don't send Modbus responses
  try {
    const eqCols = db.pragma("table_info(equipment)").map(col => col.name);
    if (!eqCols.includes('write_only')) {
      db.exec('ALTER TABLE equipment ADD COLUMN write_only INTEGER DEFAULT 0');
      console.log('Added write_only column to equipment table');
    }
  } catch (err) {
    console.log('write_only column already exists or migration skipped');
  }

  // Add template_id column to automations table if it doesn't exist
  try {
    const autoCols = db.pragma("table_info(automations)").map(col => col.name);
    if (!autoCols.includes('template_id')) {
      db.exec('ALTER TABLE automations ADD COLUMN template_id INTEGER REFERENCES automation_templates(id) ON DELETE SET NULL');
      console.log('Added template_id column to automations table');
    }
    // Create index after column exists
    db.exec('CREATE INDEX IF NOT EXISTS idx_automations_template_id ON automations(template_id)');
  } catch (err) {
    console.log('template_id column already exists or migration skipped');
  }

  // Add last_watchdog_alert column to automations table
  try {
    const autoCols2 = db.pragma("table_info(automations)").map(col => col.name);
    if (!autoCols2.includes('last_watchdog_alert')) {
      db.exec('ALTER TABLE automations ADD COLUMN last_watchdog_alert TEXT');
      console.log('Added last_watchdog_alert column to automations table');
    }
  } catch (err) {
    console.log('last_watchdog_alert column on automations already exists or migration skipped');
  }

  // Add last_watchdog_alert column to equipment table
  try {
    const eqCols2 = db.pragma("table_info(equipment)").map(col => col.name);
    if (!eqCols2.includes('last_watchdog_alert')) {
      db.exec('ALTER TABLE equipment ADD COLUMN last_watchdog_alert TEXT');
      console.log('Added last_watchdog_alert column to equipment table');
    }
  } catch (err) {
    console.log('last_watchdog_alert column on equipment already exists or migration skipped');
  }

  // Add name column to readings table for multi-metric sensors (e.g., 7-in-1 soil meter)
  try {
    const readingsCols = db.pragma("table_info(readings)").map(col => col.name);
    if (!readingsCols.includes('name')) {
      db.exec("ALTER TABLE readings ADD COLUMN name TEXT");
      console.log('Added name column to readings table');
    }
  } catch (err) {
    console.log('readings name column already exists or migration skipped');
  }

  // Migrate relay_channel_config: add mixture_id and make ingredient_name nullable
  try {
    const rccColInfo = db.pragma("table_info(relay_channel_config)");
    const ingCol = rccColInfo.find(c => c.name === 'ingredient_name');
    // Need migration if ingredient_name is NOT NULL (old schema) or mixture_id is missing
    if ((ingCol && ingCol.notnull === 1) || !rccColInfo.find(c => c.name === 'mixture_id')) {
      // Recreate table with correct schema (ingredient_name nullable, mixture_id added)
      db.exec(`
        ALTER TABLE relay_channel_config RENAME TO relay_channel_config_old;
        CREATE TABLE relay_channel_config (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          equipment_id INTEGER NOT NULL,
          channel INTEGER NOT NULL,
          ingredient_name TEXT,
          mixture_id INTEGER,
          flow_rate REAL NOT NULL,
          flow_unit TEXT DEFAULT 'L/min',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE,
          FOREIGN KEY (mixture_id) REFERENCES fertigation_mixtures(id) ON DELETE SET NULL,
          UNIQUE(equipment_id, channel)
        );
        INSERT INTO relay_channel_config (id, equipment_id, channel, ingredient_name, mixture_id, flow_rate, flow_unit, created_at, updated_at)
          SELECT id, equipment_id, channel, ingredient_name, mixture_id, flow_rate, flow_unit, created_at, updated_at FROM relay_channel_config_old;
        DROP TABLE relay_channel_config_old;
        CREATE INDEX IF NOT EXISTS idx_relay_channel_config_equipment ON relay_channel_config(equipment_id);
      `);
      console.log('Migrated relay_channel_config table (added mixture_id, made ingredient_name nullable)');
    }
  } catch (err) {
    console.log('relay_channel_config migration skipped:', err.message);
  }

  // Seed default fertigation ingredients
  try {
    const count = db.prepare('SELECT COUNT(*) as count FROM fertigation_ingredients').get().count;
    if (count === 0) {
      const defaults = ['Water', 'Nutrient A', 'Nutrient B', 'CalMag', 'pH Up', 'pH Down', 'Humic Acid', 'Silica', 'Root Stimulator', 'Bloom Booster'];
      const insert = db.prepare('INSERT OR IGNORE INTO fertigation_ingredients (name) VALUES (?)');
      for (const name of defaults) insert.run(name);
      console.log('Seeded default fertigation ingredients');
    }
  } catch (err) {
    console.log('Fertigation ingredients seed skipped:', err.message);
  }

  // Extend fertigation_ingredients with elemental composition + handling metadata.
  // composition is JSON like {"N":15.5,"Ca":19.0} — % by weight for solids, g/L for liquids.
  // compatibility_group lets the UI warn when incompatible groups (e.g. calcium + sulfate)
  // are pumped into the same line at the same time.
  try {
    const cols = db.pragma("table_info(fertigation_ingredients)").map(c => c.name);
    if (!cols.includes('composition'))         db.exec("ALTER TABLE fertigation_ingredients ADD COLUMN composition TEXT");
    if (!cols.includes('form'))                db.exec("ALTER TABLE fertigation_ingredients ADD COLUMN form TEXT DEFAULT 'solid'");
    if (!cols.includes('density_kg_per_l'))    db.exec("ALTER TABLE fertigation_ingredients ADD COLUMN density_kg_per_l REAL DEFAULT 1");
    if (!cols.includes('compatibility_group')) db.exec("ALTER TABLE fertigation_ingredients ADD COLUMN compatibility_group TEXT");
    if (!cols.includes('notes'))               db.exec("ALTER TABLE fertigation_ingredients ADD COLUMN notes TEXT");
  } catch (err) {
    console.error('fertigation_ingredients composition migration failed:', err.message);
  }

  // Extend fertigation_mixture_items with absolute amount + unit so recipes can store
  // "100 kg of calcium nitrate" rather than only a parts ratio. parts stays for legacy.
  try {
    const cols = db.pragma("table_info(fertigation_mixture_items)").map(c => c.name);
    if (!cols.includes('amount')) db.exec("ALTER TABLE fertigation_mixture_items ADD COLUMN amount REAL");
    if (!cols.includes('unit'))   db.exec("ALTER TABLE fertigation_mixture_items ADD COLUMN unit TEXT DEFAULT 'kg'");
  } catch (err) {
    console.error('fertigation_mixture_items amount migration failed:', err.message);
  }

  // Add soil_type + substrate_volume_l_per_plant to crop_assignments so the operator
  // (and the AI planner) can reason about substrate water-holding capacity, drainage,
  // and EC interpretation per crop. Both nullable — older rows stay valid.
  try {
    const cols = db.pragma("table_info(crop_assignments)").map(c => c.name);
    if (!cols.includes('soil_type')) {
      db.exec("ALTER TABLE crop_assignments ADD COLUMN soil_type TEXT");
      console.log('Added soil_type column to crop_assignments');
    }
    if (!cols.includes('substrate_volume_l_per_plant')) {
      db.exec("ALTER TABLE crop_assignments ADD COLUMN substrate_volume_l_per_plant REAL");
      console.log('Added substrate_volume_l_per_plant column to crop_assignments');
    }
  } catch (err) {
    console.error('crop_assignments soil/substrate migration failed:', err.message);
  }

  // Add pending_mixture_id to fertigation_tanks. Set when the planner (or operator)
  // proposes a new recipe for a tank; cleared when the next physical refill cites it
  // and the active mixture_id is swapped to match.
  try {
    const cols = db.pragma("table_info(fertigation_tanks)").map(c => c.name);
    if (!cols.includes('pending_mixture_id')) {
      db.exec("ALTER TABLE fertigation_tanks ADD COLUMN pending_mixture_id INTEGER REFERENCES fertigation_mixtures(id) ON DELETE SET NULL");
      console.log('Added pending_mixture_id column to fertigation_tanks');
    }
  } catch (err) {
    console.error('fertigation_tanks pending_mixture_id migration failed:', err.message);
  }

  // Add dose_program_id to automations so a fertigation automation can specify which
  // dose program drives valve duty cycles when it triggers.
  try {
    const cols = db.pragma("table_info(automations)").map(c => c.name);
    if (!cols.includes('dose_program_id')) {
      db.exec("ALTER TABLE automations ADD COLUMN dose_program_id INTEGER REFERENCES fertigation_dose_programs(id) ON DELETE SET NULL");
      console.log('Added dose_program_id column to automations');
    }
  } catch (err) {
    console.error('automations dose_program_id migration failed:', err.message);
  }

  // Add tank_id to relay_channel_config so channels can be paired directly to a tank.
  // Keeps mixture_id / ingredient_name for backwards compatibility; tank_id is now the
  // preferred binding.
  try {
    const cols = db.pragma("table_info(relay_channel_config)").map(c => c.name);
    if (!cols.includes('tank_id')) {
      db.exec("ALTER TABLE relay_channel_config ADD COLUMN tank_id INTEGER");
      console.log('Added tank_id column to relay_channel_config');
    }
  } catch (err) {
    console.error('relay_channel_config tank_id migration failed:', err.message);
  }

  // Seed/refresh elemental composition for common horticultural fertilizers.
  // Values are weight-% for solids and g/L for liquids (form='liquid').
  // Compatibility groups: stocks in different groups should not be co-injected without
  // strong dilution (e.g. calcium + sulfate -> gypsum, calcium + phosphate -> precipitate).
  try {
    const ingredientSeed = [
      { name: 'Calcium Nitrate',     form: 'solid',  density_kg_per_l: 1,    compatibility_group: 'calcium',  composition: { N: 15.5, Ca: 19.0 } },
      { name: 'Magnesium Nitrate',   form: 'solid',  density_kg_per_l: 1,    compatibility_group: 'calcium',  composition: { N: 11.0, Mg: 9.5 } },
      { name: 'MKP',                 form: 'solid',  density_kg_per_l: 1,    compatibility_group: 'phosphate',composition: { P: 22.7, K: 28.2 } },
      { name: 'Potassium Sulphate',  form: 'solid',  density_kg_per_l: 1,    compatibility_group: 'sulfate',  composition: { K: 41.5, S: 18.0 } },
      { name: 'Ferro Active',        form: 'solid',  density_kg_per_l: 1,    compatibility_group: 'micro',    composition: { Fe: 6.0 }, notes: 'Chelated iron — verify % on supplier label' },
      { name: 'Oligo Active',        form: 'liquid', density_kg_per_l: 1.15, compatibility_group: 'micro',    composition: { Fe: 4.0, Mn: 2.0, Zn: 1.0, Cu: 0.5, B: 0.5, Mo: 0.05 }, notes: 'Estimate — verify on supplier label' },
      { name: 'Humic Acid',          form: 'liquid', density_kg_per_l: 1.05, compatibility_group: 'humic',    composition: {}, notes: 'Soil enhancer — no direct NPK contribution' },
      { name: 'pH Up',               form: 'liquid', density_kg_per_l: 1.5,  compatibility_group: 'base',     composition: {}, notes: 'Typically KOH solution' },
      { name: 'pH Down',             form: 'liquid', density_kg_per_l: 1.4,  compatibility_group: 'acid',     composition: {}, notes: 'Typically phosphoric or nitric acid' },
    ];
    const upsert = db.prepare(`
      INSERT INTO fertigation_ingredients (name, form, density_kg_per_l, compatibility_group, composition, notes)
      VALUES (@name, @form, @density_kg_per_l, @compatibility_group, @composition, @notes)
      ON CONFLICT(name) DO UPDATE SET
        form = COALESCE(excluded.form, fertigation_ingredients.form),
        density_kg_per_l = COALESCE(excluded.density_kg_per_l, fertigation_ingredients.density_kg_per_l),
        compatibility_group = COALESCE(excluded.compatibility_group, fertigation_ingredients.compatibility_group),
        composition = COALESCE(excluded.composition, fertigation_ingredients.composition),
        notes = COALESCE(excluded.notes, fertigation_ingredients.notes)
    `);
    let n = 0;
    for (const ing of ingredientSeed) {
      upsert.run({
        name: ing.name,
        form: ing.form,
        density_kg_per_l: ing.density_kg_per_l,
        compatibility_group: ing.compatibility_group,
        composition: JSON.stringify(ing.composition || {}),
        notes: ing.notes || null,
      });
      n++;
    }
    if (n > 0) console.log(`Seeded/updated ${n} fertigation ingredients with composition`);
  } catch (err) {
    console.error('fertigation_ingredients composition seed failed:', err.message);
  }

  // Seed default crop element targets (crop_assignment_id=NULL, growth_stage=NULL acts
  // as the system-wide default the planner falls back to when no crop-specific row
  // exists). These numbers are tuned for general leafy greens — operator should override
  // per crop / stage via the UI. priority: 1=highest (overrides others when conflicting).
  try {
    const existing = db.prepare('SELECT COUNT(*) as c FROM crop_element_targets WHERE crop_assignment_id IS NULL').get().c;
    if (existing === 0) {
      const defaults = [
        // element, hard_min, soft_target, hard_max, priority, notes
        { element: 'N',  hard_min: 100, soft_target: 150, hard_max: 220, priority: 2, notes: 'Above 220 ppm risks ammonium toxicity and rapid leaf elongation' },
        { element: 'P',  hard_min:  30, soft_target:  50, hard_max:  80, priority: 3, notes: '' },
        { element: 'K',  hard_min: 150, soft_target: 200, hard_max: 300, priority: 2, notes: 'Tomatoes / fruiting stage: raise priority to 1' },
        { element: 'Ca', hard_min: 100, soft_target: 150, hard_max: 220, priority: 1, notes: 'Tip burn risk if below hard_min — keep priority high' },
        { element: 'Mg', hard_min:  30, soft_target:  50, hard_max:  80, priority: 3, notes: '' },
        { element: 'S',  hard_min:  30, soft_target:  60, hard_max: 120, priority: 4, notes: '' },
        { element: 'Fe', hard_min:   1, soft_target:   3, hard_max:   6, priority: 3, notes: 'Iron is critical for chlorosis prevention but easily precipitated above pH 6.5' },
        { element: 'Mn', hard_min: 0.3, soft_target: 0.5, hard_max:   2, priority: 4, notes: '' },
        { element: 'Zn', hard_min: 0.1, soft_target: 0.3, hard_max:   1, priority: 4, notes: '' },
        { element: 'Cu', hard_min: 0.05,soft_target: 0.1, hard_max: 0.5, priority: 5, notes: '' },
        { element: 'Mo', hard_min: 0.01,soft_target: 0.05,hard_max: 0.2, priority: 5, notes: '' },
        { element: 'B',  hard_min: 0.2, soft_target: 0.5, hard_max:   1, priority: 4, notes: '' },
      ];
      const ins = db.prepare(`
        INSERT INTO crop_element_targets
          (crop_assignment_id, growth_stage, element, hard_min, soft_target, hard_max, priority, notes)
        VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?)
      `);
      const tx = db.transaction(() => {
        for (const d of defaults) ins.run(d.element, d.hard_min, d.soft_target, d.hard_max, d.priority, d.notes || null);
      });
      tx();
      console.log(`Seeded ${defaults.length} default crop element targets`);
    }
  } catch (err) {
    console.error('crop_element_targets seed failed:', err.message);
  }

  // Repair: existing installations created plan_guardrails WITHOUT a UNIQUE
  // constraint on name, so each backend restart silently re-inserted the seed
  // row. Dedupe (keep lowest id per name) + install the partial unique index so
  // INSERT OR IGNORE actually ignores from now on.
  try {
    db.exec(`
      DELETE FROM plan_guardrails
      WHERE id NOT IN (SELECT MIN(id) FROM plan_guardrails GROUP BY name);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_guardrails_name_unique ON plan_guardrails(name);
    `);
  } catch (err) {
    console.error('plan_guardrails dedup/unique migration failed:', err.message);
  }

  // Seed plan guardrails on first run (idempotent — uses INSERT OR IGNORE on name).
  // These block applying a plan whose dosing would worsen a low-nutrient state.
  // Triggered automatically by the apply path; operator must type a reason to override.
  try {
    const guardrails = [
      {
        name: 'ca_lockout_below_150',
        description: 'When latest feed AMIC Ca is below 150 mg/L (or no recent sample), refuse to apply any plan that reduces a calcium-source tank below 80% duty. Three documented Ca crashes within four weeks were all traceable to planner-driven dose reductions; this guardrail forces an explicit operator override before another reduction can be applied.',
        severity: 'high',
        element: 'calcium_Ca',
        comparison: 'null_or_lt',
        threshold: 150,
        forbidden_action: 'reduce_element_delivery',
        minimum_tank_duty_pct: 80,
        override_role: 'admin',
      },
    ];
    const ins = db.prepare(`
      INSERT OR IGNORE INTO plan_guardrails
        (name, description, severity, element, comparison, threshold, forbidden_action, minimum_tank_duty_pct, override_role)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let added = 0;
    for (const g of guardrails) {
      const r = ins.run(g.name, g.description, g.severity, g.element, g.comparison, g.threshold, g.forbidden_action, g.minimum_tank_duty_pct, g.override_role);
      if (r.changes > 0) added++;
    }
    if (added > 0) console.log(`Seeded ${added} plan guardrails`);
  } catch (err) {
    console.error('plan_guardrails seed failed:', err.message);
  }

  // Seed ionic-form targets that match the labels AMIC emits (nitrate_NO3, etc.).
  // These let the planner compare lab samples directly against horticultural feed-
  // solution ranges instead of needing to translate to elemental form first.
  // Values are mg/L, tuned for capsicum feed solution. Idempotent: uses INSERT OR
  // IGNORE on the (crop, stage, element) UNIQUE constraint, so existing operator
  // edits are preserved.
  try {
    const ionicDefaults = [
      // element_label,        hard_min, soft_target, hard_max, priority, notes
      { element: 'nitrate_NO3',  hard_min: 400, soft_target: 700, hard_max: 1100, priority: 2, notes: 'Feed solution NO3⁻ target for capsicum. Above 1100 mg/L causes ionic imbalance and excessive vegetative growth.' },
      { element: 'ammonium_NH4', hard_min:   0, soft_target:  20, hard_max:   50, priority: 3, notes: 'NH4⁺ should remain a small fraction of total N (capsicum prefers NO3⁻). High NH4 acidifies the rhizosphere.' },
      { element: 'potassium_K',  hard_min: 200, soft_target: 300, hard_max:  450, priority: 2, notes: 'K⁺ feed target. Raise priority to 1 during fruiting.' },
      { element: 'calcium_Ca',   hard_min: 150, soft_target: 200, hard_max:  280, priority: 1, notes: 'Ca²⁺ critical for BER prevention in capsicum. Keep priority 1.' },
      { element: 'magnesium_Mg', hard_min:  30, soft_target:  50, hard_max:   80, priority: 3, notes: 'Mg²⁺ feed target. Below 30 mg/L → interveinal chlorosis on older leaves.' },
      { element: 'sulfate_SO4',  hard_min:  60, soft_target: 130, hard_max:  250, priority: 4, notes: 'SO4²⁻ rarely limiting in synthetic feeds; high values from K2SO4 are usually benign.' },
      { element: 'phosphate_PO4', hard_min: 30, soft_target:  50, hard_max:   90, priority: 3, notes: 'H2PO4⁻ feed target. Excess can lock out Fe / Zn / Cu.' },
      { element: 'chloride_Cl',  hard_min:   0, soft_target:  30, hard_max:  150, priority: 4, notes: 'Cl⁻ should stay low — comes from source water and certain salts.' },
      { element: 'sodium_Na',    hard_min:   0, soft_target:  30, hard_max:  100, priority: 4, notes: 'Na⁺ accumulates from source water. Watch trend more than absolute value.' },
    ];
    const insIonic = db.prepare(`
      INSERT OR IGNORE INTO crop_element_targets
        (crop_assignment_id, growth_stage, element, hard_min, soft_target, hard_max, priority, notes)
      VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?)
    `);
    let added = 0;
    for (const d of ionicDefaults) {
      const r = insIonic.run(d.element, d.hard_min, d.soft_target, d.hard_max, d.priority, d.notes);
      if (r.changes > 0) added++;
    }
    if (added > 0) console.log(`Seeded ${added} ionic-form crop element targets`);
  } catch (err) {
    console.error('ionic crop_element_targets seed failed:', err.message);
  }

  // Seed operator-reported tanks on first run only (idempotent: bails if any tank exists).
  // Each tank is 1000 L water base. We DO NOT bind to equipment/channel here — the operator
  // assigns channels via the UI once the Waveshare wiring is confirmed. Mixture recipes are
  // created with absolute amounts (kg or L) so the AI agronomist can compute delivered ppm.
  try {
    const existing = db.prepare('SELECT COUNT(*) as c FROM fertigation_tanks').get().c;
    if (existing === 0) {
      const ingredientByName = name => db.prepare('SELECT id FROM fertigation_ingredients WHERE name = ?').get(name);
      const tanks = [
        {
          tank: 'Tank 1 — Calcium Stock', role: 'nutrient',
          mixture: 'Tank 1 Recipe (Ca + Mg)',
          items: [
            { ing: 'Calcium Nitrate',   amount: 100, unit: 'kg' },
            { ing: 'Magnesium Nitrate', amount: 50,  unit: 'kg' },
          ],
        },
        {
          tank: 'Tank 2 — Potassium Stock A', role: 'nutrient',
          mixture: 'Tank 2 Recipe (MKP + K2SO4)',
          items: [
            { ing: 'MKP',                amount: 12.5, unit: 'kg' },
            { ing: 'Potassium Sulphate', amount: 25,   unit: 'kg' },
          ],
        },
        {
          tank: 'Tank 3 — Micros + Humic', role: 'nutrient',
          mixture: 'Tank 3 Recipe (Micros)',
          items: [
            { ing: 'Ferro Active', amount: 2.5, unit: 'kg' },
            { ing: 'Oligo Active', amount: 2.5, unit: 'L'  },
            { ing: 'Humic Acid',   amount: 6,   unit: 'L'  },
          ],
        },
        {
          tank: 'Tank 4 — Potassium Stock B', role: 'nutrient',
          mixture: 'Tank 4 Recipe (MKP + K2SO4)',
          items: [
            { ing: 'MKP',                amount: 12.5, unit: 'kg' },
            { ing: 'Potassium Sulphate', amount: 25,   unit: 'kg' },
          ],
        },
        {
          tank: 'Tank 5 — pH Down', role: 'ph_down',
          mixture: 'Tank 5 Recipe (pH Down)',
          items: [
            { ing: 'pH Down', amount: 10, unit: 'L' },
          ],
        },
      ];

      const insertMix = db.prepare('INSERT INTO fertigation_mixtures (name, description) VALUES (?, ?)');
      const insertItem = db.prepare(`
        INSERT INTO fertigation_mixture_items (mixture_id, ingredient_id, parts, amount, unit)
        VALUES (?, ?, ?, ?, ?)
      `);
      const insertTank = db.prepare(`
        INSERT INTO fertigation_tanks
          (name, role, capacity_liters, water_base_liters, current_stock_liters, mixture_id, notes)
        VALUES (?, ?, 1000, 1000, 0, ?, ?)
      `);

      const tx = db.transaction(() => {
        for (const t of tanks) {
          const mixId = insertMix.run(t.mixture, 'Auto-seeded from operator notes').lastInsertRowid;
          for (const it of t.items) {
            const ing = ingredientByName(it.ing);
            if (!ing) continue;
            insertItem.run(mixId, ing.id, 1, it.amount, it.unit);
          }
          insertTank.run(
            t.tank,
            t.role,
            mixId,
            'Seeded from operator recipe. Bind to a Waveshare channel and log a refill to set current stock.',
          );
        }
      });
      tx();
      console.log(`Seeded ${tanks.length} fertigation tanks from operator notes`);
    }
  } catch (err) {
    console.error('fertigation tanks seed failed:', err.message);
  }

  // Seed default dose programs on first run only (idempotent). Gives the planner a small
  // library of published programs to pick from immediately. Operator can edit duty% and
  // publish new ones from the UI.
  try {
    const existing = db.prepare('SELECT COUNT(*) as c FROM fertigation_dose_programs').get().c;
    if (existing === 0) {
      const tanks = db.prepare('SELECT id, role FROM fertigation_tanks ORDER BY id').all();
      if (tanks.length > 0) {
        const nutrientTanks = tanks.filter(t => t.role === 'nutrient');
        const phDownTanks = tanks.filter(t => t.role === 'ph_down');
        const phUpTanks = tanks.filter(t => t.role === 'ph_up');

        const insertProg = db.prepare(`
          INSERT INTO fertigation_dose_programs
            (name, description, window_seconds, target_ec, target_ph, compatibility_strategy, status, origin)
          VALUES (?, ?, ?, ?, ?, ?, 'published', 'manual')
        `);
        const insertTank = db.prepare(`
          INSERT INTO fertigation_dose_program_tanks (program_id, tank_id, duty_pct, priority, compatibility_slot)
          VALUES (?, ?, ?, ?, ?)
        `);

        const seedProgram = (name, description, window, ec, ph, strategy, duties) => {
          const progId = insertProg.run(name, description, window, ec, ph, strategy).lastInsertRowid;
          for (const d of duties) {
            insertTank.run(progId, d.tank_id, d.duty_pct, d.priority || 0, d.slot ?? null);
          }
        };

        const tx = db.transaction(() => {
          // Full strength: every nutrient tank at 100%, pH Down at 100%. Compatibility = time_slice
          // so calcium-group tanks alternate with sulfate-group tanks.
          seedProgram(
            'Full Strength',
            'Baseline fertigation: every nutrient tank at 100% duty, time-sliced to avoid Ca/SO4 co-injection. pH Down trims separately.',
            60, 2.5, 5.8, 'time_slice',
            [
              ...nutrientTanks.map((t, i) => ({
                tank_id: t.id, duty_pct: 100, priority: i,
                slot: i === 0 ? 0 : (i % 2), // T1 -> slot 0, alternating after
              })),
              ...phDownTanks.map(t => ({ tank_id: t.id, duty_pct: 100, priority: 10 })),
            ],
          );

          // Half strength: every nutrient tank at 50%.
          seedProgram(
            'Half Strength',
            'Reduced strength fertigation — useful for seedlings, hot afternoons, or flush cycles.',
            60, 1.2, 5.8, 'time_slice',
            [
              ...nutrientTanks.map((t, i) => ({
                tank_id: t.id, duty_pct: 50, priority: i,
                slot: i % 2,
              })),
              ...phDownTanks.map(t => ({ tank_id: t.id, duty_pct: 100, priority: 10 })),
            ],
          );

          // Water only: every valve closed (still runs the irrigation pump from the automation).
          // Useful for flushing the substrate without delivering nutrients.
          seedProgram(
            'Water Only (Flush)',
            'Irrigation pump only — all injector valves closed. Use for flushing or when EC/pH out of safe range.',
            60, null, 5.8, 'permissive',
            tanks.map(t => ({ tank_id: t.id, duty_pct: 0 })),
          );

          // pH only: only the pH tank opens (e.g. emergency pH correction).
          if (phDownTanks.length > 0 || phUpTanks.length > 0) {
            seedProgram(
              'pH Correction Only',
              'Only the pH tanks open — nutrient injection skipped. Use when EC is high but pH needs trimming.',
              60, null, 5.8, 'permissive',
              [
                ...nutrientTanks.map(t => ({ tank_id: t.id, duty_pct: 0 })),
                ...phDownTanks.map(t => ({ tank_id: t.id, duty_pct: 100 })),
                ...phUpTanks.map(t => ({ tank_id: t.id, duty_pct: 100 })),
              ],
            );
          }
        });
        tx();
        console.log('Seeded default fertigation dose programs');
      }
    }
  } catch (err) {
    console.error('fertigation_dose_programs seed failed:', err.message);
  }

  // One-shot tank↔channel rebind. Runs only if NO tank is yet bound to an equipment/channel
  // AND legacy mixture-based channels exist on the fertigation pump (equipment_id=2 by site
  // convention). Each channel N gets rebound to Tank N: the channel's tank_id and mixture_id
  // are updated, ingredient_name is cleared, and the tank's equipment_id/channel are set to
  // match. Guarded so it doesn't trample manual rebindings on subsequent boots.
  try {
    const tanksToBind = db.prepare(`
      SELECT id, name, mixture_id FROM fertigation_tanks
      WHERE equipment_id IS NULL AND channel IS NULL
      ORDER BY id
    `).all();
    const anyTankBound = db.prepare('SELECT COUNT(*) as c FROM fertigation_tanks WHERE equipment_id IS NOT NULL').get().c;
    const legacyChannels = db.prepare(`
      SELECT id, channel FROM relay_channel_config
      WHERE equipment_id = 2 AND channel BETWEEN 1 AND 5 AND tank_id IS NULL
      ORDER BY channel
    `).all();
    if (anyTankBound === 0 && tanksToBind.length > 0 && legacyChannels.length > 0) {
      const updateChannel = db.prepare(`
        UPDATE relay_channel_config
        SET tank_id = ?, mixture_id = ?, ingredient_name = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE equipment_id = 2 AND channel = ?
      `);
      const updateTank = db.prepare(`
        UPDATE fertigation_tanks SET equipment_id = 2, channel = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      const tx = db.transaction(() => {
        for (const tank of tanksToBind) {
          // Bind tank N to channel N on the fertigation pump if that channel exists.
          const ch = legacyChannels.find(c => c.channel === tank.id);
          if (!ch) continue;
          updateChannel.run(tank.id, tank.mixture_id, tank.id);
          updateTank.run(tank.id, tank.id);
        }
      });
      tx();
      console.log('One-shot rebind: fertigation channels 1..N → Tank 1..N on equipment 2');
    }
  } catch (err) {
    console.error('tank↔channel rebind failed:', err.message);
  }

  // Add block_id column to zones for A64Core block mapping
  try {
    const zoneCols = db.pragma("table_info(zones)").map(col => col.name);
    if (!zoneCols.includes('block_id')) {
      db.exec("ALTER TABLE zones ADD COLUMN block_id TEXT");
      console.log('Added block_id column to zones table');
    }
    if (!zoneCols.includes('block_code')) {
      db.exec("ALTER TABLE zones ADD COLUMN block_code TEXT");
      console.log('Added block_code column to zones table');
    }
    if (!zoneCols.includes('block_configured_at')) {
      db.exec("ALTER TABLE zones ADD COLUMN block_configured_at TEXT");
      console.log('Added block_configured_at column to zones table');
    }
    if (!zoneCols.includes('is_crop_zone')) {
      db.exec("ALTER TABLE zones ADD COLUMN is_crop_zone INTEGER DEFAULT 0");
      console.log('Added is_crop_zone column to zones table');
    }
  } catch (err) {
    console.log('zones block_id column already exists or migration skipped');
  }

  // Migrate crop_assignments: drop old schema and let CREATE TABLE IF NOT EXISTS rebuild it
  try {
    const cropCols = db.pragma("table_info(crop_assignments)").map(col => col.name);
    if (!cropCols.includes('scientific_name') || !cropCols.includes('max_capacity')) {
      db.exec("DROP TABLE IF EXISTS crop_assignments");
      // Re-run the CREATE TABLE by calling initSchema again would recurse; instead just create inline
      db.exec(`
        CREATE TABLE IF NOT EXISTS crop_assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          block_id TEXT NOT NULL,
          zone_id INTEGER,
          a64core_planting_id TEXT,
          crop_name TEXT NOT NULL,
          variety TEXT,
          scientific_name TEXT,
          plant_data_id TEXT,
          planted_date TEXT,
          expected_harvest_date TEXT,
          growth_cycle_days INTEGER,
          plant_count INTEGER,
          max_capacity INTEGER,
          current_stage TEXT DEFAULT 'seedling',
          optimal_ranges TEXT,
          stage_durations TEXT,
          transitioned_at TEXT,
          days_since_planting INTEGER,
          harvested_at TEXT,
          total_yield_kg REAL,
          average_quality_grade TEXT,
          harvest_count INTEGER,
          active INTEGER DEFAULT 1,
          received_at TEXT DEFAULT CURRENT_TIMESTAMP,
          last_stage_update_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_crop_assignments_block ON crop_assignments(block_id, active);
        CREATE INDEX IF NOT EXISTS idx_crop_assignments_zone ON crop_assignments(zone_id, active);
        CREATE INDEX IF NOT EXISTS idx_crop_assignments_active ON crop_assignments(active);
      `);
      console.log('Migrated crop_assignments table to A64Core contract schema');
    }
  } catch (err) {
    console.log('crop_assignments migration skipped:', err.message);
  }

  // Drop the rigid CHECK constraint on relay_events.source so new sources can be added
  // without a schema migration each time (e.g. 'watchdog_force_off', 'transition_revert').
  try {
    const tbl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='relay_events'").get();
    if (tbl && /CHECK\s*\(\s*source\s+IN\s*\(/i.test(tbl.sql)) {
      console.log('Migrating relay_events: dropping rigid source CHECK constraint');
      db.exec(`
        BEGIN;
        CREATE TABLE relay_events_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          equipment_id INTEGER NOT NULL,
          channel INTEGER NOT NULL,
          state INTEGER NOT NULL,
          source TEXT NOT NULL,
          automation_id INTEGER,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE,
          FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE SET NULL
        );
        INSERT INTO relay_events_new (id, equipment_id, channel, state, source, automation_id, created_at)
          SELECT id, equipment_id, channel, state, source, automation_id, created_at FROM relay_events;
        DROP TABLE relay_events;
        ALTER TABLE relay_events_new RENAME TO relay_events;
        CREATE INDEX IF NOT EXISTS idx_relay_events_equipment ON relay_events(equipment_id);
        CREATE INDEX IF NOT EXISTS idx_relay_events_created ON relay_events(created_at);
        CREATE INDEX IF NOT EXISTS idx_relay_events_equip_channel ON relay_events(equipment_id, channel, created_at);
        COMMIT;
      `);
      console.log('relay_events CHECK constraint dropped');
    }
  } catch (err) {
    console.error('relay_events constraint migration failed:', err.message);
  }

  // Add pH offset tracking columns to lab_readings.
  // Records the AMIC pH calibration buffers + offset that were active when each pH row was saved,
  // so historical rows stay reconcilable when the calibration buffers change later.
  try {
    const labCols = db.pragma("table_info(lab_readings)").map(col => col.name);
    if (!labCols.includes('ph_offset')) {
      db.exec('ALTER TABLE lab_readings ADD COLUMN ph_offset REAL');
      console.log('Added ph_offset column to lab_readings table');
    }
    if (!labCols.includes('ph_buffer_low')) {
      db.exec('ALTER TABLE lab_readings ADD COLUMN ph_buffer_low REAL');
      console.log('Added ph_buffer_low column to lab_readings table');
    }
    if (!labCols.includes('ph_buffer_high')) {
      db.exec('ALTER TABLE lab_readings ADD COLUMN ph_buffer_high REAL');
      console.log('Added ph_buffer_high column to lab_readings table');
    }
  } catch (err) {
    console.log('lab_readings pH offset columns migration skipped:', err.message);
  }

  // Migrate operational_plans: drop UNIQUE(plan_date), add version + confirm/reject columns.
  // Detect by absence of `version` column; do nothing on fresh installs (CREATE TABLE above has the new shape).
  try {
    const planCols = db.pragma("table_info(operational_plans)").map(c => c.name);
    if (planCols.length > 0 && !planCols.includes('version')) {
      console.log('Migrating operational_plans: adding version + confirm/reject fields, dropping UNIQUE(plan_date)');
      db.exec(`
        BEGIN;
        CREATE TABLE operational_plans_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_date TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          parent_plan_id INTEGER,
          generated_for TEXT,
          generated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          model TEXT,
          input_snapshot TEXT,
          headline TEXT,
          summary TEXT,
          proposed_plan_json TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cache_read_tokens INTEGER,
          cache_creation_tokens INTEGER,
          status TEXT CHECK(status IN ('pending', 'confirmed', 'rejected', 'failure', 'success')) DEFAULT 'pending',
          error TEXT,
          rejection_feedback TEXT,
          applied_at TEXT,
          applied_by_user_id INTEGER,
          applied_summary TEXT,
          FOREIGN KEY (parent_plan_id) REFERENCES operational_plans_new(id) ON DELETE SET NULL,
          FOREIGN KEY (applied_by_user_id) REFERENCES users(id) ON DELETE SET NULL
        );
        INSERT INTO operational_plans_new
          (id, plan_date, version, generated_for, generated_at, model, input_snapshot,
           headline, summary, proposed_plan_json,
           input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
           status, error)
        SELECT id, plan_date, 1, generated_for, generated_at, model, input_snapshot,
               headline, summary, proposed_plan_json,
               input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
               CASE WHEN status = 'success' THEN 'pending' ELSE status END,
               error
        FROM operational_plans;
        DROP TABLE operational_plans;
        ALTER TABLE operational_plans_new RENAME TO operational_plans;
        CREATE INDEX IF NOT EXISTS idx_operational_plans_date_version ON operational_plans(plan_date, version DESC);
        CREATE INDEX IF NOT EXISTS idx_operational_plans_status ON operational_plans(status);
        COMMIT;
      `);
      console.log('operational_plans migration complete');
    }
  } catch (err) {
    console.error('operational_plans migration failed:', err.message);
  }

  // Add consistency_warnings column to operational_plans (deterministic post-LLM validator output).
  try {
    const planCols2 = db.pragma('table_info(operational_plans)').map(c => c.name);
    if (planCols2.length > 0 && !planCols2.includes('consistency_warnings')) {
      db.exec('ALTER TABLE operational_plans ADD COLUMN consistency_warnings TEXT');
      console.log('Added consistency_warnings column to operational_plans');
    }
  } catch (err) {
    console.error('operational_plans consistency_warnings migration failed:', err.message);
  }

  // Extend automation_templates for AI-planner usage: parameter definitions, agent guidance,
  // default trigger constraints, and a default trigger config that the agent can override.
  try {
    const tplCols = db.pragma('table_info(automation_templates)').map(c => c.name);
    if (!tplCols.includes('parameters')) {
      db.exec("ALTER TABLE automation_templates ADD COLUMN parameters TEXT DEFAULT '[]'");
      console.log('Added parameters column to automation_templates');
    }
    if (!tplCols.includes('agent_usage_notes')) {
      db.exec('ALTER TABLE automation_templates ADD COLUMN agent_usage_notes TEXT');
      console.log('Added agent_usage_notes column to automation_templates');
    }
    if (!tplCols.includes('default_trigger_type')) {
      db.exec("ALTER TABLE automation_templates ADD COLUMN default_trigger_type TEXT DEFAULT 'schedule'");
      console.log('Added default_trigger_type column to automation_templates');
    }
    if (!tplCols.includes('instantiation_trigger')) {
      db.exec('ALTER TABLE automation_templates ADD COLUMN instantiation_trigger TEXT');
      console.log('Added instantiation_trigger column to automation_templates');
    }
    if (!tplCols.includes('target_effects')) {
      db.exec("ALTER TABLE automation_templates ADD COLUMN target_effects TEXT DEFAULT '[]'");
      console.log('Added target_effects column to automation_templates');
    }
  } catch (err) {
    console.error('automation_templates migration failed:', err.message);
  }

  // Add skip_conditions to automations for pre-execution sensor gating.
  try {
    const autoCols = db.pragma('table_info(automations)').map(c => c.name);
    if (!autoCols.includes('skip_conditions')) {
      db.exec("ALTER TABLE automations ADD COLUMN skip_conditions TEXT DEFAULT '[]'");
      console.log('Added skip_conditions column to automations');
    }
    if (!autoCols.includes('consecutive_skips')) {
      db.exec('ALTER TABLE automations ADD COLUMN consecutive_skips INTEGER DEFAULT 0');
      console.log('Added consecutive_skips column to automations');
    }
  } catch (err) {
    console.error('automations skip_conditions migration failed:', err.message);
  }

  // Seed planner-ready templates (idempotent, keyed by name).
  // Each template's parameters define what the AI planner is allowed to fill in.
  // actions use ${param} placeholders that the apply path resolves before INSERT.
  try {
    const seedTemplates = [
      {
        name: 'Paired pump fertigation',
        category: 'Irrigation',
        description: 'Runs an irrigation pump and a mixing pump simultaneously for the same duration. Use for any fertigation cycle where the nutrient mixer and the irrigation feed must run together.',
        agent_usage_notes: 'Pick this template for any scheduled nutrient feed. Set irrigation_equipment_id + irrigation_channel to the zone irrigation valve; mixing_equipment_id + mixing_channel to the in-line nutrient mixer. duration_min must match both. The template guarantees they start together and run the same length.',
        default_trigger_type: 'schedule',
        target_effects: [
          { metric_name: 'Substrate Moisture', direction: 'raise', magnitude_hint: 'moderate' },
          { metric_name: 'Pore EC', direction: 'raise', magnitude_hint: 'moderate' },
        ],
        parameters: [
          { name: 'irrigation_equipment_id', type: 'integer', required: true, description: 'equipment.id of the irrigation pump/valve relay' },
          { name: 'irrigation_channel', type: 'integer', required: true, min: 1, max: 16, description: '1-based channel on the irrigation relay' },
          { name: 'mixing_equipment_id', type: 'integer', required: true, description: 'equipment.id of the in-line mixing pump relay' },
          { name: 'mixing_channel', type: 'integer', required: true, min: 1, max: 16, description: '1-based channel on the mixing relay' },
          { name: 'duration_min', type: 'integer', required: true, min: 1, max: 60, description: 'Cycle duration in minutes' },
          { name: 'zone_label', type: 'string', required: false, default: '', description: 'Free text for the action message, e.g. "Zone 1"' },
        ],
        conditions: [],
        actions: [
          { type: 'control', action: 'on', equipment_id: '${irrigation_equipment_id}', channel: '${irrigation_channel}', duration_seconds: '${duration_min * 60}' },
          { type: 'control', action: 'on', equipment_id: '${mixing_equipment_id}', channel: '${mixing_channel}', duration_seconds: '${duration_min * 60}' },
        ],
        instantiation_trigger: null,
      },
      {
        name: 'Fertigation cycle with dose program',
        category: 'Irrigation',
        description: 'Run a fertigation cycle with per-tank duty-cycle control. The Irrigation Pump + Mixing Pump run for the full cycle (per_zone_minutes × 4 minutes); the four zone valves open SEQUENTIALLY (Zone 1 → 2 → 3 → 4) so pump pressure stays high. The FertigationDoseScheduler modulates injector valves on the fertigation board independently throughout the cycle based on the automation\'s dose_program_id.',
        agent_usage_notes: 'Pick this template for every scheduled nutrient feed AND for plain-water flushes (with a dose program whose tanks are all duty_pct=0). The four zone valves run SEQUENTIALLY — DO NOT open them in parallel or pump pressure will drop and water will pool in the mixing tank. zone1/2/3/4_channel are the zone valves on the irrigation board (typically 3, 4, 5, 6). pump_channel + mixing_channel are typically 1 and 2 on the same board (irrigation_equipment_id). Total cycle duration = per_zone_minutes × 4. Set dose_program_id at the automation level (not as a template parameter) to a published program from context.dose_programs. For different zone layouts (e.g. 2 or 6 zones) request a new template via template_requests[].',
        default_trigger_type: 'schedule',
        target_effects: [
          { metric_name: 'Substrate Moisture', direction: 'raise', magnitude_hint: 'moderate' },
          { metric_name: 'Pore EC', direction: 'raise', magnitude_hint: 'moderate' },
        ],
        parameters: [
          { name: 'irrigation_equipment_id', type: 'integer', required: true, description: 'equipment.id of the Waveshare board holding pump + mixer + zone channels (typically equipment id 1)' },
          { name: 'pump_channel', type: 'integer', required: true, min: 1, max: 16, description: '1-based channel of the Irrigation Pump on the irrigation board' },
          { name: 'mixing_channel', type: 'integer', required: true, min: 1, max: 16, description: '1-based channel of the Mixing Pump (venturi) on the irrigation board' },
          { name: 'zone1_channel', type: 'integer', required: true, min: 1, max: 16, description: '1-based channel of Zone 1 valve' },
          { name: 'zone2_channel', type: 'integer', required: true, min: 1, max: 16, description: '1-based channel of Zone 2 valve' },
          { name: 'zone3_channel', type: 'integer', required: true, min: 1, max: 16, description: '1-based channel of Zone 3 valve' },
          { name: 'zone4_channel', type: 'integer', required: true, min: 1, max: 16, description: '1-based channel of Zone 4 valve' },
          { name: 'per_zone_minutes', type: 'integer', required: true, min: 1, max: 30, description: 'Minutes each zone valve stays open. Total cycle duration = per_zone_minutes × 4 (pumps run for that full duration).' },
          { name: 'zone_label', type: 'string', required: false, default: '', description: 'Free text label for the action message, e.g. "GreenHouse 1"' },
        ],
        conditions: [],
        actions: [
          // Pumps — full duration, both start at t=0
          { type: 'control', action: 'on', equipment_id: '${irrigation_equipment_id}', channel: '${pump_channel}',   duration_seconds: '${per_zone_minutes * 60 * 4}' },
          { type: 'control', action: 'on', equipment_id: '${irrigation_equipment_id}', channel: '${mixing_channel}', duration_seconds: '${per_zone_minutes * 60 * 4}' },
          // Zones — sequential. Zone N opens at delay (N-1) × per_zone_minutes × 60s.
          { type: 'control', action: 'on', equipment_id: '${irrigation_equipment_id}', channel: '${zone1_channel}', delay_seconds: 0,                              duration_seconds: '${per_zone_minutes * 60}' },
          { type: 'control', action: 'on', equipment_id: '${irrigation_equipment_id}', channel: '${zone2_channel}', delay_seconds: '${per_zone_minutes * 60}',     duration_seconds: '${per_zone_minutes * 60}' },
          { type: 'control', action: 'on', equipment_id: '${irrigation_equipment_id}', channel: '${zone3_channel}', delay_seconds: '${per_zone_minutes * 60 * 2}', duration_seconds: '${per_zone_minutes * 60}' },
          { type: 'control', action: 'on', equipment_id: '${irrigation_equipment_id}', channel: '${zone4_channel}', delay_seconds: '${per_zone_minutes * 60 * 3}', duration_seconds: '${per_zone_minutes * 60}' },
        ],
        instantiation_trigger: null,
      },
      {
        name: 'Single-channel pump cycle',
        category: 'Irrigation',
        description: 'Runs a single pump/valve channel for a fixed duration. Use for water-only flushes, drain cycles, or single-channel irrigation where no mixer is needed.',
        agent_usage_notes: 'Plain on-with-duration. Pick this when only ONE channel needs to run (e.g. plain-water leaching flush, drain pump). For paired nutrient feeds use "Paired pump fertigation" instead. NB: target_effects is empty by default because this template is multi-purpose (irrigation, drain, flush) — author per-automation skip_conditions if you need gating.',
        default_trigger_type: 'schedule',
        target_effects: [],
        parameters: [
          { name: 'equipment_id', type: 'integer', required: true, description: 'equipment.id of the pump relay' },
          { name: 'channel', type: 'integer', required: true, min: 1, max: 16, description: '1-based channel' },
          { name: 'duration_min', type: 'integer', required: true, min: 1, max: 120, description: 'Cycle duration in minutes' },
        ],
        conditions: [],
        actions: [
          { type: 'control', action: 'on', equipment_id: '${equipment_id}', channel: '${channel}', duration_seconds: '${duration_min * 60}' },
        ],
        instantiation_trigger: null,
      },
      {
        name: 'Threshold ON (single channel)',
        category: 'Climate',
        description: 'Turns ON a single relay channel when a sensor metric crosses a threshold. MUST be paired with a "Threshold OFF" rule using the same channel and a hysteresis gap.',
        agent_usage_notes: 'Use for fans/chillers/heaters/dehumidifiers. ALWAYS create a paired "Threshold OFF" rule on the same equipment+channel with operator flipped and a ≥3°C (or ≥10% RH) gap. Never share a threshold_value with another rule.',
        default_trigger_type: 'threshold',
        parameters: [
          { name: 'equipment_id', type: 'integer', required: true, description: 'equipment.id of the relay to switch' },
          { name: 'channel', type: 'integer', required: true, min: 1, max: 16, description: '1-based channel' },
        ],
        conditions: [],
        actions: [
          { type: 'control', action: 'on', equipment_id: '${equipment_id}', channel: '${channel}' },
        ],
        instantiation_trigger: null,
      },
      {
        name: 'Threshold OFF (single channel)',
        category: 'Climate',
        description: 'Turns OFF a single relay channel when a sensor metric crosses a threshold. Companion to "Threshold ON". Per-channel ONLY — never whole-device.',
        agent_usage_notes: 'Must use the SAME equipment_id + channel as its companion ON rule. Threshold values must differ from the ON rule by at least 3°C (or 10% RH).',
        default_trigger_type: 'threshold',
        parameters: [
          { name: 'equipment_id', type: 'integer', required: true, description: 'equipment.id of the relay to switch' },
          { name: 'channel', type: 'integer', required: true, min: 1, max: 16, description: '1-based channel' },
        ],
        conditions: [],
        actions: [
          { type: 'control', action: 'off', equipment_id: '${equipment_id}', channel: '${channel}' },
        ],
        instantiation_trigger: null,
      },
      {
        name: 'Threshold alert',
        category: 'Climate',
        description: 'Emits an alert when a sensor metric crosses a threshold. NOT a control action — this only notifies the operator.',
        agent_usage_notes: 'Use for "temperature critical" escalation rather than duplicating a control rule. Set severity to info | warning | critical. Message should be a single concise sentence.',
        default_trigger_type: 'threshold',
        parameters: [
          { name: 'severity', type: 'string', required: true, default: 'warning', choices: ['info', 'warning', 'critical'], description: 'Alert severity' },
          { name: 'message', type: 'string', required: true, description: 'One-line alert text' },
        ],
        conditions: [],
        actions: [
          { type: 'alert', severity: '${severity}', message: '${message}' },
        ],
        instantiation_trigger: null,
      },
      {
        name: 'Daily operations log',
        category: 'Maintenance',
        description: 'Writes a log entry at a scheduled time. Use for daily checkpoint notes (e.g. "morning summary", "end-of-day handoff").',
        agent_usage_notes: 'No equipment is controlled. Use sparingly — only when the log entry has operational value, not for every event.',
        default_trigger_type: 'schedule',
        parameters: [
          { name: 'message', type: 'string', required: true, description: 'Log message text' },
        ],
        conditions: [],
        actions: [
          { type: 'log', message: '${message}' },
        ],
        instantiation_trigger: null,
      },
    ];

    const insertTpl = db.prepare(`
      INSERT INTO automation_templates
        (name, description, category, conditions, condition_logic, actions, is_system,
         parameters, agent_usage_notes, default_trigger_type, instantiation_trigger, target_effects)
      VALUES (?, ?, ?, ?, 'AND', ?, 1, ?, ?, ?, ?, ?)
    `);
    let seeded = 0;
    for (const tpl of seedTemplates) {
      const exists = db.prepare('SELECT id FROM automation_templates WHERE name = ?').get(tpl.name);
      if (exists) {
        // Idempotent backfill: if a seed template has target_effects defined and the existing row
        // has empty/null, update it. Don't touch other fields.
        if (Array.isArray(tpl.target_effects) && tpl.target_effects.length > 0) {
          const existingEffects = (() => {
            const row = db.prepare('SELECT target_effects FROM automation_templates WHERE id = ?').get(exists.id);
            try { return row?.target_effects ? JSON.parse(row.target_effects) : []; } catch { return []; }
          })();
          if (existingEffects.length === 0) {
            db.prepare('UPDATE automation_templates SET target_effects = ? WHERE id = ?')
              .run(JSON.stringify(tpl.target_effects), exists.id);
          }
        }
        continue;
      }
      insertTpl.run(
        tpl.name, tpl.description, tpl.category,
        JSON.stringify(tpl.conditions || []),
        JSON.stringify(tpl.actions || []),
        JSON.stringify(tpl.parameters || []),
        tpl.agent_usage_notes || '',
        tpl.default_trigger_type || 'schedule',
        tpl.instantiation_trigger ? JSON.stringify(tpl.instantiation_trigger) : null,
        JSON.stringify(tpl.target_effects || []),
      );
      seeded++;
    }
    if (seeded > 0) console.log(`Seeded ${seeded} planner-ready automation templates`);
  } catch (err) {
    console.error('automation_templates seeding failed:', err.message);
  }

  // Analytics-oriented indexes — speed up the time-bucketed GROUP BY queries used by the export endpoint.
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_readings_eq_name_ts ON readings(equipment_id, name, timestamp);
      CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(timestamp);
      CREATE INDEX IF NOT EXISTS idx_automation_logs_status_ts ON automation_logs(automation_id, status, triggered_at);
    `);
  } catch (err) {
    console.error('analytics index creation failed:', err.message);
  }

  // Indexes on operational_plans — created after migration so the `version` column is guaranteed to exist.
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_operational_plans_date_version ON operational_plans(plan_date, version DESC);
      CREATE INDEX IF NOT EXISTS idx_operational_plans_status ON operational_plans(status);
    `);
  } catch (err) {
    console.error('operational_plans index creation failed:', err.message);
  }

  console.log('Database schema initialized');
  return true;
};

// Initialize schema on module load
initSchema();

module.exports = {
  db,
  isConnected: () => db !== null,
  initSchema
};
