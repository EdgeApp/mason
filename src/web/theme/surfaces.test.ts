// The design's surface rules, read from the stylesheets themselves: cards,
// buttons, pills and overlays draw no outline (their border is the
// transparent edge, which Increase Contrast and forced colours draw), fields
// keep theirs, and every pill pads its sides by its corner radius. Each
// file is parsed into rule blocks, so a rule spread over lines is read whole.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'mocha'

/** The repository, from src/web/theme or lib/web/theme alike. */
const repo = fileURLToPath(new URL('../../../', import.meta.url))

interface Rule {
  file: string
  /** The enclosing at-rule's prelude, or '' at the top level. */
  media: string
  selectors: string[]
  declarations: Map<string, string>
}

/** A stylesheet's rule blocks, comments stripped and at-rules entered. */
function parseRules(css: string, file = ''): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Rule[] = []
  const media: string[] = []
  let at = 0
  for (;;) {
    const open = text.indexOf('{', at)
    const close = text.indexOf('}', at)
    if (close === -1) break
    if (open !== -1 && open < close) {
      const prelude = text.slice(at, open).trim()
      const next = text.indexOf('{', open + 1)
      const end = text.indexOf('}', open + 1)
      if (prelude.startsWith('@') && next !== -1 && next < end) {
        // An at-rule holding rules: its prelude applies until its own brace closes.
        media.push(prelude)
        at = open + 1
        continue
      }
      const body = text.slice(open + 1, end)
      const declarations = new Map<string, string>()
      for (const part of body.split(';')) {
        const colon = part.indexOf(':')
        if (colon === -1) continue
        declarations.set(
          part.slice(0, colon).trim(),
          part
            .slice(colon + 1)
            .replace(/\s+/g, ' ')
            .trim(),
        )
      }
      rules.push({
        file,
        media: media[media.length - 1] ?? '',
        selectors: prelude.split(',').map((s) => s.replace(/\s+/g, ' ').trim()),
        declarations,
      })
      at = end + 1
    } else {
      media.pop()
      at = close + 1
    }
  }
  return rules
}

const FILES = [
  'components.css',
  'pages.css',
  'shell.css',
  'catalog.css',
  'admin.css',
  'admin-settings.css',
  'run.css',
]
const rules = FILES.flatMap((file) =>
  parseRules(
    readFileSync(path.join(repo, 'src', 'web', 'theme', file), 'utf8'),
    file,
  ),
)

/** The top-level rules naming this selector. */
const rulesFor = (selector: string, media = ''): Rule[] =>
  rules.filter(
    (rule) => rule.media === media && rule.selectors.includes(selector),
  )

/** A declaration on a selector, from its last top-level rule that sets it. */
const value = (selector: string, property: string): string | undefined =>
  rulesFor(selector)
    .map((rule) => rule.declarations.get(property))
    .filter((found) => found != null)
    .at(-1)

