/**
 * Schema for the action audit trail (services/AuditLogService.js,
 * middleware/auditLog.js) and the read indexes the unified Logs API
 * (services/UnifiedLogService.js) needs on the existing event tables.
 *
 * audit_log  one row per mutating API request (every non-GET under /api, plus
 *   login success / failure and logout), written AFTER the response finished,
 *   by the audit middleware. Rows are never updated except `repeat_count` /
 *   `last_at` on coalesced high-frequency actions (camera PTZ moves).
 *   created_at    ISO 8601 UTC with milliseconds (request start).
 *   actor_type    'user' (a person behind an HTTP request) | 'system'.
 *   device        short UA label: "Android phone", "Windows PC", "headless/script".
 *   action        verb: automation.update, relay.control, stop_all, auth.login ...
 *   category      primary domain (irrigation, dosing, climate, automations, ...).
 *   tags          extra categories, comma-bounded (",automations,climate,") so a
 *                 filter on either the domain or the object type finds the row.
 *   summary       one human sentence.
 *   details       JSON: redacted request body, before / after snapshots, a
 *                 field-level diff, safe scalar response fields. Bounded size.
 *   result        'ok' | 'denied' | 'error'; status_code = HTTP status.
 *   Retention: data_retention_config.audit_log_retention_days (default 365).
 */
const AUDIT_LOG_SQL = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    actor_type TEXT NOT NULL DEFAULT 'user',
    actor_id INTEGER,
    actor_email TEXT,
    actor_role TEXT,
    ip TEXT,
    device TEXT,
    user_agent TEXT,
    method TEXT,
    path TEXT,
    action TEXT NOT NULL,
    category TEXT NOT NULL,
    tags TEXT,
    target_type TEXT,
    target_id TEXT,
    target_name TEXT,
    summary TEXT,
    details TEXT,
    result TEXT,
    status_code INTEGER,
    duration_ms INTEGER,
    severity TEXT NOT NULL DEFAULT 'info',
    repeat_count INTEGER NOT NULL DEFAULT 1,
    last_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_email, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_log_category ON audit_log(category, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target_type, target_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, created_at);
`;

// Time indexes the unified read path orders / range-scans by. relay_events and
// request_log already have theirs; these are small tables (a few k rows).
const UNIFIED_READ_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_automation_logs_triggered ON automation_logs(triggered_at);
  CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
  CREATE INDEX IF NOT EXISTS idx_alerts_acked_at ON alerts(acknowledged_at);
  CREATE INDEX IF NOT EXISTS idx_relay_drift_created ON relay_drift_log(created_at);
`;

function ensureAuditLogSchema(db) {
  db.exec(AUDIT_LOG_SQL);
  try { db.exec(UNIFIED_READ_INDEXES_SQL); } catch (_) { /* a source table may not exist yet */ }
}

module.exports = { AUDIT_LOG_SQL, ensureAuditLogSchema };
