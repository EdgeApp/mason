// Mason design language: the single source of truth for every token, ported
// from the design language's tools/tokens.mjs.
//   node scripts/tokens.mjs [--out <file>] [--set <theme>.<role>=<colour>]…
// writes src/web/theme/tokens.css (or --out) and exits non-zero, naming each
// pair, when any pair below misses its WCAG ratio. --set overrides one role
// of the dark or light theme, so a test can prove a miss is caught.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Colour roles, per theme. Dark is the default theme. */
const themes = {
  dark: {
    // Planes, darkest to lightest.
    canvas: '#080b11',
    recessed: '#0b0f18',
    surface: '#111726',
    'surface-sunken': '#0c111c',
    'surface-hover': '#172036',
    'surface-selected': '#1a2540',
    'surface-overlay': '#151c2e',
    // Lines.
    'border-subtle': 'rgba(255,255,255,0.06)',
    border: 'rgba(255,255,255,0.10)',
    'border-strong': 'rgba(255,255,255,0.18)',
    'border-control': '#6b7690',
    'focus-ring': '#4d8dff',
    // Text.
    text: '#e8ecf4',
    'text-secondary': '#aab3c5',
    'text-tertiary': '#8d97ab',
    'text-disabled': '#5c6679',
    'text-on-accent': '#ffffff',
    'text-link': '#86adff',
    'text-link-hover': '#adc8ff',
    // Accent (electric blue).
    accent: '#2563eb',
    'accent-hover': '#2f6af0',
    'accent-pressed': '#1d4ed8',
    'accent-soft': 'rgba(59,130,246,0.16)',
    'accent-soft-text': '#9dbcff',
    'accent-glow': 'rgba(59,130,246,0.35)',
    // Status: text (readable), solid (dots, icons, bars), soft (fills), line.
    'success-text': '#4ade80',
    'success-solid': '#10b981',
    'success-soft': 'rgba(16,185,129,0.14)',
    'success-line': 'rgba(16,185,129,0.40)',
    'warning-text': '#fbbf24',
    'warning-solid': '#f59e0b',
    'warning-soft': 'rgba(245,158,11,0.14)',
    'warning-line': 'rgba(245,158,11,0.40)',
    'danger-text': '#fb8282',
    'danger-solid': '#ef4444',
    'danger-soft': 'rgba(239,68,68,0.14)',
    'danger-line': 'rgba(239,68,68,0.45)',
    'danger-fill': '#dc2626',
    'danger-fill-hover': '#c81e1e',
    'danger-fill-pressed': '#b91c1c',
    'running-text': '#38d9f0',
    'running-solid': '#06b6d4',
    'running-soft': 'rgba(6,182,212,0.14)',
    'running-line': 'rgba(6,182,212,0.40)',
    'info-text': '#b0bcff',
    'info-solid': '#6366f1',
    'info-soft': 'rgba(99,102,241,0.18)',
    'info-line': 'rgba(129,140,248,0.45)',
    'neutral-text': '#aab3c5',
    'neutral-solid': '#7a869c',
    'neutral-soft': 'rgba(148,163,184,0.12)',
    'neutral-line': 'rgba(148,163,184,0.30)',
    // Categorical series: platforms and chart series, in this order.
    'cat-1': '#60a5fa',
    'cat-2': '#22d3ee',
    'cat-3': '#a78bfa',
    'cat-4': '#4ade80',
    'cat-5': '#fbbf24',
    'cat-6': '#f472b6',
    // Glass (navigation layer only).
    'glass-rgb': '11, 15, 24',
    'glass-alpha': '0.78',
    'glass-bg': 'rgba(11,15,24,0.72)',
    'glass-rim': 'rgba(255,255,255,0.10)',
    'glass-bg-opaque': '#0e1320',
    'glass-border': 'rgba(255,255,255,0.08)',
    'glass-highlight': 'rgba(255,255,255,0.06)',
    scrim: 'rgba(3,5,10,0.62)',
    // The canvas's ambient mesh.
    'mesh-1': 'rgba(37,99,235,0.16)',
    'mesh-2': 'rgba(99,102,241,0.12)',
    'mesh-3': 'rgba(6,182,212,0.07)',
  },
  light: {
    canvas: '#f3f5fa',
    recessed: '#eceff6',
    surface: '#ffffff',
    'surface-sunken': '#f5f7fb',
    'surface-hover': '#eef2f9',
    'surface-selected': '#e8effd',
    'surface-overlay': '#ffffff',
    'border-subtle': 'rgba(15,23,40,0.06)',
    border: 'rgba(15,23,40,0.11)',
    'border-strong': 'rgba(15,23,40,0.20)',
    'border-control': '#808b9f',
    'focus-ring': '#2563eb',
    text: '#0f1728',
    'text-secondary': '#475569',
    'text-tertiary': '#5a6780',
    'text-disabled': '#a0a9b8',
    'text-on-accent': '#ffffff',
    'text-link': '#1d4ed8',
    'text-link-hover': '#1e3a8a',
    accent: '#2563eb',
    'accent-hover': '#1d4ed8',
    'accent-pressed': '#1e40af',
    'accent-soft': '#e7efff',
    'accent-soft-text': '#1d4ed8',
    'accent-glow': 'rgba(37,99,235,0.22)',
    'success-text': '#047857',
    'success-solid': '#059669',
    'success-soft': '#e6f7ef',
    'success-line': '#9fdcc2',
    'warning-text': '#a14905',
    'warning-solid': '#d97706',
    'warning-soft': '#fdf3e0',
    'warning-line': '#f3cf8a',
    'danger-text': '#b91c1c',
    'danger-solid': '#ef4444',
    'danger-soft': '#fdecec',
    'danger-line': '#f4b4b4',
    'danger-fill': '#dc2626',
    'danger-fill-hover': '#c81e1e',
    'danger-fill-pressed': '#b91c1c',
    'running-text': '#0e7490',
    'running-solid': '#0891b2',
    'running-soft': '#e2f6fa',
    'running-line': '#9fdbe8',
    'info-text': '#4338ca',
    'info-solid': '#6366f1',
    'info-soft': '#eceefe',
    'info-line': '#c3c8fb',
    'neutral-text': '#475569',
    'neutral-solid': '#8590a3',
    'neutral-soft': '#eff2f6',
    'neutral-line': '#d3d9e3',
    'cat-1': '#2563eb',
    'cat-2': '#0891b2',
    'cat-3': '#7c3aed',
    'cat-4': '#059669',
    'cat-5': '#c26a05',
    'cat-6': '#db2777',
    'glass-rgb': '255, 255, 255',
    'glass-alpha': '0.78',
    'glass-bg': 'rgba(255,255,255,0.74)',
    'glass-rim': 'rgba(15,23,40,0.10)',
    'glass-bg-opaque': '#f7f9fc',
    'glass-border': 'rgba(15,23,40,0.08)',
    'glass-highlight': 'rgba(255,255,255,0.7)',
    scrim: 'rgba(15,23,40,0.36)',
    'mesh-1': 'rgba(37,99,235,0.08)',
    'mesh-2': 'rgba(99,102,241,0.06)',
    'mesh-3': 'rgba(6,182,212,0.05)',
  },
}

