import { useId, useState, type JSX, type ReactNode } from 'react'
import { Button } from './Button.js'
import { Dialog } from './Dialog.js'

export interface AlertProps {
  open: boolean
  title: ReactNode
  /** Names the thing and what happens to it. */
  message?: ReactNode
  /** The confirming button repeats the verb ("Remove", "Cancel run"). */
  confirm: string
  /** The way out; "Cancel" by default. */
  cancel?: string
  /** `danger` fills the confirming button red: destructive tiers 2 and 3. */
  tone?: 'default' | 'danger'
  /**
   * Tier 3: the confirming button waits until the viewer types this
   * (the host's or the Space's name).
   */
  typeToConfirm?: string
  /** A request is under way. */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * A centred confirmation at every tier. Esc and Cancel back out; a press on
 * the scrim does not. Focus goes to the type-to-confirm field, or the title.
 */
export function Alert({
  open,
  title,
  message,
  confirm,
  cancel = 'Cancel',
  tone = 'default',
  typeToConfirm,
  busy = false,
  onConfirm,
  onCancel,
}: AlertProps): JSX.Element {
  const titleId = useId()
  const fieldId = useId()
  const [typed, setTyped] = useState('')
  const ready = typeToConfirm == null || typed.trim() === typeToConfirm
  const close = (): void => {
    setTyped('')
    onCancel()
  }
  return (
    <Dialog
      open={open}
      onClose={close}
      role="alertdialog"
      labelledBy={titleId}
      dismissOnScrim={false}
    >
      <div className="m-alert">
        <h2
          className="m-t-title3"
          id={titleId}
          tabIndex={-1}
          data-dialog-title=""
        >
          {title}
        </h2>
        {message != null && <p>{message}</p>}
        {typeToConfirm != null && (
          <div className="m-field">
            <label className="m-field__label" htmlFor={fieldId}>
              Type <span className="m-t-mono">{typeToConfirm}</span> to confirm
            </label>
            <input
              id={fieldId}
              className="m-input m-input--mono"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
        )}
        <div className="m-alert__actions">
          <Button variant="secondary" onClick={close}>
            {cancel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger-filled' : 'primary'}
            disabled={!ready}
            busy={busy}
            onClick={() => {
              setTyped('')
              onConfirm()
            }}
          >
            {confirm}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
