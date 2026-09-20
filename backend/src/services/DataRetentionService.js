/**
 * DataRetentionService — nightly compaction + pruning of high-volume tables.
 *
 * Move-then-drop pattern for `readings`:
 *   1. Aggregate rows older than READINGS_RETENTION_DAYS into readings_daily_archive
 *      (preserving min/mean/max/sample_count per day × equipment × metric).
 *   2. DELETE the raw rows that were aggregated.
 *
 * Pure prune for relay_events and automation_logs — they're event streams, not
 * time-series, so aggregating them adds noise without much value. Operators
 * keep the readable summaries via the agronomist/analytics pipelines.
 *
 * Configurable via system_settings.data_retention_config JSON:
 *   {
 *     enabled: true,
 *     run_hour: 3,                           // 03:00 local time
 *     run_minute: 30,
 *     readings_retention_days: 90,
 *     relay_events_retention_days: 60,
 *     automation_logs_retention_days: 30,
 *     alerts_retention_days: 90,             // acknowledged alerts only
 *     dry_run: false,                        // when true, logs what would be done without modifying anything
 *   }
 */

const fs = require('fs');
const path = require('path');
const { db, dbPath: DB_PATH } = require('../utils/database');

// Number of readings rows to delete per batch during compaction. Keeps each
// DELETE transaction small so the WAL doesn't balloon before a checkpoint can
// reclaim it — critical on disk-constrained deployments (e.g. Raspberry Pi).
const READINGS_DELETE_BATCH = 25000;

const CONFIG_KEY = 'data_retention_config';
const DEFAULT_CONFIG = {
  enabled: true,
  run_hour: 3,
  run_minute: 30,
  readings_retention_days: 90,
  relay_events_retention_days: 60,
  automation_logs_retention_days: 30,
  alerts_retention_days: 90,
  // High-volume operational tables. These were previously unpruned and grew
  // without bound (request_log reached 672k rows / ~137MB over 6 months).
  request_log_retention_days: 30,
  network_usage_retention_days: 90,
  dry_run: false,
};

class DataRetentionService {
  constructor() {
    this.timer = null;
    this._lastFiredKey = null;
    this._lastRunSummary = null;
  }

  getConfig() {
    try {
      const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(CONFIG_KEY);
      if (row?.value) return { ...DEFAULT_CONFIG, ...JSON.parse(row.value) };
    } catch {}
    return { ...DEFAULT_CONFIG };
  }