/** Increase Contrast overrides, per theme. They are checked like the base roles. */
const contrastMore = {
  dark: {
    'text-secondary': '#c4cbd8',
    'text-tertiary': '#aab3c5',
    'border-subtle': 'rgba(255,255,255,0.14)',
    border: 'rgba(255,255,255,0.22)',
    'border-control': '#8e98ae',
  },
  light: {
    'text-secondary': '#334155',
    'text-tertiary': '#3f4a5e',
    'border-subtle': 'rgba(15,23,40,0.14)',
    border: 'rgba(15,23,40,0.24)',
    'border-control': '#5e6a80',
  },
}

/** The log terminal is dark in both themes. */
const terminal = {
  'term-bg': '#0a0e16',
  'term-gutter': '#0d121c',
  'term-text': '#e2e8f0',
  'term-muted': '#94a3b8',
  'term-line-number': '#7c8ba1',
  'term-selection': 'rgba(59,130,246,0.35)',
  'term-highlight': 'rgba(250,204,21,0.14)',
  'ansi-red': '#f87171',
  'ansi-green': '#4ade80',
  'ansi-yellow': '#facc15',
  'ansi-blue': '#60a5fa',
  'ansi-magenta': '#e879f9',
  'ansi-cyan': '#22d3ee',
  'ansi-gray': '#94a3b8',
}

