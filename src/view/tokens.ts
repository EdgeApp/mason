/**
 * The design tokens: the Tectonic Precision palette, with the shades that
 * fail WCAG AA in the design notes adjusted, and the type and shape scales.
 * The stylesheet is written against these as CSS custom properties.
 */
export const colors = {
  /** Page and panel planes. */
  surface: '#F8F9FF',
  panel: '#FFFFFF',
  panelLow: '#EFF4FF',
  panelHigh: '#DCE9FF',
  border: '#D3DCEA',
  borderStrong: '#B6C2D6',
  /** Text. */
  text: '#0B1C30',
  textMuted: '#475569',
  /** Terracotta: buttons and links in `primary`, accents in `accent`. */
  primary: '#C43D26',
  primaryPressed: '#A8321E',
  onPrimary: '#FFFFFF',
  accent: '#E05338',
  /** Slate structure. */
  slate: '#545F73',
  onSlate: '#FFFFFF',
  /** Indigo platform and metadata chips. */
  indigo: '#4F46E5',
  indigoSoft: '#E1E0FF',
  /** Status. Cancelled and success shades are for dots and icons only. */
  success: '#10B981',
  successText: '#047857',
  running: '#4F46E5',
  failed: '#DC2626',
  errorText: '#B91C1C',
  errorSoft: '#FEE2E2',
  cancelled: '#94A3B8',
  warning: '#B45309',
  warningSoft: '#FEF3C7',
  /** The log terminal, always dark. */
  terminal: '#0F172A',
  terminalText: '#E2E8F0',
  // The notes' #64748B is 3.75:1 on the terminal; this slate is the nearest that passes.
  lineNumber: '#7C8BA1',
} as const

export type ColorToken = keyof typeof colors

export const fonts = {
  sans: "'Geist', ui-sans-serif, system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, Menlo, monospace",
} as const

export const radii = { control: '4px', panel: '8px', full: '9999px' } as const

/** Breakpoints: phone below `tablet`, multi-pane from `desktop`. */
export const breakpoints = { tablet: 768, desktop: 1200 } as const

/**
 * Every text-on-background pair the stylesheet uses, with whether the text
 * is large (at least 18.66 px bold or 24 px), which only needs 3:1.
 */
export const textPairs: ReadonlyArray<
  [text: ColorToken, background: ColorToken, large?: boolean]
> = [
  ['text', 'surface'],
  ['text', 'panel'],
  ['text', 'panelLow'],
  ['text', 'panelHigh'],
  ['textMuted', 'surface'],
  ['textMuted', 'panel'],
  ['textMuted', 'panelLow'],
  ['textMuted', 'panelHigh'],
  ['onPrimary', 'primary'],
  ['onPrimary', 'primaryPressed'],
  ['primary', 'panel'],
  ['primary', 'surface'],
  ['primary', 'panelLow'],
  ['onSlate', 'slate'],
  ['indigo', 'panel'],
  ['indigo', 'indigoSoft'],
  ['successText', 'panel'],
  ['errorText', 'panel'],
  ['errorText', 'errorSoft'],
  ['warning', 'warningSoft'],
  ['terminalText', 'terminal'],
  ['lineNumber', 'terminal'],
]

function channel(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of a `#RRGGBB` colour. */
export function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (match == null) throw new Error(`Not a #RRGGBB colour: ${hex}`)
  const [r, g, b] = match.slice(1).map((part) => channel(parseInt(part, 16)))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** WCAG contrast ratio of two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

/** The CSS custom properties for the tokens. */
export function cssVariables(): string {
  const kebab = (name: string): string =>
    name.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())
  return [
    ...Object.entries(colors).map(
      ([name, value]) => `--color-${kebab(name)}:${value}`,
    ),
    `--font-sans:${fonts.sans}`,
    `--font-mono:${fonts.mono}`,
    `--radius:${radii.control}`,
    `--radius-panel:${radii.panel}`,
  ].join(';')
}
