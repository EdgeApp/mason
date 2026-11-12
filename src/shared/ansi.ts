// A terminal log's lines as styled pieces, for the web app's log viewer: SGR
// colours 30–37 and 90–97 (a bright colour reads as its colour, black as
// gray), bold and underline, carried from one line to the next as a terminal
// carries them; every other escape sequence is dropped.

/** The colours the log viewer draws (`a-<colour>` classes on its tokens). */
export type AnsiColour =
  | 'gray'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'

const COLOURS: AnsiColour[] = [
  'gray',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
]

/** The style in force: where a line starts, and each piece's. */
export interface AnsiStyle {
  colour?: AnsiColour
  bold: boolean
  underline: boolean
}

/** A run of text in one style. */
export interface AnsiPiece {
  text: string
  style: AnsiStyle
}

export const PLAIN: AnsiStyle = { bold: false, underline: false }

const SGR = /\x1b\[([0-9;]*)m/g
/** Every escape sequence a terminal would act on. */
const ESCAPES =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

/** The text without its escape sequences: a step's title, the plain-text log. */
export const stripAnsi = (text: string): string => text.replace(ESCAPES, '')

function apply(style: AnsiStyle, codes: number[]): AnsiStyle {
  const next: AnsiStyle = { ...style }
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
    else if (code >= 30 && code <= 37) next.colour = COLOURS[code - 30]
    else if (code >= 90 && code <= 97) next.colour = COLOURS[code - 90]
  }
  return next
}

/** One line's pieces, starting in `start`; `style` is what the next line starts in. */
export function ansiPieces(
  line: string,
  start: AnsiStyle = PLAIN,
): { pieces: AnsiPiece[]; style: AnsiStyle } {
  let style = start
  const pieces: AnsiPiece[] = []
  let at = 0
  const add = (text: string): void => {
    const clean = stripAnsi(text)
    if (clean !== '') pieces.push({ text: clean, style })
  }
  for (const match of line.matchAll(SGR)) {
    add(line.slice(at, match.index))
    style = apply(
      style,
      match[1] === '' ? [] : match[1]!.split(';').map((part) => Number(part)),
    )
    at = match.index + match[0].length
  }
  add(line.slice(at))
  return { pieces, style }
}

/**
 * A log's text as lines of pieces, the style carried across them. Lines end
 * at a newline only, as the server numbers them; a carriage return within a
 * line (a progress counter) returns to its start, so only the text after the
 * last one shows, though the styles before it still carry.
 */
export function ansiLines(text: string): AnsiPiece[][] {
  if (text === '') return []
  let style = PLAIN
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => {
      const parts = line.replace(/\r+$/, '').split('\r')
      for (const part of parts.slice(0, -1))
        style = ansiPieces(part, style).style
      const parsed = ansiPieces(parts[parts.length - 1]!, style)
      style = parsed.style
      return parsed.pieces
    })
}
