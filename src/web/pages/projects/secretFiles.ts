// What the Secrets tab does to files and text before it sends them: bytes
// as base64 within the master's limit, and the text the editor can change
// without changing lines nobody edited.
import { MAX_FILE, tooLarge } from '../../../pipeline/variants.js'

/** Bytes as base64, in chunks small enough for `String.fromCharCode`. */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(binary)
}

/** Why a file cannot be sent: over the master's limit. */
export function fileRefusal(file: Blob): string | undefined {
  return file.size > MAX_FILE
    ? `${tooLarge('The file')}. Choose a smaller file.`
    : undefined
}

/** A file's bytes as base64, refusing one over the master's limit. */
export async function fileContents(file: Blob): Promise<string> {
  const refusal = fileRefusal(file)
  if (refusal != null) throw new Error(refusal)
  return toBase64(new Uint8Array(await file.arrayBuffer()))
}

/** Text as UTF-8 bytes in base64, refusing more than the master takes. */
export function textContents(text: string): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length > MAX_FILE) throw new Error(tooLarge('The text'))
  return toBase64(bytes)
}

/**
 * Text as the editor's text area will hold it, which turns every CRLF into
 * LF: with `crlf` when every line ended in CRLF, so a save puts them back.
 * Undefined when the text mixes line endings or has a lone CR, which the
 * text area would change in lines nobody edited.
 */
export function editableText(
  text: string,
): { text: string; crlf: boolean } | undefined {
  if (!text.includes('\r')) return { text, crlf: false }
  const lf = text.replace(/\r\n/g, '\n')
  if (lf.includes('\r') || /(^|[^\r])\n/.test(text)) return undefined
  return { text: lf, crlf: true }
}