describe('Surfaces without outlines', () => {
  it('parses rule blocks across lines and inside at-rules', () => {
    const parsed = parseRules(
      '/* a */ .a,\n.b {\n  border: 0;\n  color: red\n}\n@media (x) { .c { padding: 1px; } }\n.d { margin: 0; }',
    )
    assert.deepEqual(
      parsed.map((rule) => [
        rule.media,
        rule.selectors,
        [...rule.declarations],
      ]),
      [
        [
          '',
          ['.a', '.b'],
          [
            ['border', '0'],
            ['color', 'red'],
          ],
        ],
        ['@media (x)', ['.c'], [['padding', '1px']]],
        ['', ['.d'], [['margin', '0']]],
      ],
    )
  })

  it('draws cards, buttons, pills and overlays with the transparent edge and no ring', () => {
    const outlineFree = [
      '.m-card',
      '.m-card--interactive:hover',
      '.m-well',
      '.m-glyphbox',
      '.m-chip',
      '.m-status',
      '.m-kbd',
      '.m-filter',
      '.m-seg',
      '.m-node-pill',
      '.m-errsummary',
      '.m-copy',
      '.m-banner',
      '.m-callout',
      '.m-toast',
      '.m-empty__glyph',
      '.m-alert',
      '.m-formsheet',
      '.m-menu',
      '.m-popover',
      '.m-palette',
      '.m-picker',
      '.m-largesheet',
      '.m-editor',
      '.m-actionsheet__group',
      '.m-searchcap',
      '.m-searchcap:hover',
      '.m-commit__sha',
      '.m-runchip',
      '.m-runchip:hover',
      '.m-graph',
      '.m-log',
      '.m-log__tool',
      ".m-log__tool[aria-pressed='true']",
      '.m-code',
      '.m-steps li::before',
      '.m-steps li.done::before',
      '.m-approval',
      '.m-toggletip',
      '.m-btn',
      '.m-btn--secondary',
      '.m-btn--secondary:hover',
      '.m-btn--tinted:hover',
      '.m-btn--danger',
      ".m-navitem[aria-current='page']",
      '.m-badge--neutral',
      '.m-settings__choice',
      '.m-disclosure--boxed',
      '.m-approval--waiting',
      ".m-seg__opt[aria-current='true']",
    ]
    for (const selector of outlineFree) {
      const found = rulesFor(selector)
      assert(found.length > 0, `no rule for ${selector}`)
      for (const rule of found) {
        for (const [property, set] of rule.declarations) {
          if (property === 'border' && set !== '0')
            // The always-dark log draws with the terminal's own edge.
            assert.match(
              set,
              /var\(--m-(term-)?edge\)/,
              `${selector} ${property}`,
            )
          if (property === 'border-color')
            assert.fail(`${selector} sets border-color ${set}`)
          if (property === 'box-shadow')
            assert.doesNotMatch(
              set,
              /inset 0 0 0/,
              `${selector} draws a ring: ${set}`,
            )
        }
      }
    }
    assert.match(value('.m-gnode', 'stroke')!, /var\(--m-edge\)/)
  })

  it('keeps the outline on fields, checkboxes and steppers', () => {
    for (const selector of ['.m-input', '.m-select', '.m-textarea'])
      assert.match(value(selector, 'border')!, /var\(--m-border-control\)/)
    assert.match(
      value('.m-check input', 'border')!,
      /var\(--m-border-control\)/,
    )
    assert.match(value('.m-stepper', 'border')!, /var\(--m-border-control\)/)
  })

  it('draws the outlines in forced colours', () => {
    const forced = rules.find(
      (rule) =>
        rule.media === '@media (forced-colors: active)' &&
        rule.selectors.includes('.m-card'),
    )
    assert(forced != null)
    for (const selector of ['.m-card', '.m-btn', '.m-chip'])
      assert(forced.selectors.includes(selector), selector)
    assert.equal(forced.declarations.get('border'), '1px solid CanvasText')
  })
})

describe('Pills padded by their corner radius', () => {
  const pills: Array<[string, string]> = [
    ['.m-btn', 'var(--m-control-md)'],
    ['.m-chip', '1.5rem'],
    ['.m-status', '1.5rem'],
    ['.m-node-pill', '1.5rem'],
    ['.m-runchip', '1.75rem'],
    ['.m-badge', '1.25rem'],
    ['.m-filter__opt', '2rem'],
    ['.m-seg__opt', '1.875rem'],
    ['.m-searchcap', '2.375rem'],
  ]

  it('pads each pill’s sides by half its height and rounds it by the same', () => {
    for (const [selector, height] of pills) {
      assert.equal(value(selector, '--h'), height, selector)
      assert.equal(value(selector, 'padding'), '0 calc(var(--h) / 2)', selector)
      assert.equal(
        value(selector, 'border-radius'),
        'calc(var(--h) / 2)',
        selector,
      )
    }
    // The library's own button radius is outranked by the same rule.
    assert.equal(
      value('.m-btn.ios27-btn', 'border-radius'),
      'calc(var(--h) / 2)',
    )
    // Sizes change the height only, so the padding follows it.
    assert.equal(value('.m-btn--sm', '--h'), 'var(--m-control-sm)')
    assert.equal(value('.m-btn--lg', '--h'), 'var(--m-control-lg)')
    for (const selector of ['.m-btn--sm', '.m-btn--lg', '.m-btn--plain'])
      assert.equal(value(selector, 'padding'), undefined, selector)
    // A track never wraps: it stays a full pill.
    for (const selector of ['.m-seg', '.m-filter'])
      assert.equal(
        value(selector, 'border-radius'),
        'var(--m-radius-pill)',
        selector,
      )
  })

  it('grows the touch pills to 44 px with their padding', () => {
    const coarse = rules.filter(
      (rule) => rule.media === '@media (pointer: coarse)',
    )
    const grown = new Set(
      coarse
        .filter(
          (rule) => rule.declarations.get('--h') === 'var(--m-target-min)',
        )
        .flatMap((rule) => rule.selectors),
    )
    for (const selector of [
      '.m-btn',
      '.m-runchip',
      'a.m-chip',
      'button.m-chip',
      '.m-filter__opt',
      '.m-seg__opt',
      '.m-node-pill',
    ])
      assert(grown.has(selector), selector)
  })

  it('grows a pill only through its --h, so it stays fully round', () => {
    const pill =
      /\.m-(btn|chip|status|runchip|node-pill|badge|filter__opt|seg__opt|searchcap)(?![\w-]*__)[^ >+~]*$/
    const grown = rules.filter(
      (rule) =>
        rule.selectors.some((selector) => pill.test(selector)) &&
        rule.declarations.has('min-height') &&
        rule.declarations.get('min-height') !== 'var(--h)' &&
        // An attached button is squared on one side, not a pill.
        !rule.declarations.has('border-radius') &&
        // The touch floor raises controls to 44 px, which a touch pill's --h already is.
        rule.media !== '@media (pointer: coarse)',
    )
    assert.deepEqual(
      grown.map((rule) => `${rule.file} ${rule.selectors.join(', ')}`),
      [],
    )
  })

  it('lets nothing inside a pill reach past its padding', () => {
    assert.equal(value('.m-runchip .m-icon', 'margin-left'), undefined)
  })
})

