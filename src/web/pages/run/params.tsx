// A workflow's or an approval's parameters as form fields, typed as the
// Masonfile declares them (types/mason ParamSpec): a choice is a select, a
// boolean a false/true select, a number a decimal field within its limits,
// text a multi-line field and a string one line matching its pattern. What
// a field holds becomes the value the API checks: a number, a boolean or
// text; an empty field leaves its default to the master.
import { useId, type JSX } from 'react'
import type { ParamSpec } from '../../../shared/api/index.js'
import { Icon } from '../../ui/Icon.js'
import { TextInput } from '../../ui/Field.js'

/** Each parameter's text as its field holds it. */
export type ParamTexts = Record<string, string>

/** Fields that start at each parameter's default. */
export function paramDefaults(specs: Record<string, ParamSpec>): ParamTexts {
  return Object.fromEntries(
    Object.entries(specs).map(([name, spec]) => [
      name,
      spec.default === undefined || spec.default === null
        ? spec.type === 'boolean'
          ? 'false'
          : spec.type === 'choice'
            ? (spec.choices?.[0] ?? '')
            : ''
        : String(spec.default),
    ]),
  )
}

/**
 * The parameters to send, typed, and what is wrong with any field. A
 * field left empty is left out when the parameter has a default, and is
 * missing otherwise.
 */
export function typedParams(
  specs: Record<string, ParamSpec>,
  texts: ParamTexts,
): { params: Record<string, string | number | boolean>; errors: ParamTexts } {
  const params: Record<string, string | number | boolean> = {}
  const errors: ParamTexts = {}
  for (const [name, spec] of Object.entries(specs)) {
    const text = texts[name] ?? ''
    const blank = text.trim() === ''
    if (blank && spec.type !== 'text' && spec.type !== 'string') {
      if (spec.default === undefined) errors[name] = 'Enter a value.'
      continue
    }
    if (spec.type === 'boolean') params[name] = text === 'true'
    else if (spec.type === 'number') {
      const value = Number(text.trim())
      if (!Number.isFinite(value)) errors[name] = 'Enter a number.'
      else if (spec.min != null && value < spec.min)
        errors[name] = `Enter at least ${spec.min}.`
      else if (spec.max != null && value > spec.max)
        errors[name] = `Enter at most ${spec.max}.`
      else params[name] = value
    } else if (spec.type === 'choice') {
      if (spec.choices != null && !spec.choices.includes(text))
        errors[name] = `Choose one of ${spec.choices.join(', ')}.`
      else params[name] = text
    } else {
      if (text === '' && spec.default !== undefined) continue
      if (spec.type === 'string' && text.includes('\n'))
        errors[name] = 'Enter one line.'
      else if (
        spec.type === 'string' &&
        spec.pattern != null &&
        !safeTest(spec.pattern, text)
      )
        errors[name] = `Enter text that matches ${spec.pattern}.`
      else params[name] = text
    }
  }
  return { params, errors }
}

/** Whether a pattern matches; a pattern the browser cannot read is left to the master. */
function safeTest(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern).test(text)
  } catch {
    return true
  }
}

/** A select in a field's frame: label, control, help and error. */
function SelectField({
  label,
  value,
  options,
  help,
  error,
  onChange,
}: {
  label: string
  value: string
  options: string[]
  help?: string | undefined
  error?: string | undefined
  onChange: (value: string) => void
}): JSX.Element {
  const id = useId()
  const described =
    [help != null && `${id}-help`, error != null && `${id}-error`]
      .filter(Boolean)
      .join(' ') || undefined
  return (
    <div className="m-field">
      <label className="m-field__label m-t-mono" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="m-select"
        value={value}
        aria-describedby={described}
        aria-invalid={error != null || undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      {help != null && (
        <p className="m-field__help" id={`${id}-help`}>
          {help}
        </p>
      )}
      {error != null && (
        <p className="m-field__error" id={`${id}-error`} role="alert">
          <Icon name="error" />
          {error}
        </p>
      )}
    </div>
  )
}

/** A multi-line text parameter. */
function TextAreaField({
  label,
  value,
  help,
  error,
  onChange,
}: {
  label: string
  value: string
  help?: string | undefined
  error?: string | undefined
  onChange: (value: string) => void
}): JSX.Element {
  const id = useId()
  return (
    <div className="m-field">
      <label className="m-field__label m-t-mono" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="m-textarea"
        rows={3}
        value={value}
        aria-describedby={help == null ? undefined : `${id}-help`}
        aria-invalid={error != null || undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {help != null && (
        <p className="m-field__help" id={`${id}-help`}>
          {help}
        </p>
      )}
      {error != null && (
        <p className="m-field__error" role="alert">
          <Icon name="error" />
          {error}
        </p>
      )}
    </div>
  )
}

/** The help under a parameter: its description, and its limits or pattern. */
function helpFor(spec: ParamSpec): string | undefined {
  const limits =
    spec.type === 'number' && (spec.min != null || spec.max != null)
      ? spec.min != null && spec.max != null
        ? `From ${spec.min} to ${spec.max}.`
        : spec.min != null
          ? `At least ${spec.min}.`
          : `At most ${spec.max}.`
      : spec.type === 'string' && spec.pattern != null
        ? `Matches ${spec.pattern}.`
        : undefined
  const parts = [spec.description, limits].filter(
    (part): part is string => part != null && part !== '',
  )
  return parts.length === 0 ? undefined : parts.join(' ')
}

/** One field per parameter. */
export function ParamFields({
  specs,
  values,
  errors = {},
  onChange,
}: {
  specs: Record<string, ParamSpec>
  values: ParamTexts
  errors?: ParamTexts
  onChange: (name: string, value: string) => void
}): JSX.Element {
  return (
    <>
      {Object.entries(specs).map(([name, spec]) => {
        const value = values[name] ?? ''
        const help = helpFor(spec)
        const error = errors[name]
        const set = (next: string): void => onChange(name, next)
        if (spec.type === 'choice' || spec.type === 'boolean')
          return (
            <SelectField
              key={name}
              label={name}
              value={value}
              options={
                spec.type === 'boolean'
                  ? ['false', 'true']
                  : (spec.choices ?? [])
              }
              help={help}
              error={error}
              onChange={set}
            />
          )
        if (spec.type === 'text')
          return (
            <TextAreaField
              key={name}
              label={name}
              value={value}
              help={help}
              error={error}
              onChange={set}
            />
          )
        return (
          <TextInput
            key={name}
            label={<span className="m-t-mono">{name}</span>}
            value={value}
            onChange={set}
            help={help}
            error={error}
            mono={spec.type === 'number'}
            verbatim
            {...(spec.type === 'number' ? { inputMode: 'decimal' } : {})}
          />
        )
      })}
    </>
  )
}
