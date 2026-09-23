/**
 * RelaySafetyWatchdogService — periodic safety net that force-OFFs any relay
 * channel that has been ON longer than its configured maximum.
 *
 * Catches:
 *   - Backend restarts that wipe in-memory RelayTimerService timers mid-cycle
 *   - Modbus auto-off writes that silently failed
 *   - Automations that issued ON without a matching duration_seconds
 *   - Anything else that leaves a zone or pump stranded
 *
 * Design: every CHECK_INTERVAL_MS, find each (equipment, channel) whose latest
 * relay_event is state=ON and was created more than max_on_seconds ago. For each,
 * issue a Modbus OFF (with retry/verify), log a relay_event with source
 * 'watchdog_force_off', and emit an alert.
 *
 * Config (system_settings.relay_safety_config JSON):
 *   {
 *     enabled: true,
 *     check_interval_seconds: 30,
 *     default_max_on_seconds: 1500,        // 25 min — beyond any current legitimate cycle
 *     per_equipment: { "1": 1500 },         // overrides keyed by equipment_id
 *     ignore_equipment: [3,4,5,6]           // skip cooling/fan boards if needed
 *   }
 */

const { db } = require('../utils/database');
const { createAlert } = require('../utils/alertBroadcast');
const { modbusTcpClient } = require('./ModbusTcpClient');
const { logRelayEvent } = require('./RelayEventLogger');
const interlock = require('./RelayInterlockService');

const CONFIG_KEY = 'relay_safety_config';

const DEFAULT_CONFIG = {
  enabled: true,
  check_interval_seconds: 30,
  default_max_on_seconds: 1500,
  per_equipment: {},
  ignore_equipment: [],
  // When true, the threshold for each stuck channel is derived from the action's
  // configured duration_seconds (control) or transition-pair delay (transition),
  // plus grace_period_seconds. Falls back to the flat thresholds above if the
  // expected duration can't be determined.
  use_action_duration: true,
  grace_period_seconds: 60,
  // Even when expected duration is tiny (e.g. action misconfigured at 5s), never
  // force-OFF below this floor. Protects against bad parses / config bugs.
  min_threshold_seconds: 60,
};

class RelaySafetyWatchdogService {
  constructor() {
    this.timer = null;
    this.lastForceOffPerKey = new Map(); // de-dupe alerts for stuck channels we've already forced
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
    // Re-arm timer if interval changed
    if (this.timer) { this.stop(); this.start(); }
    return merged;
  }

