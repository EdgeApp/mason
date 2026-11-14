import { Button as LibraryButton } from '@ios27_design_system/react'
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react'
import { Link } from 'react-router'
import { cx } from './cx.js'
import { Icon } from './Icon.js'
import type { IconName } from './icons.js'

/** Mason's button hierarchy (DESIGN-LANGUAGE.md §10). */
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'tinted'
  | 'plain'
  | 'danger'
  | 'danger-filled'

interface Look {
  variant?: ButtonVariant
  size?: 'sm' | 'lg'
  icon?: IconName
  /** Shows only the icon; `label` names it and the children are ignored. */
  iconOnly?: boolean
  /** The accessible name of an icon-only button, also its tooltip. */
  label?: string
}

/** The classes of a button or a link styled as one. */
export function buttonClass({
  variant = 'secondary',
  size,
  iconOnly = false,
  busy = false,
  className,
}: Look & { busy?: boolean; className?: string | undefined }): string {
  return cx(
    'm-btn',
    `m-btn--${variant}`,
    size != null && `m-btn--${size}`,
    iconOnly && 'm-btn--icon',
    busy && 'm-btn--busy',
    className,
  )
}

export interface ButtonProps
  extends Look,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** A request is under way: the label hides behind a spinner and the button keeps its width. */
  busy?: boolean
  children?: ReactNode
}

/**
 * A button: the iOS 27 library's, for its behaviour, with Mason's variant
 * classes. A busy button refuses presses without losing focus.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant,
      size,
      icon,
      iconOnly = false,
      label,
      busy = false,
      className,
      children,
      onClick,
      ...rest
    },
    ref,
  ): JSX.Element {
    return (
      <LibraryButton
        {...rest}
        ref={ref}
        variant="plain"
        className={buttonClass({ variant, size, iconOnly, busy, className })}
        aria-label={iconOnly ? label : rest['aria-label']}
        title={iconOnly ? label : rest.title}
        aria-busy={busy || undefined}
        aria-disabled={busy || rest['aria-disabled']}
        onClick={(event) => {
          if (busy) {
            event.preventDefault()
            return
          }
          onClick?.(event)
        }}
      >
        {icon != null && <Icon name={icon} />}
        {iconOnly ? null : children}
      </LibraryButton>
    )
  },
)

export interface ButtonLinkProps extends Look {
  to: string
  children?: ReactNode
  /** A full document load: a page the node serves, or a password page (`PASSWORD_PATHS`). */
  reloadDocument?: boolean
  className?: string
}

/** A link that looks like a button: for an action that is a navigation. */
export function ButtonLink({
  to,
  variant,
  size,
  icon,
  iconOnly = false,
  label,
  reloadDocument = false,
  className,
  children,
}: ButtonLinkProps): JSX.Element {
  return (
    <Link
      to={to}
      reloadDocument={reloadDocument}
      className={buttonClass({ variant, size, iconOnly, className })}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
    >
      {icon != null && <Icon name={icon} />}
      {iconOnly ? null : children}
    </Link>
  )
}
