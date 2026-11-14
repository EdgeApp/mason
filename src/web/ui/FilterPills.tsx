import type { JSX } from 'react'
import { Count } from './Badge.js'

export interface FilterOption {
  key: string
  label: string
  count: number
}

/** Narrows a collection: up to six pills with counts, one pressed. */
export function FilterPills({
  label,
  options,
  value,
  onChange,
}: {
  /** What the pills choose, for assistive tech ("Platform"). */
  label: string
  options: FilterOption[]
  value: string
  onChange: (key: string) => void
}): JSX.Element {
  return (
    <div className="m-filter" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          className="m-filter__opt"
          aria-pressed={option.key === value}
          onClick={() => onChange(option.key)}
        >
          {option.label} <Count count={option.count} />
        </button>
      ))}
    </div>
  )
}
