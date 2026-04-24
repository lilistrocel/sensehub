/**
 * CalibrationService - Maps raw sensor readings to real-world values via
 * linear regression against manual lab measurements.
 *
 * Use case: cheap soil EC probes report wildly different values than a
 * calibrated conductivity pen. By pairing each manual lab reading with the
 * closest sensor reading in time, we fit a line:  real = slope*raw + intercept
 *
 * Falls back to identity (slope=1, intercept=0) when there are <2 pairs.
 */

const { db } = require('../utils/database');

const MAX_PAIR_AGE_MINUTES = 240; // a lab reading must be within 4h of a sensor reading to count

class CalibrationService {
  /**
   * Recompute calibration for an equipment+metric pair using lab readings of `labNutrient`.
   * Returns the resulting calibration row.
   */
  recompute(equipmentId, metricName, labNutrient, zoneId = null) {
    // Get all lab readings for this nutrient (filtered by zone if provided)
    let labQuery = "SELECT id, sample_date, value FROM lab_readings WHERE nutrient = ?";
    const labParams = [labNutrient];
    if (zoneId !== null && zoneId !== undefined) {
      labQuery += " AND zone_id = ?";
      labParams.push(zoneId);
    }
    labQuery += " ORDER BY sample_date ASC";

    const labReadings = db.prepare(labQuery).all(...labParams);

    // Pair each lab reading with the closest sensor reading in time
    const pairs = [];
    for (const lab of labReadings) {
      const labTime = new Date(lab.sample_date.includes('T') ? lab.sample_date : lab.sample_date + 'T12:00:00Z');
      const cutoffBefore = new Date(labTime.getTime() - MAX_PAIR_AGE_MINUTES * 60 * 1000).toISOString();
      const cutoffAfter = new Date(labTime.getTime() + MAX_PAIR_AGE_MINUTES * 60 * 1000).toISOString();

      const sensorReading = db.prepare(`
        SELECT value, timestamp,
               ABS(strftime('%s', timestamp) - strftime('%s', ?)) as time_diff
        FROM readings
        WHERE equipment_id = ? AND name = ?
          AND timestamp BETWEEN ? AND ?
        ORDER BY time_diff ASC
        LIMIT 1
      `).get(labTime.toISOString(), equipmentId, metricName, cutoffBefore, cutoffAfter);

      if (sensorReading && sensorReading.value !== null) {
        pairs.push({
          lab_value: lab.value,
          sensor_value: sensorReading.value,
          lab_time: lab.sample_date,
          sensor_time: sensorReading.timestamp,
          gap_seconds: sensorReading.time_diff
        });
      }
    }

    let slope = 1.0;
    let intercept = 0.0;
    let rSquared = null;

    if (pairs.length >= 2) {
      // Linear regression: y (real lab) = slope * x (sensor) + intercept
      const n = pairs.length;
      const sumX = pairs.reduce((s, p) => s + p.sensor_value, 0);
      const sumY = pairs.reduce((s, p) => s + p.lab_value, 0);
      const sumXY = pairs.reduce((s, p) => s + p.sensor_value * p.lab_value, 0);
      const sumXX = pairs.reduce((s, p) => s + p.sensor_value * p.sensor_value, 0);
      const sumYY = pairs.reduce((s, p) => s + p.lab_value * p.lab_value, 0);

      const denom = n * sumXX - sumX * sumX;
      if (Math.abs(denom) > 1e-9) {
        slope = (n * sumXY - sumX * sumY) / denom;
        intercept = (sumY - slope * sumX) / n;

        // R²
        const meanY = sumY / n;
        const ssTot = pairs.reduce((s, p) => s + Math.pow(p.lab_value - meanY, 2), 0);
        const ssRes = pairs.reduce((s, p) => {
          const predicted = slope * p.sensor_value + intercept;
          return s + Math.pow(p.lab_value - predicted, 2);
        }, 0);
        rSquared = ssTot > 1e-9 ? 1 - (ssRes / ssTot) : 1;
      }
    } else if (pairs.length === 1) {
      // Single point: use simple ratio (intercept = 0)
      const p = pairs[0];
      if (Math.abs(p.sensor_value) > 1e-9) {
        slope = p.lab_value / p.sensor_value;
        intercept = 0;
      }
    }

    const now = new Date().toISOString();

    // Upsert
    db.prepare(`
      INSERT INTO sensor_calibrations
        (equipment_id, metric_name, lab_nutrient, slope, intercept, r_squared, n_pairs, last_computed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(equipment_id, metric_name) DO UPDATE SET
        lab_nutrient = excluded.lab_nutrient,
        slope = excluded.slope,
        intercept = excluded.intercept,
        r_squared = excluded.r_squared,
        n_pairs = excluded.n_pairs,
        last_computed = excluded.last_computed,
        updated_at = excluded.updated_at
    `).run(equipmentId, metricName, labNutrient, slope, intercept, rSquared, pairs.length, now, now, now);

    console.log(`[Calibration] Recomputed ${metricName} for equipment ${equipmentId}: slope=${slope.toFixed(4)}, intercept=${intercept.toFixed(2)}, R²=${rSquared !== null ? rSquared.toFixed(3) : 'n/a'}, n=${pairs.length}`);

    return this.get(equipmentId, metricName);
  }

