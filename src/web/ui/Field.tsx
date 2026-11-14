import { TextField as LibraryTextField } from '@ios27_design_system/react'
import {
  forwardRef,
  useId,
  useState,
  type DragEvent,
  type HTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react'
import { Button } from './Button.js'
import { cx } from './cx.js'
import { Icon } from './Icon.js'

/** What every field has around its control (DESIGN-LANGUAGE.md §12 Forms). */
interface Frame {
  label: ReactNode
  /** Says "(optional)" after the label; required fields say nothing. */
  optional?: boolean
  /** Below the control: what to type, and its format. */
  help?: ReactNode
  /** Below the help, announced: what is wrong with the value. */
  error?: string | undefined
}

/** The ids a control points its description at. */
interface Described {
  id: string
  describedBy: string | undefined
  invalid: boolean
}

/** A field's label, its control, its help and its error, tied together by ids. */
function FieldFrame({
  label,
  optional = false,
  help,
  error,
  id,
  labelFor = true,
  children,
}: Frame & {
  id?: string | undefined
  /** Whether the label names the control by `for` (not for a drop zone, which is its own label). */
  labelFor?: boolean
  children: (described: Described) => ReactNode
}): JSX.Element {
  const generated = useId()
  const controlId = id ?? generated
  const helpId = `${controlId}-help`
  const errorId = `${controlId}-error`
  const describedBy =
    [help != null && helpId, error != null && errorId]
      .filter(Boolean)
      .join(' ') || undefined
  const Label = labelFor ? 'label' : 'span'
  return (
    <div className="m-field">
      <Label
        className="m-field__label"
        {...(labelFor ? { htmlFor: controlId } : { id: `${controlId}-label` })}
      >
        {label}
        {optional && <span className="m-tertiary">(optional)</span>}
      </Label>
      {children({ id: controlId, describedBy, invalid: error != null })}
      {help != null && (
        <p className="m-field__help" id={helpId}>
          {help}
        </p>
      )}
      {error != null && (
        <p className="m-field__error" id={errorId} role="alert">
          <Icon name="error" />
          {error}
        </p>
      )}
    </div>
  )
}

export interface TextInputProps extends Frame {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  type?: 'text' | 'email' | 'password'
  id?: string
  name?: string
  /** Machine values (codes, repositories, usernames) in the mono face. */
  mono?: boolean
  /** A six-digit code: spaced digits in a short field. */
  code?: boolean
  autoComplete?: string
  inputMode?: HTMLAttributes<HTMLInputElement>['inputMode']
  pattern?: string
  maxLength?: number
  required?: boolean
  readOnly?: boolean
  placeholder?: string
  autoFocus?: boolean
  /** Machine values are typed as they are: no capitals, no spelling fixes. */
  verbatim?: boolean
  /** A button inside the field's end (showing the password). */
  end?: ReactNode
}

/**
 * A text field: the iOS 27 library's TextField (themed by the bridge, drawn
 * as `.m-input` by forms.css) with Mason's label, help and error.
 */
export function TextInput({
  label,
  optional,
  help,
  error,
  value,
  onChange,
  onBlur,
  type = 'text',
  id,
  name,
  mono = false,
  code = false,
  autoComplete,
  inputMode,
  pattern,
  maxLength,
  required = false,
  readOnly = false,
  placeholder,
  autoFocus,
  verbatim = false,
  end,
}: TextInputProps): JSX.Element {
  return (
    <FieldFrame
      label={label}
      optional={optional ?? false}
      help={help}
      error={error}
      id={id}
    >
      {(described) => (
        <div className="m-field__control">
          <LibraryTextField
            id={described.id}
            className={cx(
              'm-textfield',
              (mono || code) && 'm-textfield--mono',
              code && 'm-textfield--code',
              end != null && 'm-textfield--end',
            )}
            type={type}
            value={value}
            onChange={onChange}
            onBlur={onBlur}
            name={name}
            autoComplete={autoComplete}
            inputMode={inputMode}
            pattern={pattern}
            maxLength={maxLength}
            required={required}
            aria-required={required || undefined}
            readOnly={readOnly}
            placeholder={placeholder}
            autoFocus={autoFocus}
            aria-invalid={described.invalid || undefined}
            aria-describedby={described.describedBy}
            {...(verbatim
              ? {
                  autoCapitalize: 'none',
                  autoCorrect: 'off',
                  spellCheck: false,
                }
              : {})}
          />
          {end != null && <span className="m-affix__end">{end}</span>}
        </div>
      )}
    </FieldFrame>
  )
}

/** A password field with a button that shows what was typed; paste is allowed. */
export function PasswordInput(
  props: Omit<TextInputProps, 'type' | 'end' | 'verbatim'> & {
    autoComplete: 'current-password' | 'new-password'
  },
): JSX.Element {
  const [shown, setShown] = useState(false)
  return (
    <TextInput
      {...props}
      type={shown ? 'text' : 'password'}
      verbatim
      end={
        <Button
          type="button"
          variant="plain"
          size="sm"
          iconOnly
          icon="visibility"
          label="Show password"
          className="m-reveal"
          aria-pressed={shown}
          onClick={() => setShown((value) => !value)}
        />
      }
    />
  )
}

export interface DateInputProps extends Frame {
  value: string
  onChange: (value: string) => void
  id?: string
  name?: string
}

/** A date, `type="date"`, with its format in the help (DESIGN-LANGUAGE.md §12). */
export function DateInput({
  label,
  optional,
  help,
  error,
  value,
  onChange,
  id,
  name,
}: DateInputProps): JSX.Element {
  return (
    <FieldFrame
      label={label}
      optional={optional ?? false}
      help={help}
      error={error}
      id={id}
    >
      {(described) => (
        <input
          id={described.id}
          name={name}
          className="m-input m-input--mono m-input--date"
          type="date"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          aria-invalid={described.invalid || undefined}
          aria-describedby={described.describedBy}
        />
      )}
    </FieldFrame>
  )
}

export interface FileInputProps extends Frame {
  /** The chosen file, if any. */
  file: File | undefined
  onChange: (file: File | undefined) => void
  /** The drop zone's words: "Choose the key file". */
  choose: string
  /** A line under the prompt: what it takes ("Up to 5 MiB."). */
  hint?: ReactNode
  /** What follows the chosen file's name (its size). */
  describe?: (file: File) => string
  id?: string
  name?: string
  accept?: string
}

/**
 * A file: a drop zone that is the file input's label, so a press or a tap
 * opens the picker and a file dropped on it is taken too. The chosen file's
 * name replaces the prompt.
 */
export function FileInput({
  label,
  optional,
  help,
  error,
  file,
  onChange,
  choose,
  hint,
  describe,
  id,
  name,
  accept,
}: FileInputProps): JSX.Element {
  const [over, setOver] = useState(false)
  const drop = (event: DragEvent): void => {
    event.preventDefault()
    setOver(false)
    const dropped = event.dataTransfer.files[0]
    if (dropped != null) onChange(dropped)
  }
  return (
    <FieldFrame
      label={label}
      optional={optional ?? false}
      help={help}
      error={error}
      id={id}
      labelFor={false}
    >
      {(described) => (
        <label
          className={cx('m-dropzone', over && 'm-dropzone--over')}
          htmlFor={described.id}
          aria-invalid={described.invalid || undefined}
          onDragOver={(event) => {
            event.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={drop}
        >
          <Icon name={file == null ? 'upload' : 'key'} />
          {file == null ? (
            <span>
              <span className="m-dropzone__choose">{choose}</span> or drop it
              here
            </span>
          ) : (
            <span>
              <strong className="m-t-mono">{file.name}</strong>
              {describe != null && ` · ${describe(file)}`}
              <br />
              <span className="m-dropzone__choose">Choose another file</span>
            </span>
          )}
          {hint != null && (
            <span className="m-t-subhead m-secondary">{hint}</span>
          )}
          <input
            id={described.id}
            name={name}
            className="m-vh"
            type="file"
            accept={accept}
            aria-labelledby={`${described.id}-label`}
            aria-describedby={described.describedBy}
            aria-invalid={described.invalid || undefined}
            onChange={(event) => onChange(event.currentTarget.files?.[0])}
          />
        </label>
      )}
    </FieldFrame>
  )
}

export interface SelectInputProps extends Frame {
  value: string
  onChange: (value: string) => void
  /** The choices: a value and its words, or a plain value shown as itself. */
  options: ReadonlyArray<string | { value: string; label: string }>
  id?: string
  name?: string
  mono?: boolean
  required?: boolean
  disabled?: boolean
}

/** One option of 4–15 (DESIGN-LANGUAGE.md §10), with its label, help and error. */
export function SelectInput({
  label,
  optional,
  help,
  error,
  value,
  onChange,
  options,
  id,
  name,
  mono = false,
  required = false,
  disabled = false,
}: SelectInputProps): JSX.Element {
  return (
    <FieldFrame
      label={label}
      optional={optional ?? false}
      help={help}
      error={error}
      id={id}
    >
      {(described) => (
        <select
          id={described.id}
          name={name}
          className={cx('m-select', mono && 'm-input--mono')}
          value={value}
          required={required}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
          aria-invalid={described.invalid || undefined}
          aria-describedby={described.describedBy}
        >
          {options.map((option) => {
            const entry =
              typeof option === 'string'
                ? { value: option, label: option }
                : option
            return (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            )
          })}
        </select>
      )}
    </FieldFrame>
  )
}

export interface TextAreaInputProps extends Frame {
  value: string
  onChange: (value: string) => void
  id?: string
  name?: string
  mono?: boolean
  rows?: number
  placeholder?: string
  required?: boolean
  maxLength?: number
}

/** Several lines: a private key, a list of packages. */
export function TextAreaInput({
  label,
  optional,
  help,
  error,
  value,
  onChange,
  id,
  name,
  mono = false,
  rows,
  placeholder,
  required = false,
  maxLength,
}: TextAreaInputProps): JSX.Element {
  return (
    <FieldFrame
      label={label}
      optional={optional ?? false}
      help={help}
      error={error}
      id={id}
    >
      {(described) => (
        <textarea
          id={described.id}
          name={name}
          className={cx('m-textarea', mono && 'm-textarea--mono')}
          value={value}
          rows={rows}
          placeholder={placeholder}
          required={required}
          maxLength={maxLength}
          spellCheck={mono ? false : undefined}
          onChange={(event) => onChange(event.currentTarget.value)}
          aria-invalid={described.invalid || undefined}
          aria-describedby={described.describedBy}
        />
      )}
    </FieldFrame>
  )
}

export interface CheckboxInputProps {
  label: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  /** Below the box: what checking it does. */
  help?: ReactNode
  name?: string
  disabled?: boolean
}

/** An option submitted with a form (a setting that applies at once is a toggle). */
export function CheckboxInput({
  label,
  checked,
  onChange,
  help,
  name,
  disabled = false,
}: CheckboxInputProps): JSX.Element {
  const helpId = useId()
  return (
    <div className="m-field">
      <label className="m-check">
        <input
          type="checkbox"
          name={name}
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
          aria-describedby={help == null ? undefined : helpId}
        />
        <span>{label}</span>
      </label>
      {help != null && (
        <p className="m-field__help" id={helpId}>
          {help}
        </p>
      )}
    </div>
  )
}

export interface StepperInputProps extends Frame {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  /** What one step is of, for the buttons' names: "slots" → "Fewer slots". */
  unit: string
  id?: string
  name?: string
}

/** A small integer range (slots, machines): − and + around the number. */
export function StepperInput({
  label,
  optional,
  help,
  error,
  value,
  onChange,
  min,
  max,
  unit,
  id,
  name,
}: StepperInputProps): JSX.Element {
  const [text, setText] = useState<string | undefined>(undefined)
  const clamp = (n: number): number => Math.min(max, Math.max(min, n))
  return (
    <FieldFrame
      label={label}
      optional={optional ?? false}
      help={help}
      error={error}
      id={id}
    >
      {(described) => (
        <div className="m-stepper" role="group" aria-label={String(unit)}>
          <button
            type="button"
            aria-label={`Fewer ${unit}`}
            disabled={value <= min}
            onClick={() => onChange(clamp(value - 1))}
          >
            −
          </button>
          <input
            id={described.id}
            name={name}
            inputMode="numeric"
            value={text ?? String(value)}
            aria-invalid={described.invalid || undefined}
            aria-describedby={described.describedBy}
            onChange={(event) => {
              const typed = event.currentTarget.value
              setText(typed)
              if (/^\d+$/.test(typed)) onChange(clamp(Number(typed)))
            }}
            onBlur={() => setText(undefined)}
          />
          <button
            type="button"
            aria-label={`More ${unit}`}
            disabled={value >= max}
            onClick={() => onChange(clamp(value + 1))}
          >
            +
          </button>
        </div>
      )}
    </FieldFrame>
  )
}

/** A form's own failure, under its fields: what the node said, announced; focus moves to it. */
export const FormError = forwardRef<
  HTMLParagraphElement,
  { children: ReactNode }
>(function FormError({ children }, ref): JSX.Element {
  return (
    <p className="m-field__error" role="alert" tabIndex={-1} ref={ref}>
      <Icon name="error" />
      <span>{children}</span>
    </p>
  )
})
