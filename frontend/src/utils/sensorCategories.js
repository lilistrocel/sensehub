// Sensor reading categorization for the dashboard "Live Sensor Readings" widget.
// Pure presentation logic — derived from each reading's metric name (with a fallback
// to equipment.type). No DB schema changes.

export const CATEGORIES = [
  {
    id: 'soil',
    label: 'Soil/Substrate',
    icon: '🌱',
    border: 'border-l-emerald-500',
    badge: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    chipActive: 'bg-emerald-600 text-white border-emerald-600',
    chipIdle: 'bg-white text-emerald-700 border-emerald-300 dark:bg-gray-800 dark:text-emerald-300 dark:border-emerald-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/20',
  },
  {
    id: 'climate',
    label: 'Climate',
    icon: '🌡️',
    border: 'border-l-sky-500',
    badge: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
    chipActive: 'bg-sky-600 text-white border-sky-600',
    chipIdle: 'bg-white text-sky-700 border-sky-300 dark:bg-gray-800 dark:text-sky-300 dark:border-sky-800 hover:bg-sky-50 dark:hover:bg-sky-900/20',
  },
  {
    id: 'power',
    label: 'Power/Energy',
    icon: '⚡',
    border: 'border-l-amber-500',
    badge: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    chipActive: 'bg-amber-500 text-white border-amber-500',
    chipIdle: 'bg-white text-amber-700 border-amber-300 dark:bg-gray-800 dark:text-amber-300 dark:border-amber-800 hover:bg-amber-50 dark:hover:bg-amber-900/20',
  },
  {
    id: 'water',
    label: 'Water',
    icon: '💧',
    border: 'border-l-cyan-500',
    badge: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300',
    chipActive: 'bg-cyan-600 text-white border-cyan-600',
    chipIdle: 'bg-white text-cyan-700 border-cyan-300 dark:bg-gray-800 dark:text-cyan-300 dark:border-cyan-800 hover:bg-cyan-50 dark:hover:bg-cyan-900/20',
  },
  {
    id: 'lab',
    label: 'Lab/Analyzer',
    icon: '🧪',
    border: 'border-l-violet-500',
    badge: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300',
    chipActive: 'bg-violet-600 text-white border-violet-600',
    chipIdle: 'bg-white text-violet-700 border-violet-300 dark:bg-gray-800 dark:text-violet-300 dark:border-violet-800 hover:bg-violet-50 dark:hover:bg-violet-900/20',
  },
  {
    id: 'other',
    label: 'Other',
    icon: '📦',
    border: 'border-l-slate-400',
    badge: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    chipActive: 'bg-slate-600 text-white border-slate-600',
    chipIdle: 'bg-white text-slate-700 border-slate-300 dark:bg-gray-800 dark:text-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700',
  },
];

export const CATEGORY_MAP = CATEGORIES.reduce((acc, c) => { acc[c.id] = c; return acc; }, {});

// Rules are evaluated top-to-bottom against the metric name; first match wins.
// Soil rules come before Climate so "Substrate Temperature" routes to soil
// before "Temperature" routes to climate.
const RULES = [
  { cat: 'soil',    re: /substrate|moisture|permittivity|calibrated raw count|bulk\s*ec|pore\s*ec|soil|nitrogen|phosphor|potass(ium)?|\bnpk\b/i },
  { cat: 'climate', re: /humidity|temperature|\bvpd\b|dew\s*point|co2|carbon dioxide/i },
  { cat: 'power',   re: /voltage|current|active\s*power|reactive\s*power|apparent\s*power|cos[\s_-]*(phi|φ)|frequency|energy\s*(imported|exported)|reactive\s*energy|\bkwh\b|\bkvarh\b|operating\s*hour/i },
  { cat: 'water',   re: /dissolved\s*oxygen|\bdo\b|\borp\b|water\s*(ec|ph|temp)|flow\s*rate|^flow$/i },
  { cat: 'lab',     re: /amic|\bno3\b|\bnh4\b|nitrate|ammoni|nutrient/i },
];

// Per-equipment-type fallback when the metric name is empty/unknown.
const TYPE_FALLBACK = {
  meter: 'power',
  sensor: 'other',
  relay: 'other',
};

export function categorizeReading(reading, equipmentTypeById) {
  const name = (reading?.name || '').trim();
  if (name) {
    for (const r of RULES) {
      if (r.re.test(name)) return r.cat;
    }
  }
  const type = equipmentTypeById ? equipmentTypeById[reading?.equipment_id] : null;
  return TYPE_FALLBACK[type] || 'other';
}

// localStorage helpers — selectedCategories is a Set<string> of category ids
// the user has chosen to HIDE. Empty set = show all.
const STORAGE_KEY = 'sensehub.dashboard.hiddenCategories';

export function loadHiddenCategories() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

export function saveHiddenCategories(set) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // ignore (quota / private mode)
  }
}