  /** Get calibration row for an equipment+metric */
  get(equipmentId, metricName) {
    return db.prepare(
      'SELECT * FROM sensor_calibrations WHERE equipment_id = ? AND metric_name = ?'
    ).get(equipmentId, metricName);
  }

  /** Get pairs used in the calibration (for visualization) */
  getPairs(equipmentId, metricName, labNutrient, zoneId = null) {
    let labQuery = "SELECT id, sample_date, value FROM lab_readings WHERE nutrient = ?";
    const labParams = [labNutrient];
    if (zoneId !== null && zoneId !== undefined) {
      labQuery += " AND zone_id = ?";
      labParams.push(zoneId);
    }
    labQuery += " ORDER BY sample_date ASC";
    const labReadings = db.prepare(labQuery).all(...labParams);

    const pairs = [];
    for (const lab of labReadings) {
      const labTime = new Date(lab.sample_date.includes('T') ? lab.sample_date : lab.sample_date + 'T12:00:00Z');
      const cutoffBefore = new Date(labTime.getTime() - MAX_PAIR_AGE_MINUTES * 60 * 1000).toISOString();
      const cutoffAfter = new Date(labTime.getTime() + MAX_PAIR_AGE_MINUTES * 60 * 1000).toISOString();

      const sensorReading = db.prepare(`
        SELECT value, timestamp FROM readings
        WHERE equipment_id = ? AND name = ?
          AND timestamp BETWEEN ? AND ?
        ORDER BY ABS(strftime('%s', timestamp) - strftime('%s', ?)) ASC
        LIMIT 1
      `).get(equipmentId, metricName, cutoffBefore, cutoffAfter, labTime.toISOString());

      pairs.push({
        lab_id: lab.id,
        lab_value: lab.value,
        lab_time: lab.sample_date,
        sensor_value: sensorReading ? sensorReading.value : null,
        sensor_time: sensorReading ? sensorReading.timestamp : null,
        matched: !!sensorReading
      });
    }
    return pairs;
  }

  /** Apply calibration: real = slope * raw + intercept */
  estimate(equipmentId, metricName, rawValue) {
    const cal = this.get(equipmentId, metricName);
    if (!cal) {
      return { calibrated: rawValue, slope: 1, intercept: 0, n_pairs: 0, r_squared: null, raw: rawValue };
    }
    return {
      calibrated: cal.slope * rawValue + cal.intercept,
      slope: cal.slope,
      intercept: cal.intercept,
      n_pairs: cal.n_pairs,
      r_squared: cal.r_squared,
      raw: rawValue
    };
  }

  /** Get the latest sensor reading and its calibrated estimate */
  getLatestEstimate(equipmentId, metricName) {
    const latest = db.prepare(`
      SELECT value, timestamp FROM readings
      WHERE equipment_id = ? AND name = ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(equipmentId, metricName);

    if (!latest) return null;

    const est = this.estimate(equipmentId, metricName, latest.value);
    return { ...est, timestamp: latest.timestamp };
  }
}

const calibrationService = new CalibrationService();

module.exports = { calibrationService };