const shadows = {
  dark: {
    'shadow-1': '0 1px 2px rgba(0,0,0,0.40)',
    'shadow-2': '0 4px 20px -2px rgba(0,0,0,0.50)',
    'shadow-3':
      '0 16px 40px -8px rgba(0,0,0,0.80), 0 0 32px rgba(59,130,246,0.15)',
    'shadow-glow': '0 0 0 1px var(--m-accent), 0 0 16px var(--m-accent-glow)',
  },
  light: {
    'shadow-1': '0 1px 2px rgba(15,23,40,0.06)',
    'shadow-2': '0 4px 16px -4px rgba(15,23,40,0.12)',
    'shadow-3':
      '0 18px 44px -10px rgba(15,23,40,0.24), 0 0 0 1px rgba(15,23,40,0.04)',
    'shadow-glow': '0 0 0 1px var(--m-accent), 0 0 14px var(--m-accent-glow)',
  },
}

/** Theme-independent scales. */
const scales = {
  // Type: Geist for the interface, JetBrains Mono for machine values.
  'font-sans':
    "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  'font-mono': "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
  'font-icon': "'Material Symbols Outlined'",
  'body-size': '0.9375rem',
  'body-line': '1.375rem',
  // Spacing: 4 px base, 8 px rhythm.
  'space-0': '0',
  'space-1': '0.125rem',
  'space-2': '0.25rem',
  'space-3': '0.5rem',
  'space-4': '0.75rem',
  'space-5': '1rem',
  'space-6': '1.25rem',
  'space-7': '1.5rem',
  'space-8': '2rem',
  'space-9': '2.5rem',
  'space-10': '3rem',
  'space-11': '4rem',
  // Radii.
  'radius-xs': '4px',
  'radius-sm': '6px',
  'radius-md': '8px',
  'radius-lg': '12px',
  'radius-xl': '16px',
  'radius-2xl': '24px',
  'radius-glass': '34px',
  'radius-sheet': '38px',
  'radius-pill': '9999px',
  // Sizes.
  'control-sm': '2rem',
  'control-md': '2.5rem',
  'control-lg': '2.75rem',
  'target-min': '2.75rem',
  'sidebar-width': '16rem',
  'rail-width': '5.5rem',
  'topbar-height': '3.5rem',
  'tabbar-height': '3.5rem',
  'content-max': '100rem',
  'reading-max': '45rem',
  // Motion: iOS 27 springs as CSS curves.
  'ease-snappy': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  'ease-gentle': 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
  'ease-stiff': 'cubic-bezier(0.2, 0, 0, 1)',
  'ease-exit': 'cubic-bezier(0.4, 0, 1, 1)',
  'dur-instant': '100ms',
  'dur-fast': '150ms',
  'dur-base': '220ms',
  'dur-slow': '300ms',
  'dur-sheet-in': '500ms',
  'dur-sheet-out': '300ms',
  // Layers.
  'z-base': '0',
  'z-sticky': '10',
  'z-nav': '20',
  'z-dropdown': '40',
  'z-sheet': '100',
  'z-alert': '200',
  'z-toast': '300',
  // Glass.
  'glass-blur': '20px',
  'glass-saturate': '160%',
}

// --- Command line -------------------------------------------------------------

let out = join(root, 'src', 'web', 'theme', 'tokens.css')
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  const value = args[++i]
  if (arg === '--out' && value != null) out = value
  else if (arg === '--set' && /^(dark|light)\.[a-z0-9-]+=./.test(value ?? '')) {
    const [key, colour] = value.split(/=(.*)/)
    const [theme, role] = key.split('.')
    if (!(role in themes[theme])) throw new Error(`No role ${role} in ${theme}`)
    themes[theme][role] = colour
  } else
    throw new Error(
      `Usage: node scripts/tokens.mjs [--out <file>] [--set <theme>.<role>=<colour>]…`,
    )
}

// --- Contrast checking -------------------------------------------------------

function parse(color) {
  if (color.startsWith('#')) {
    const h = color.slice(1)
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1)
  }
  const m = color.match(/rgba?\(([^)]+)\)/)
  const [r, g, b, a = '1'] = m[1].split(',').map((s) => s.trim())
  return [Number(r), Number(g), Number(b), Number(a)]
}

function over(fg, bg) {
  const [r, g, b, a] = parse(fg)
  const [R, G, B] = parse(bg)
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1]
}

