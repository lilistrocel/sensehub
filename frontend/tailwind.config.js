/** @type {import('tailwindcss').Config} */

// ---------------------------------------------------------------------------
// Colour scales. Every scale is derived from a single anchor by mixing in
// OKLab toward the warm paper (#F7F4F1) / night (#14100F) tokens, so the whole
// UI shares one cast. Regenerate with scripts/derive-scales.mjs if an anchor
// changes. The legacy Tailwind families the pages already use (gray, blue,
// green, amber, red, ...) are aliased onto these scales so the app re-skins
// without touching page files.
// ---------------------------------------------------------------------------
const neutral = {
  50: '#F7F4F1',  // paper  (light canvas)
  100: '#F1ECE8', // field  (light input bg)
  200: '#E2DBD5', // line   (light divider)
  300: '#C9C2BC', // ash    (dark muted text)
  400: '#9D9590',
  500: '#6A615D', // stone  (light muted text)
  600: '#514945',
  700: '#3A332E', // line   (dark divider)
  800: '#2E2825', // char   (dark panel)
  900: '#14100F', // night  (dark canvas)
  950: '#0C0908',
};

const brand = { // --grow purple: primary actions, active nav, links
  50: '#F9F6FA', 100: '#E5DBEC', 200: '#CBB7D3', 300: '#B89CC5', 400: '#A380B6',
  500: '#8E62A6', 600: '#6B2E8A', 700: '#4E2762', 800: '#3D2149', 900: '#2D1B33', 950: '#1F151E',
};

const ok = { // running / healthy
  50: '#F9FCFA', 100: '#DAECE0', 200: '#B6D6BD', 300: '#95C7A4', 400: '#5FB07E',
  500: '#4E8661', 600: '#446F51', 700: '#3B5A43', 800: '#314635', 900: '#283428', 950: '#1F231C',
};

const caution = { // unverified / warning
  50: '#FDFBF7', 100: '#F3E5D3', 200: '#E4C8A5', 300: '#D9B27D', 400: '#C9903A',
  500: '#996F32', 600: '#7F5C2D', 700: '#674C27', 800: '#513C22', 900: '#3C2D1C', 950: '#291F16',
};

const alarm = { // --red
  50: '#FDF6F6', 100: '#F4DAD9', 200: '#E4B5B3', 300: '#DA9997', 400: '#CD7B7B',
  500: '#BF595D', 600: '#A3132E', 700: '#741B25', 800: '#581A1F', 900: '#3E1819', 950: '#261413',
};

const lighting = {
  50: '#FBF9FD', 100: '#E9DCF3', 200: '#D2B8E0', 300: '#C099D6', 400: '#A46BC6',
  500: '#7E5496', 600: '#6A477C', 700: '#573C63', 800: '#45304D', 900: '#342638', 950: '#251C25',
};

const water = {
  50: '#F8FBFC', 100: '#D6E5EF', 200: '#AEC9D9', 300: '#89B4CC', 400: '#4E93B8',
  500: '#42718C', 600: '#3A5E73', 700: '#334D5D', 800: '#2C3D48', 900: '#242E35', 950: '#1D2023',
};

// Semantic tokens live as CSS custom properties (src/index.css) so they flip
// with the `.dark` class. Exposed with alpha support via RGB triplets.
const token = (name) => `rgb(var(--${name}-rgb) / <alpha-value>)`;

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // --- semantic tokens (theme-aware) ---
        canvas: token('canvas'),
        panel: token('panel'),
        ink: token('ink'),
        muted: token('muted'),
        line: token('line'),
        field: token('field'),
        brand: { ...brand, DEFAULT: token('brand') },
        state: {
          idle: token('state-idle'),
          ok: token('state-ok'),
          caution: token('state-caution'),
          alarm: token('state-alarm'),
          lighting: token('state-lighting'),
          water: token('state-water'),
        },
        // provenance kinds (src/ui/Provenance.jsx) - marking only, never status
        prov: {
          protocol: token('prov-protocol'),
          operator: token('prov-operator'),
          measured: token('prov-measured'),
          calculated: token('prov-calculated'),
          ai: token('prov-ai'),
        },
        // --- palette scales ---
        ok, caution, alarm, lighting, water,
        // --- legacy family remap (keeps existing page classes working) ---
        gray: neutral,
        slate: neutral,
        zinc: neutral,
        neutral,
        stone: neutral,
        secondary: neutral,
        primary: brand,
        blue: brand,
        green: ok,
        emerald: ok,
        lime: ok,
        teal: water,
        amber: caution,
        yellow: caution,
        orange: caution,
        red: alarm,
        rose: alarm,
        purple: lighting,
        violet: lighting,
        fuchsia: lighting,
        cyan: water,
        sky: water,
        indigo: water,
        success: ok[400],
        warning: caution[400],
        error: alarm[600],
      },
      // Archivo covers Latin + Latin Extended (Turkish ş ğ ı İ ç ö ü). Arabic
      // letters fall through to IBM Plex Sans Arabic (src/i18n/fonts.css), so
      // digits, units and Latin names keep the house face in Arabic UI too.
      fontFamily: {
        sans: ['Archivo', '"IBM Plex Sans Arabic"', 'system-ui', 'sans-serif'],
        display: ['Archivo', '"IBM Plex Sans Arabic"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', '"IBM Plex Sans Arabic"', 'ui-monospace', 'Consolas', 'monospace'],
      },
      borderRadius: {
        card: '8px',
      },
      letterSpacing: {
        label: '.12em',
      },
      fontSize: {
        label: ['11px', { lineHeight: '14px', fontWeight: '700', letterSpacing: '.12em' }],
      },
      minHeight: {
        touch: '44px',
      },
    },
  },
  plugins: [],
}
