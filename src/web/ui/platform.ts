// The platforms Mason builds for: each keeps one name, one categorical
// colour and one glyph everywhere it appears (DESIGN-LANGUAGE.md §4, §13).
import { platformNames, type PlatformName } from '../../shared/api/index.js'
import type { IconName } from './icons.js'

export interface PlatformLook {
  name: string
  /** The categorical colour, 1–6. */
  series: number
  icon: IconName
}

const LOOKS: Record<PlatformName, PlatformLook> = {
  ios: { name: 'iOS', series: 1, icon: 'ios' },
  tvos: { name: 'tvOS', series: 2, icon: 'ios' },
  macos: { name: 'macOS', series: 3, icon: 'desktop_mac' },
  android: { name: 'Android', series: 4, icon: 'android' },
  windows: { name: 'Windows', series: 5, icon: 'desktop_windows' },
}

/** A platform's look; one Mason does not know keeps its own name, in the sixth colour. */
export function platformLook(key: string): PlatformLook {
  return (platformNames as readonly string[]).includes(key)
    ? LOOKS[key as PlatformName]
    : { name: key, series: 6, icon: 'apps' }
}