function luminance([r, g, b]) {
  const c = (v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b)
}

function ratio(fg, bg) {
  const a = luminance(fg)
  const b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** Resolve a colour that may be translucent onto an opaque base. */
function solid(value, base) {
  return parse(value)[3] < 1 ? over(value, base) : parse(value)
}

const textSurfaces = [
  'canvas',
  'recessed',
  'surface',
  'surface-sunken',
  'surface-hover',
  'surface-selected',
  'surface-overlay',
  'glass-bg-opaque',
]

function pairsFor(t) {
  const out = []
  const add = (fg, bg, min, why, base = 'surface') =>
    out.push({ fg, bg, min, why, base })
  for (const s of textSurfaces) {
    add('text', s, 4.5, 'body text')
    add('text-secondary', s, 4.5, 'secondary text')
    add('text-tertiary', s, 4.5, 'tertiary text (still readable text)')
  }
  for (const s of ['canvas', 'surface', 'surface-hover', 'surface-overlay'])
    add('text-link', s, 4.5, 'link')
  for (const s of ['accent', 'accent-hover', 'accent-pressed'])
    add('text-on-accent', s, 4.5, 'filled button label')
  for (const s of ['danger-fill', 'danger-fill-hover', 'danger-fill-pressed'])
    add(
      'text-on-accent',
      s,
      4.5,
      'filled danger button, danger badge, danger menu hover',
    )
  add(
    'accent-soft-text',
    'surface',
    4.5,
    'accent text on a card (tinted icons, step numbers)',
  )
  for (const s of ['surface-hover', 'surface-selected'])
    for (const k of [
      'success',
      'warning',
      'danger',
      'running',
      'info',
      'neutral',
    ])
      add(`${k}-text`, s, 4.5, `${k} label in a hovered or selected row`)
  add(
    'accent-soft-text',
    'accent-soft',
    4.5,
    'tinted button / selected chip label',
  )
  for (const k of [
    'success',
    'warning',
    'danger',
    'running',
    'info',
    'neutral',
  ]) {
    add(`${k}-text`, 'surface', 4.5, `${k} label on a card`)
    add(`${k}-text`, `${k}-soft`, 4.5, `${k} label on its chip`)
    add(`${k}-text`, 'canvas', 4.5, `${k} label on the canvas`)
    add(`${k}-solid`, 'surface', 3, `${k} dot or icon (non-text)`)
  }
  for (const s of ['surface', 'surface-sunken', 'canvas'])
    add('border-control', s, 3, 'input and checkbox boundary')
  for (const s of ['canvas', 'surface', 'surface-overlay', 'surface-selected'])
    add('focus-ring', s, 3, 'focus ring')
  add('accent', 'surface', 3, 'filled button boundary', 'surface')
  for (let i = 1; i <= 6; i++)
    add(`cat-${i}`, 'surface', 3, 'chart series / platform mark')
  return out
}

const report = []
let failures = 0
const variants = [
  ...Object.entries(themes).map(([name, t]) => [name, t]),
  ...Object.entries(themes).map(([name, t]) => [
    `${name} + Increase Contrast`,
    { ...t, ...contrastMore[name] },
  ]),
]
for (const [name, t] of variants) {
  report.push(
    `## ${name}\n`,
    '| Foreground | Background | Ratio | Needs | Use |',
    '| --- | --- | ---: | ---: | --- |',
  )
  for (const { fg, bg, min, why } of pairsFor(t)) {
    const base = solid(t[bg] ?? terminal[bg], t.surface)
    const r = ratio(solid(t[fg], base), base)
    const ok = r >= min
    if (!ok) failures++
    report.push(
      `| \`${fg}\` | \`${bg}\` | ${r.toFixed(2)}${ok ? '' : ' **FAIL**'} | ${min} | ${why} |`,
    )
  }
  report.push('')
}

// Glass at the default transparency (alpha × 1.05) over the worst content that scrolls under it.
report.push(
  '## glass over scrolled content (default transparency)\n',
  '| Theme | Under the glass | Text role | Ratio | Needs |',
  '| --- | --- | --- | ---: | ---: |',
)
for (const [name, t] of Object.entries(themes)) {
  const alpha = Math.min(1, Number(t['glass-alpha']) * 1.05)
  for (const under of [
    t.canvas,
    t.surface,
    t['surface-hover'],
    terminal['term-bg'],
    '#ffffff',
  ]) {
    const glass = over(`rgba(${t['glass-rgb']},${alpha})`, under)
    // Chrome on glass uses text and text-secondary only; tertiary never sits on glass.
    for (const role of ['text', 'text-secondary']) {
      const r = ratio(solid(t[role], glass), glass)
      if (r < 4.5) failures++
      report.push(
        `| ${name} | \`${under}\` | \`${role}\` | ${r.toFixed(2)}${r < 4.5 ? ' **FAIL**' : ''} | 4.5 |`,
      )
    }
  }
}
report.push('')

report.push(
  '## terminal (both themes)\n',
  '| Foreground | Ratio | Needs |',
  '| --- | ---: | ---: |',
)
for (const k of Object.keys(terminal).filter((k) =>
  /^(term-text|term-muted|term-line-number|ansi-)/.test(k),
)) {
  const r = ratio(parse(terminal[k]), parse(terminal['term-bg']))
  if (r < 4.5) failures++
  report.push(
    `| \`${k}\` | ${r.toFixed(2)}${r < 4.5 ? ' **FAIL**' : ''} | 4.5 |`,
  )
}

// --- CSS output --------------------------------------------------------------

const block = (vars) =>
  Object.entries(vars)
    .map(([k, v]) => `  --m-${k}: ${v};`)
    .join('\n')
let css = `/* Mason design language tokens. Generated by scripts/tokens.mjs; do not edit by hand. */

@font-face {
  font-family: 'Geist';
  src: url('/assets/fonts/geist-variable.woff2') format('woff2');
  font-weight: 100 900;
  font-display: swap;
}
@font-face {
  font-family: 'JetBrains Mono';
  src: url('/assets/fonts/jetbrains-mono-variable.woff2') format('woff2');
  font-weight: 100 800;
  font-display: swap;
}
@font-face {
  font-family: 'Material Symbols Outlined';
  src: url('/assets/fonts/material-symbols-outlined-subset.woff2') format('woff2');
  font-weight: 400;
  font-display: block;
}

:root {
${block(scales)}
${block(terminal)}
}

/* Dark is the default theme; [data-theme="dark"] pins it. */
:root,
[data-theme='dark'] {
  color-scheme: dark;
${block(themes.dark)}
${block(shadows.dark)}
}

[data-theme='light'] {
  color-scheme: light;
${block(themes.light)}
${block(shadows.light)}
}

/* Increase Contrast: stronger lines and secondary text, fully tinted glass. */
@media (prefers-contrast: more) {
  :root,
  [data-theme='dark'] {
${block(contrastMore.dark)}
  }
  [data-theme='light'] {
${block(contrastMore.light)}
  }
  :root { --ios27-glass-transparency: 0; }
}

/* Glass follows the iOS 27 transparency scale: 0 = fully tinted … 1 = ultra clear. */
:root {
  --ios27-glass-transparency: 0.5;
  --m-glass-fill: rgba(var(--m-glass-rgb), calc(var(--m-glass-alpha) * (1.6 - 1.1 * var(--ios27-glass-transparency))));
  --m-glass-blur-now: calc(var(--m-glass-blur) * (0.5 + 0.8 * var(--ios27-glass-transparency)));
}

/* Reduce Transparency: glass becomes opaque and the mesh goes away. */
@media (prefers-reduced-transparency: reduce) {
  :root {
    --ios27-glass-transparency: 0;
    --m-glass-fill: var(--m-glass-bg-opaque);
    --m-glass-blur-now: 0px;
    --m-mesh-1: transparent;
    --m-mesh-2: transparent;
    --m-mesh-3: transparent;
  }
}

/* Touch screens and narrow viewports: 16 px body and inputs. */
@media (pointer: coarse), (max-width: 46.49em) {
  :root { --m-body-size: 1rem; --m-body-line: 1.5rem; }
}

/* Reduce Motion: cross-fades only. */
@media (prefers-reduced-motion: reduce) {
  :root {
    --m-dur-base: 0ms;
    --m-dur-slow: 0ms;
    --m-dur-sheet-in: 200ms;
    --m-dur-sheet-out: 150ms;
    --m-ease-snappy: ease-out;
    --m-ease-gentle: ease-out;
  }
}
`

const bridge = (t) => ({
  // Every variable @ios27_design_system/react's component CSS reads, set from Mason's roles.
  'font-family': 'var(--m-font-sans)',
  // The library uses --color-green only for a Toggle that is on; Mason's toggles are accent.
  'color-green': 'var(--m-accent)',
  'color-blue': 'var(--m-accent)',
  'color-red': 'var(--m-danger-fill)',
  'label-primary': 'var(--m-text)',
  'label-secondary': 'var(--m-text-secondary)',
  'label-tertiary': 'var(--m-text-tertiary)',
  'label-quaternary': 'var(--m-text-disabled)',
  // --bg-primary only fills the selected segment, which must sit above its track.
  'bg-primary': 'var(--m-surface-hover)',
  'bg-tertiary': 'var(--m-surface-hover)',
  'bg-grouped-primary': 'var(--m-canvas)',
  'bg-grouped-secondary': 'var(--m-surface)',
  'fill-primary': 'var(--m-surface-selected)',
  'fill-secondary': 'var(--m-surface-hover)',
  'fill-tertiary': 'var(--m-surface-sunken)',
  'fill-quaternary': 'var(--m-surface-sunken)',
  separator: 'var(--m-border)',
  'separator-opaque': 'var(--m-border-strong)',
  'separator-height': '1px',
  white: '#ffffff',
  black: '#000000',
  'glass-small-bg': 'var(--m-glass-fill)',
  'glass-small-border': 'var(--m-glass-border)',
  'glass-small-shadow-blur': '16px',
  'glass-large-radius': 'var(--m-radius-glass)',
  'ios27-glass-la-rgb': t['glass-rgb'],
  'ios27-glass-la-alpha': t['glass-alpha'],
  'ios27-glass-me-rgb': t['glass-rgb'],
  'ios27-glass-me-alpha': t['glass-alpha'],
  'ios27-glass-rim': t['glass-rim'],
  // Type: Mason's ramp, not the iOS 17 pt body.
  'text-body': 'var(--m-body-size)',
  'lh-body': 'var(--m-body-line)',
  'ls-body': '0',
  'text-subheadline': '0.8125rem',
  'lh-subheadline': '1.125rem',
  'ls-subheadline': '0',
  'text-title3': '1.125rem',
  'weight-regular': '400',
  'weight-medium': '500',
  'weight-semibold': '600',
  // Metrics, spacing (the library's 4-px steps), motion.
  'content-inset': 'var(--m-space-5)',
  'list-row-height': '3.25rem',
  'toolbar-height': 'var(--m-topbar-height)',
  'tabbar-height': 'var(--m-tabbar-height)',
  'space-1': 'var(--m-space-2)',
  'space-2': 'var(--m-space-3)',
  'space-3': 'var(--m-space-4)',
  'space-4': 'var(--m-space-5)',
  'space-5': 'var(--m-space-6)',
  'space-6': 'var(--m-space-7)',
  'easing-apple-default': 'var(--m-ease-stiff)',
  'easing-spring-snappy': 'var(--m-ease-snappy)',
  'easing-spring-gentle': 'var(--m-ease-gentle)',
  'duration-fast': 'var(--m-dur-fast)',
  'duration-alert-present': 'var(--m-dur-fast)',
  'duration-context-menu-open': 'var(--m-dur-fast)',
  'duration-sheet-present': 'var(--m-dur-sheet-in)',
  'duration-sheet-dismiss': 'var(--m-dur-sheet-out)',
})
const raw = (vars) =>
  Object.entries(vars)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join('\n')
css += `
/* iOS 27 bridge: the library's own variables, set from Mason's roles, so its
   components take the theme. The selectors (0,2,1) beat the library's own
   :root[data-theme] and :root:not([data-theme="light"]) rules (0,2,0) in any
   load order. src/web/theme/bridge.test.ts verifies the computed values. */
html:root:not([data-theme='light']) {
${raw(bridge(themes.dark))}
}
html:root[data-theme='light'] {
${raw(bridge(themes.light))}
}
`
writeFileSync(out, css)
let section = ''
for (const line of report)
  if (line.startsWith('## ')) section = line.slice(3).trim()
  else if (line.includes('**FAIL**')) console.error(`${section}: ${line}`)
console.log(`${out} written; ${failures} failing pair(s)`)
process.exit(failures ? 1 : 0)
