import type { HTMLAttributes, JSX } from 'react'
import { useSlidingThumb } from '../hooks/useSlidingThumb.js'

/** A slider pill's track: its options' chosen one sits on a thumb that slides and drags. */
export function SliderTrack(
  props: HTMLAttributes<HTMLDivElement>,
): JSX.Element {
  const track = useSlidingThumb<HTMLDivElement>()
  return <div ref={track} {...props} />
}
