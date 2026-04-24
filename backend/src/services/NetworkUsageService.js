const fs = require('fs');
const { db } = require('../utils/database');

class NetworkUsageService {
  constructor() {
    this.intervalId = null;
    this.lastSnapshot = null; // { iface: { rx, tx } }
    this.INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    // Exclude virtual/loopback interfaces
    this.EXCLUDED = new Set(['lo', 'docker0', 'br-', 'veth']);
  }

  start() {
    if (this.intervalId) return;
    console.log('[NetworkUsage] Starting network usage tracking (5 min interval)');
    // Take initial snapshot without recording (need two readings to compute delta)
    this.lastSnapshot = this._readProcNetDev();
    this.intervalId = setInterval(() => this._sample(), this.INTERVAL_MS);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[NetworkUsage] Stopped');
    }
  }

  _isExcluded(iface) {
    for (const prefix of this.EXCLUDED) {
      if (iface === prefix || iface.startsWith(prefix)) return true;
    }
    return false;
  }

  _readProcNetDev() {
    try {
      const content = fs.readFileSync('/proc/net/dev', 'utf8');
      const lines = content.split('\n').slice(2); // skip headers
      const result = {};
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [ifacePart, ...rest] = trimmed.split(':');
        const iface = ifacePart.trim();
        if (this._isExcluded(iface)) continue;
        const values = rest.join(':').trim().split(/\s+/);
        // fields: rx_bytes rx_packets ... tx_bytes tx_packets ...
        // rx_bytes = index 0, tx_bytes = index 8
        result[iface] = {
          rx: parseInt(values[0]) || 0,
          tx: parseInt(values[8]) || 0
        };
      }
      return result;
    } catch (err) {
      console.error('[NetworkUsage] Failed to read /proc/net/dev:', err.message);
      return null;
    }
  }

  _sample() {
    const current = this._readProcNetDev();
    if (!current || !this.lastSnapshot) {
      this.lastSnapshot = current;
      return;
    }

    const insert = db.prepare(
      'INSERT INTO network_usage (interface, rx_bytes, tx_bytes, timestamp) VALUES (?, ?, ?, ?)'
    );
    const now = new Date().toISOString();

    const insertMany = db.transaction((entries) => {
      for (const e of entries) {
        insert.run(e.iface, e.rx, e.tx, now);
      }
    });

    const entries = [];
    for (const [iface, cur] of Object.entries(current)) {
      const prev = this.lastSnapshot[iface];
      if (!prev) continue;

      // Compute delta (handle counter wrap)
      let rxDelta = cur.rx - prev.rx;
      let txDelta = cur.tx - prev.tx;
      if (rxDelta < 0) rxDelta = cur.rx; // counter wrapped
      if (txDelta < 0) txDelta = cur.tx;

      // Only store if there's actual traffic
      if (rxDelta > 0 || txDelta > 0) {
        entries.push({ iface, rx: rxDelta, tx: txDelta });
      }
    }

    if (entries.length > 0) {
      try {
        insertMany(entries);
      } catch (err) {
        console.error('[NetworkUsage] Failed to insert:', err.message);
      }
    }

    this.lastSnapshot = current;
  }
}

const networkUsageService = new NetworkUsageService();

module.exports = { networkUsageService };
