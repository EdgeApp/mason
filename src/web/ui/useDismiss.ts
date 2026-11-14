import { useEffect, type RefObject } from 'react'

/**
 * Closes a non-modal panel (a popover, a menu) when the viewer presses
 * outside `area` or moves focus out of it.
 */
export function useDismiss(
  open: boolean,
  area: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return undefined
    const outside = (target: EventTarget | null): boolean =>
      area.current != null &&
      target instanceof Node &&
      !area.current.contains(target)
    const onPress = (event: Event): void => {
      if (outside(event.target)) close()
    }
    const onFocus = (event: FocusEvent): void => {
      if (outside(event.target)) close()
    }
    document.addEventListener('mousedown', onPress)
    document.addEventListener('focusin', onFocus)
    return (): void => {
      document.removeEventListener('mousedown', onPress)
      document.removeEventListener('focusin', onFocus)
    }
  }, [open, area, close])
}
