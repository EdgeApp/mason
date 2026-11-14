// A copy field (DESIGN-LANGUAGE.md §10): a value people paste elsewhere —
// an install command, a one-time key, a deploy key, an invitation link, a
// callback URL. Copy writes it to the clipboard and says Copied for 2 s;
// where the browser refuses, the value is selected to copy by hand and the
// button says so.
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { Button } from './Button.js'
import { cx } from './cx.js'

/** How long the button says Copied. */
export const COPIED_MS = 2_000

export interface CopyFieldProps {
  /** The text copied, shown in the mono face. */
  value: string
  /** A short label before the value ("Host", "Master"). */
  label?: ReactNode
  /** A long value (a key, a command) wraps over lines. */
  block?: boolean
  /** The button's accessible name, when "Copy" alone is ambiguous on the page. */
  name?: string
  className?: string
}

/** The value in a sunken box with a Copy button. */
export function CopyField({
  value,
  label,
  block = false,
  name,
  className,
}: CopyFieldProps): JSX.Element {
  const code = useRef<HTMLElement>(null)
  const [said, setSaid] = useState<'Copy' | 'Copied' | 'Select and copy'>(
    'Copy',
  )
  useEffect(() => {
    if (said !== 'Copied') return undefined
    const timer = setTimeout(() => setSaid('Copy'), COPIED_MS)
    return (): void => clearTimeout(timer)
  }, [said])
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setSaid('Copied')
    } catch {
      const element = code.current
      if (element != null) {
        const range = document.createRange()
        range.selectNodeContents(element)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
      setSaid('Select and copy')
    }
  }
  return (
    <div className={cx('m-copy', block && 'm-copy--block', className)}>
      {label != null && (
        <span className="m-t-subhead m-tertiary m-copy__label">{label}</span>
      )}
      <code ref={code}>{value}</code>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        icon={said === 'Copied' ? 'check' : 'content_copy'}
        onClick={() => void copy()}
        aria-live="polite"
        {...(name == null ? {} : { 'aria-label': `${said}: ${name}` })}
      >
        {said}
      </Button>
    </div>
  )
}
