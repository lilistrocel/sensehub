/**
 * Dashboard status-board constants: alarm bands, tile order, trend series.
 * Kept in one object so an agronomist can retune a band without touching JSX.
 */

export const API_BASE = '/api';

export const STATUS_BOARD_POLL_MS = 15000;   // server caches for 5 s
export const TRENDS_POLL_MS = 5 * 60 * 1000; // chart data every 5 min
export const STALE_FACTOR = 2;               // reading older than 2x poll -> stale

/** Sensible operating bands: outside -> alarm rail on the tile. */
export const CLIMATE_BANDS = {
  temp_shielded: { min: 15, max: 35 },
  temp_exposed: { min: 15, max: 35 },
  rh: { max: 90 },
  vpd_leaf: { min: 0.3, max: 1.6 },
  water_ph: { min: 5.3, max: 6.8 },
};

/** Tile order and display names on the Now strip (keys from status-board.climate). */
export const CLIMATE_TILES = [
  { key: 'temp_shielded', label: 'Air temp, shielded', precision: 1 },
  { key: 'rh', label: 'Relative humidity', precision: 1 },
  { key: 'vpd_leaf', label: 'VPD leaf', precision: 2 },
  { key: 'temp_exposed', label: 'Air temp, exposed', precision: 1 },
  { key: 'substrate_temp', label: 'Substrate temp', precision: 1 },
  { key: 'substrate_moisture_far', label: 'Substrate moisture, far', precision: 1 },
  { key: 'substrate_moisture_near', label: 'Substrate moisture, near', precision: 1 },
  { key: 'pore_ec_far', label: 'Pore EC, far', precision: 0 },
  { key: 'pore_ec_near', label: 'Pore EC, near', precision: 0 },
  { key: 'water_ph', label: 'Water pH', precision: 2 },
  { key: 'water_ec', label: 'Water EC', precision: 0 },
  { key: 'water_temp', label: 'Water temp', precision: 1 },
];

/** Time ranges for the trend charts. */
export const TIME_RANGES = [
  { value: '6', label: '6 h' },
  { value: '24', label: '24 h' },
  { value: '168', label: '7 d' },
];

/**
 * Trend charts. Each series maps a (equipment_id, metric) pair from
 * /api/dashboard/overview chartReadings to a house palette tone. Tones are
 * fixed per entity, never cycled; two-series panels use lighting + caution,
 * the only house pair that clears the CVD separation check.
 */
export const TREND_CHARTS = [
  {
    key: 'air',
    title: 'Air temperature and humidity',
    series: [
      { key: 'temp_shielded', label: 'Shielded', equipment_id: 8, metric: 'Temperature', tone: 'lighting' },
      { key: 'temp_exposed', label: 'Exposed', equipment_id: 9, metric: 'Temperature', tone: 'caution' },
      { key: 'rh', label: 'RH shielded', equipment_id: 8, metric: 'Humidity', tone: 'water' },
    ],
  },
  {
    key: 'moisture',
    title: 'Substrate moisture',
    series: [
      { key: 'moisture_far', label: 'Far', equipment_id: 7, metric: 'Substrate Moisture', tone: 'lighting' },
      { key: 'moisture_near', label: 'Near', equipment_id: 12, metric: 'Substrate Moisture', tone: 'caution' },
    ],
  },
  {
    key: 'pore_ec',
    title: 'Pore EC',
    series: [
      { key: 'pore_ec_far', label: 'Far', equipment_id: 7, metric: 'Pore EC', tone: 'lighting' },
      { key: 'pore_ec_near', label: 'Near', equipment_id: 12, metric: 'Pore EC', tone: 'caution' },
    ],
  },
];