  saveConfig(updates) {
    const merged = { ...this.getConfig(), ...updates };
    db.prepare(
      'INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(CONFIG_KEY, JSON.stringify(merged));
    return merged;
  }

  getLastRunSummary() { return this._lastRunSummary; }

  start() {
    if (this.timer) return;
    this._ensureArchiveTable();
    // 60s tick — checks once per minute whether it's the configured hour:minute
    this.timer = setInterval(() => this._maybeTick().catch(err => {
      console.error('[Retention] tick error:', err.message);
    }), 60000);
    console.log('[Retention] Service started (checks every 60s for configured run time)');
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  _ensureArchiveTable() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS readings_daily_archive (
        day TEXT NOT NULL,
        equipment_id INTEGER NOT NULL,
        metric TEXT NOT NULL,
        unit TEXT,
        sample_count INTEGER,
        min_val REAL,
        mean_val REAL,
        max_val REAL,
        PRIMARY KEY (day, equipment_id, metric)
      );
      CREATE INDEX IF NOT EXISTS idx_readings_daily_archive_day ON readings_daily_archive(day);
    `);
  }

  async _maybeTick() {
    const cfg = this.getConfig();
    if (!cfg.enabled) return;
    const now = this._nowInLocalTz();
    if (now.hour !== cfg.run_hour || now.minute !== cfg.run_minute) return;
    const todayKey = `${now.dateStr}-${cfg.run_hour}-${cfg.run_minute}`;
    if (this._lastFiredKey === todayKey) return;
    this._lastFiredKey = todayKey;
    console.log('[Retention] Starting nightly run');
    try {
      this._lastRunSummary = await this.runOnce(cfg);
      console.log('[Retention] Completed:', JSON.stringify(this._lastRunSummary));
    } catch (err) {
      console.error('[Retention] Run failed:', err.message);
      this._lastRunSummary = { error: err.message, at: new Date().toISOString() };
    }
  }

  /** Run the retention cycle synchronously. Returns a summary object. Safe to call manually. */
  runOnce(cfg = null) {
    cfg = cfg || this.getConfig();
    const summary = {
      started_at: new Date().toISOString(),
      dry_run: !!cfg.dry_run,
      readings: {},
      relay_events: {},
      automation_logs: {},
      alerts: {},
      request_log: {},
      network_usage: {},
    };

    // ----- readings: aggregate then drop -----
    summary.readings = this._compactReadings(cfg.readings_retention_days, cfg.dry_run);

    // ----- relay_events: simple prune -----
    summary.relay_events = this._pruneByAge(
      'relay_events', 'created_at', cfg.relay_events_retention_days, cfg.dry_run,
    );

    // ----- automation_logs: simple prune -----
    summary.automation_logs = this._pruneByAge(
      'automation_logs', 'triggered_at', cfg.automation_logs_retention_days, cfg.dry_run,
    );

    // ----- alerts: prune only ACKNOWLEDGED alerts older than threshold -----
    summary.alerts = this._pruneAckedAlerts(cfg.alerts_retention_days, cfg.dry_run);

    // ----- request_log: simple prune (HTTP access log, purely diagnostic) -----
    summary.request_log = this._pruneByAge(
      'request_log', 'created_at', cfg.request_log_retention_days, cfg.dry_run,
    );

    // ----- network_usage: simple prune (interface counters) -----
    summary.network_usage = this._pruneByAge(
      'network_usage', 'timestamp', cfg.network_usage_retention_days, cfg.dry_run,
    );

    // ----- VACUUM after big deletes (only if we actually deleted something) -----
    const droppedRows =
      (summary.readings.rows_dropped || 0) +
      (summary.relay_events.rows_dropped || 0) +
      (summary.automation_logs.rows_dropped || 0) +
      (summary.alerts.rows_dropped || 0) +
      (summary.request_log.rows_dropped || 0) +
      (summary.network_usage.rows_dropped || 0);
    if (!cfg.dry_run && droppedRows > 10000) {
      // VACUUM rebuilds the DB into a temp copy and can transiently need free
      // space up to the current DB size. On a disk-constrained host that could
      // fill the disk and fail mid-rebuild, so only VACUUM when there's clearly
      // enough headroom. Measuring is best-effort: if we can't measure, skip.
      let canVacuum = false;
      try {
        const dbSize = fs.statSync(DB_PATH).size;
        const stat = fs.statfsSync(path.dirname(DB_PATH));
        const freeBytes = stat.bavail * stat.bsize;
        if (freeBytes >= dbSize) {
          canVacuum = true;
        } else {
          summary.vacuum_skipped = 'insufficient free space';
          summary.vacuum_free_bytes = freeBytes;
          summary.vacuum_db_bytes = dbSize;
        }
      } catch (err) {
        summary.vacuum_skipped = `could not measure free space: ${err.message}`;
      }

      if (canVacuum) {
        console.log(`[Retention] Reclaiming space via VACUUM (${droppedRows.toLocaleString()} rows dropped)`);
        try {
          db.exec('VACUUM');
          summary.vacuumed = true;
        } catch (err) {
          summary.vacuum_error = err.message;
        }
      } else {
        console.log(`[Retention] Skipping VACUUM (${summary.vacuum_skipped}); truncating WAL instead`);
        // Can't compact the main DB, but at least reclaim the WAL.
        try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
      }
    }

    // Always bound the WAL after a retention run so the journal can't linger
    // large after the night's deletes/checkpoints, even on dry runs or no-ops.
    if (!cfg.dry_run) {
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    }

    summary.finished_at = new Date().toISOString();
    return summary;
  }

  _compactReadings(retentionDays, dryRun) {
    const cutoffDate = this._cutoffDate(retentionDays);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);
    // 1) Count what would move
    const eligible = db.prepare(`
      SELECT COUNT(*) AS n FROM readings WHERE date(timestamp) < ?
    `).get(cutoffStr);
    if (eligible.n === 0) return { eligible_rows: 0, archived_buckets: 0, rows_dropped: 0 };

    if (dryRun) {
      const buckets = db.prepare(`
        SELECT COUNT(*) AS n FROM (
          SELECT 1 FROM readings WHERE date(timestamp) < ?
          GROUP BY date(timestamp), equipment_id, COALESCE(name, '')
        )
      `).get(cutoffStr);
      return { eligible_rows: eligible.n, would_archive_buckets: buckets.n, rows_dropped: 0, dry_run: true };
    }

    // 2) Move aggregates into archive (INSERT OR REPLACE so re-runs are idempotent)
    const insertArchive = db.prepare(`
      INSERT INTO readings_daily_archive
        (day, equipment_id, metric, unit, sample_count, min_val, mean_val, max_val)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, equipment_id, metric) DO UPDATE SET
        unit = excluded.unit,
        sample_count = excluded.sample_count,
        min_val = excluded.min_val,
        mean_val = excluded.mean_val,
        max_val = excluded.max_val
    `);
    const aggregates = db.prepare(`
      SELECT
        date(timestamp) AS day,
        equipment_id,
        COALESCE(name, '') AS metric,
        COALESCE(unit, '') AS unit,
        COUNT(*) AS n,
        MIN(value) AS min_val,
        AVG(value) AS mean_val,
        MAX(value) AS max_val
      FROM readings
      WHERE date(timestamp) < ? AND value IS NOT NULL
      GROUP BY date(timestamp), equipment_id, COALESCE(name, '')
    `).all(cutoffStr);

    const tx = db.transaction((rows) => {
      for (const r of rows) {
        insertArchive.run(
          r.day, r.equipment_id, r.metric, r.unit, r.n,
          r.min_val, r.mean_val, r.max_val,
        );
      }
    });
    tx(aggregates);

    // 3) Delete the raw rows we just archived, in bounded batches. A single
    //    DELETE over millions of rows would grow the WAL by gigabytes before
    //    commit and could refill a near-full disk. Deleting in chunks and
    //    checkpointing (PASSIVE) between batches keeps the WAL bounded.
    const delBatch = db.prepare(`
      DELETE FROM readings
      WHERE rowid IN (
        SELECT rowid FROM readings WHERE date(timestamp) < ? LIMIT ${READINGS_DELETE_BATCH}
      )
    `);
    let rowsDropped = 0;
    for (;;) {
      const res = delBatch.run(cutoffStr);
      rowsDropped += res.changes;
      if (res.changes === 0) break;
      // Flush WAL pages back into the main DB so the WAL file stays small.
      try { db.pragma('wal_checkpoint(PASSIVE)'); } catch {}
    }

    return {
      eligible_rows: eligible.n,
      archived_buckets: aggregates.length,
      rows_dropped: rowsDropped,
      cutoff_date: cutoffStr,
    };
  }

  _pruneByAge(table, tsColumn, retentionDays, dryRun) {
    const cutoffDate = this._cutoffDate(retentionDays);
    const cutoffIso = cutoffDate.toISOString();
    const cutoffSql = cutoffIso.replace('T', ' ').slice(0, 19); // SQLite-friendly
    const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE datetime(${tsColumn}) < datetime(?)`).get(cutoffSql);
    if (count.n === 0) return { rows_dropped: 0 };
    if (dryRun) return { eligible_rows: count.n, rows_dropped: 0, dry_run: true };
    const r = db.prepare(`DELETE FROM ${table} WHERE datetime(${tsColumn}) < datetime(?)`).run(cutoffSql);
    return { rows_dropped: r.changes, cutoff: cutoffSql };
  }

  _pruneAckedAlerts(retentionDays, dryRun) {
    const cutoffDate = this._cutoffDate(retentionDays);
    const cutoffSql = cutoffDate.toISOString().replace('T', ' ').slice(0, 19);
    const count = db.prepare(`
      SELECT COUNT(*) AS n FROM alerts
      WHERE acknowledged = 1 AND datetime(created_at) < datetime(?)
    `).get(cutoffSql);
    if (count.n === 0) return { rows_dropped: 0 };
    if (dryRun) return { eligible_rows: count.n, rows_dropped: 0, dry_run: true };
    const r = db.prepare(`
      DELETE FROM alerts
      WHERE acknowledged = 1 AND datetime(created_at) < datetime(?)
    `).run(cutoffSql);
    return { rows_dropped: r.changes, cutoff: cutoffSql };
  }

  _cutoffDate(retentionDays) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - retentionDays);
    return d;
  }

  _nowInLocalTz() {
    const d = new Date();
    const tz = process.env.TZ;
    if (tz) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(d);
      const get = t => parts.find(p => p.type === t)?.value;
      return {
        dateStr: `${get('year')}-${get('month')}-${get('day')}`,
        hour: parseInt(get('hour'), 10),
        minute: parseInt(get('minute'), 10),
      };
    }
    return {
      dateStr: d.toISOString().slice(0, 10),
      hour: d.getHours(),
      minute: d.getMinutes(),
    };
  }
}

const dataRetentionService = new DataRetentionService();

module.exports = { dataRetentionService, DataRetentionService };