describe('The phone tab bar', () => {
  it('hides only the labels when a tab has no room, never the icons', () => {
    const hiding = rules.filter(
      (rule) =>
        rule.declarations.get('clip') === 'rect(0 0 0 0)' &&
        rule.selectors.some((selector) =>
          selector.startsWith('.m-tabbar__item'),
        ),
    )
    assert.equal(hiding.length, 2)
    for (const rule of hiding)
      assert.deepEqual(rule.selectors, ['.m-tabbar__item span:not(.m-icon)'])
  })

  it('lets a press held on a slider option drag the thumb, without a link menu', () => {
    for (const selector of ['.m-seg__opt', '.m-filter__opt', '.m-tabbar__item'])
      assert.equal(value(selector, '-webkit-touch-callout'), 'none', selector)
  })

  it('fits three 44 px tabs whose labels clear their pills’ ends from 360 px', () => {
    const narrow =
      '@media (max-width: 46.49em), (max-height: 31.24em) and (max-width: 79.99em)'
    assert.equal(value('.m-tabbar__item', 'height'), '44px')
    assert.equal(value('.m-tabbar__item .m-icon', 'font-size'), '20px')
    // Icon and label fit the 44 px at any text size: the label stops growing at 150 %.
    assert.equal(
      value('.m-tabbar__item span:not(.m-icon)', 'line-height'),
      'min(1rem, 24px)',
    )
    assert.equal(
      value('.m-tabbar__item span:not(.m-icon)', 'font-size'),
      'min(0.75rem, 18px)',
    )
    assert.equal(value('.m-tabbar__item', 'padding'), '0')
    const platter = rules.find(
      (rule) =>
        rule.media === narrow && rule.selectors.includes('.m-tabbar__platter'),
    )!
    assert.equal(platter.declarations.get('gap'), '0')
    assert.equal(platter.declarations.get('padding'), '3px')
    const search = rules.find(
      (rule) =>
        rule.media === narrow && rule.selectors.includes('.m-tabbar__search'),
    )!
    assert.equal(search.declarations.get('width'), '3rem')
    // The labels follow the bar's own width, so a scrollbar counts.
    const bar = rules.find(
      (rule) =>
        rule.media === narrow &&
        rule.selectors.includes('.m-app > .m-app__tabbar') &&
        rule.declarations.has('container'),
    )!
    assert.equal(bar.declarations.get('container'), 'tabbar / inline-size')
    assert(
      rules.some(
        (rule) =>
          rule.media === '@container tabbar (max-width: 21.24rem)' &&
          rule.selectors.includes('.m-tabbar__item span:not(.m-icon)'),
      ),
    )
  })
})