  start() {
    if (this.timer) return;
    const cfg = this.getConfig();
    const intervalMs = Math.max(5, cfg.check_interval_seconds || 30) * 1000;
    this.timer = setInterval(() => this._tick().catch(err => {
      console.error('[RelaySafetyWatchdog] tick error:', err.message);
    }), intervalMs);
    console.log(`[RelaySafetyWatchdog] Started (interval=${intervalMs}ms, default_max=${cfg.default_max_on_seconds}s, enabled=${cfg.enabled})`);
    // Run one check immediately on start so a backend restart doesn't have to wait the full interval
    this._tick().catch(() => {});
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** One safety check pass. Returns the list of channels acted on (for tests / debugging). */
  async _tick() {
    const cfg = this.getConfig();
    if (!cfg.enabled) return [];

    // Interlock conflict sweep over the cached relay states (the poller runs
    // the same check on fresh hardware reads; this is the redundant net).
    try {
      await this._interlockSweep();
    } catch (err) {
      console.error('[RelaySafetyWatchdog] interlock sweep error:', err.message);
    }

    // For each (equipment_id, channel), grab the latest relay_event. If it's an ON event
    // older than threshold, the channel is stuck-on.
    const stuck = db.prepare(`
      SELECT
        re.equipment_id,
        re.channel,
        re.created_at AS on_time,
        re.source AS on_source,
        re.automation_id AS on_auto_id,
        e.name AS equipment_name,
        e.address AS equipment_address,
        e.slave_id,
        e.write_only,
        a.name AS auto_name
      FROM relay_events re
      JOIN equipment e ON re.equipment_id = e.id
      LEFT JOIN automations a ON re.automation_id = a.id
      WHERE re.id IN (
        SELECT MAX(id) FROM relay_events GROUP BY equipment_id, channel
      )
      AND re.state = 1
    `).all();

    const acted = [];
    const nowMs = Date.now();
    for (const s of stuck) {
      if (cfg.ignore_equipment?.includes(s.equipment_id)) continue;
      const onMs = new Date(s.on_time + 'Z').getTime();
      const elapsedSec = Math.floor((nowMs - onMs) / 1000);
      const { threshold, basis, expectedDuration } = this._computeThreshold(s, cfg);
      if (elapsedSec <= threshold) continue;

      try {
        await this._forceOff(s, elapsedSec, threshold, basis, expectedDuration);
        acted.push({
          equipment_id: s.equipment_id,
          channel: s.channel,
          elapsed_sec: elapsedSec,
          threshold_sec: threshold,
          basis,
          expected_duration: expectedDuration,
        });
      } catch (err) {
        console.error(`[RelaySafetyWatchdog] force-off failed for eq=${s.equipment_id} ch=${s.channel}:`, err.message);
      }
    }
    if (acted.length > 0) {
      console.warn(`[RelaySafetyWatchdog] Force-OFF acted on ${acted.length} stuck channel(s):`, acted);
    }
    return acted;
  }

  /** Force OFF any interlock pair whose cached relay states show both ON. */
  async _interlockSweep() {
    const rows = db.prepare("SELECT * FROM equipment WHERE register_mappings LIKE '%interlockWith%'").all();
    for (const row of rows) {
      if (!interlock.hasInterlockPairs(row)) continue;
      let states = {};
      try { states = (JSON.parse(row.last_reading || '{}') || {}).relayStates || {}; } catch { continue; }
      if (interlock.checkHardwareConflict(row, states).length === 0) continue;
      console.error(`[RelaySafetyWatchdog] interlock conflict on ${row.name} (#${row.id}) in cached state — forcing OFF`);
      await interlock.resolveHardwareConflict(row, states, modbusTcpClient, { source: 'relay_safety' });
    }
  }

  /** Pick the threshold for this stuck channel.
   *  Returns { threshold, basis, expectedDuration }:
   *    threshold        — seconds; force OFF if elapsed > threshold
   *    basis            — 'action_duration' | 'per_equipment' | 'global_default'
   *    expectedDuration — derived from automation actions, or null
   */
  _computeThreshold(stuck, cfg) {
    const perEq = cfg.per_equipment?.[String(stuck.equipment_id)];
    const flatFallback = perEq != null ? parseInt(perEq) : cfg.default_max_on_seconds;

    if (cfg.use_action_duration && stuck.on_auto_id) {
      const expected = this._computeExpectedDuration(stuck.equipment_id, stuck.channel, stuck.on_auto_id);
      if (expected != null && expected > 0) {
        const grace = cfg.grace_period_seconds || 60;
        const min = cfg.min_threshold_seconds || 60;
        const threshold = Math.max(expected + grace, min);
        return { threshold, basis: 'action_duration', expectedDuration: expected };
      }
    }
    return { threshold: flatFallback, basis: perEq != null ? 'per_equipment' : 'global_default', expectedDuration: null };
  }

  /** Derive how long this channel was *supposed* to be ON, by inspecting the
   *  automation that turned it on. Handles two action shapes:
   *    - control: { type:'control', action:'on', equipment_id, channel, duration_seconds }
   *    - transition: { type:'transition', equipment_id, delay_seconds, transitions:[{channel,state}] }
   *  For transitions, the expected duration is the gap (in delay_seconds) between
   *  this transition flipping the channel ON and the next transition (in the same
   *  automation, on the same equipment) flipping it OFF.
   *
   *  Returns the largest expected duration found across all matching actions,
   *  or null if nothing useful can be derived.
   */
  _computeExpectedDuration(equipmentId, channel, automationId) {
    if (!automationId) return null;
    const auto = db.prepare('SELECT actions FROM automations WHERE id = ?').get(automationId);
    if (!auto) return null;
    let actions;
    try { actions = JSON.parse(auto.actions); } catch { return null; }
    if (!Array.isArray(actions)) return null;

    let best = null;

    for (const action of actions) {
      if (action.equipment_id !== equipmentId) continue;

      if (action.type === 'control' && action.action === 'on') {
        // The 'all channels' mode (action.channel == null) targets every coil on the equipment
        const targetCh = action.channel != null ? parseInt(action.channel) : null;
        if (targetCh !== null && targetCh !== channel) continue;
        const dur = parseInt(action.duration_seconds);
        if (dur > 0) {
          // delay_seconds offsets when the action fires but doesn't change ON-duration
          if (best == null || dur > best) best = dur;
        }
      } else if (action.type === 'transition' && Array.isArray(action.transitions)) {
        const onTrans = action.transitions.find(
          t => parseInt(t.channel) === channel && t.state === true
        );
        if (!onTrans) continue;
        const onDelay = parseInt(action.delay_seconds) || 0;
        // Find the next transition (by delay) on the same equipment that flips this channel OFF
        let offDelay = null;
        for (const a2 of actions) {
          if (a2.type !== 'transition' || a2.equipment_id !== equipmentId) continue;
          const a2Delay = parseInt(a2.delay_seconds) || 0;
          if (a2Delay <= onDelay) continue;
          if (Array.isArray(a2.transitions) &&
              a2.transitions.find(t => parseInt(t.channel) === channel && t.state === false)) {
            if (offDelay == null || a2Delay < offDelay) offDelay = a2Delay;
          }
        }
        if (offDelay != null) {
          const dur = offDelay - onDelay;
          if (dur > 0 && (best == null || dur > best)) best = dur;
        }
        // If no off transition found, this channel is intended to stay on through
        // the program; we can't bound it from this action alone — skip.
      }
    }

    return best;
  }

  async _forceOff(stuck, elapsedSec, thresholdSec, basis = 'global_default', expectedDuration = null) {
    const { equipment_id, channel, equipment_name, equipment_address, slave_id, write_only, on_time, auto_name, on_auto_id } = stuck;

    const addrParts = (equipment_address || '').split(':');
    if (addrParts.length !== 2) {
      throw new Error(`equipment ${equipment_id} address invalid: ${equipment_address}`);
    }
    const host = addrParts[0];
    const port = parseInt(addrParts[1], 10);
    const unitId = slave_id || 1;

    // Modbus OFF — single coil. Use writeSingleCoil so we get retry behavior.
    if (write_only) {
      await modbusTcpClient.writeSingleCoilFireAndForget(host, port, unitId, channel, false);
    } else {
      await modbusTcpClient.writeSingleCoil(host, port, unitId, channel, false);
    }

    // Verify the coil actually went off (best-effort)
    let verified = null;
    if (!write_only) {
      try {
        await new Promise(r => setTimeout(r, 400));
        const coils = await modbusTcpClient.readCoils(host, port, unitId, channel, 1, { timeout: 3000, retries: 1 });
        verified = coils?.[0] === false;
        if (!verified) {
          console.warn(`[RelaySafetyWatchdog] verify FAILED for eq=${equipment_id} ch=${channel} — coil still ON, retrying once`);
          await modbusTcpClient.writeSingleCoil(host, port, unitId, channel, false);
        }
      } catch (verifyErr) {
        // Don't block on verify failures — the next tick will catch it again if still stuck
      }
    }

    // Update cached relay state on equipment row
    try {
      const eq = db.prepare('SELECT last_reading FROM equipment WHERE id = ?').get(equipment_id);
      const r = eq?.last_reading ? JSON.parse(eq.last_reading) : {};
      if (!r.relayStates) r.relayStates = {};
      r.relayStates[channel] = false;
      db.prepare(
        "UPDATE equipment SET last_reading = ?, last_communication = datetime('now'), updated_at = datetime('now') WHERE id = ?"
      ).run(JSON.stringify(r), equipment_id);
    } catch {}

    // Log the event so the audit trail shows watchdog intervention
    logRelayEvent(equipment_id, channel, false, 'watchdog_force_off', null);

    // Insert an alert for visibility
    const basisLabel = basis === 'action_duration' && expectedDuration != null
      ? `expected ${expectedDuration}s + grace`
      : basis === 'per_equipment' ? 'per-equipment override'
      : 'global default';
    const detail = `Channel was ON for ${elapsedSec}s (threshold ${thresholdSec}s, ${basisLabel}). Originally turned ON at ${on_time}` +
      (auto_name ? ` by automation #${on_auto_id} "${auto_name}"` : '') + '. Watchdog force-OFF complete.';
    // Fingerprint on equipment+channel: the detail embeds elapsed seconds / timestamps,
    // so repeated force-OFFs of the same channel collapse into one open alert.
    createAlert({
      severity: 'warning',
      source: 'relay_safety',
      equipment_id,
      automation_id: on_auto_id ?? null,
      fingerprint: `relay_force_off:${equipment_id}:${channel}`,
      message: `[Safety] Force-OFF ${equipment_name} ch ${channel}: ${detail}`,
    });

    // Broadcast for live UI
    try {
      global.broadcast?.('relay_state_changed', {
        equipmentId: equipment_id,
        channel,
        state: false,
        source: 'watchdog_force_off',
        automationId: null,
      });
      global.broadcast?.('relay_safety_force_off', {
        equipmentId: equipment_id,
        equipmentName: equipment_name,
        channel,
        elapsedSec,
        thresholdSec,
        basis,
        expectedDuration,
        onTime: on_time,
        verified,
      });
    } catch {}
  }
}

const relaySafetyWatchdogService = new RelaySafetyWatchdogService();

module.exports = { relaySafetyWatchdogService, RelaySafetyWatchdogService };
