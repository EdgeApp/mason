import { escape } from './html.js'

const sgr = /\x1b\[([0-9;]*)m/g
/** Every escape sequence a terminal would act on, for the plain-text log. */
const escapes =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

const colours = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
]

interface Style {
  colour?: string
  bold: boolean
  underline: boolean
}

function apply(style: Style, codes: number[]): Style {
  const next = { ...style }
  for (const code of codes.length === 0 ? [0] : codes) {
    if (code === 0) {
      delete next.colour
      next.bold = false
      next.underline = false
    } else if (code === 1) next.bold = true
    else if (code === 4) next.underline = true
    else if (code === 22) next.bold = false
    else if (code === 24) next.underline = false
    else if (code === 39) delete next.colour
    else if (code >= 30 && code <= 37) next.colour = colours[code - 30]
    else if (code >= 90 && code <= 97)
      next.colour = `bright-${colours[code - 90]}`
  }
  return next
}

function span(text: string, style: Style): string {
  if (text === '') return ''
  const classes = [
    ...(style.colour == null ? [] : [`ansi-${style.colour}`]),
    ...(style.bold ? ['ansi-bold'] : []),
    ...(style.underline ? ['ansi-underline'] : []),
  ]
  return classes.length === 0
    ? escape(text)
    : `<span class="${classes.join(' ')}">${escape(text)}</span>`
}

/** One line with its colour, bold and underline as classes; everything else escaped. */
export function ansiLine(
  line: string,
  start: Style = { bold: false, underline: false },
): { html: string; style: Style } {
  let style = start
  let html = ''
  let at = 0
  for (const match of line.matchAll(sgr)) {
    html += span(line.slice(at, match.index).replace(escapes, ''), style)
    style = apply(
      style,
      match[1] === '' ? [] : match[1]!.split(';').map((part) => Number(part)),
    )
    at = match.index + match[0].length
  }
  html += span(line.slice(at).replace(escapes, ''), style)
  return { html, style }
}

/**
 * A log as numbered lines; a style carries over from one line to the next,
 * as in a terminal. Each line is a block, so no newline separates them (in
 * a `pre` it would show as a blank line). `first` numbers the first line (a step's lines keep
 * their place in the stage log).
 */
export function logHtml(text: string, first = 1): string {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
  if (text === '') return '<pre class="log"><code></code></pre>'
  let style: Style = { bold: false, underline: false }
  return `<pre class="log"><code>${lines
    .map((line, index) => {
      const rendered = ansiLine(line, style)
      style = rendered.style
      return `<span class="line" data-line="${first + index}">${rendered.html}</span>`
    })
    .join('')}</code></pre>`
}

/** The log without escape sequences, for the plain-text download. */
export function plainLog(text: string): string {
  return text.replace(escapes, '')
}

/** The line number a byte offset of a log falls on, counting from 1. */
export function lineAt(text: Buffer, offset: number): number {
  let lines = 1
  const end = Math.min(offset, text.length)
  for (let i = 0; i < end; i++) if (text[i] === 0x0a) lines++
  return lines
}
