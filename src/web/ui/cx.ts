/** Joins class names, skipping the empty and the false. */
export const cx = (
  ...names: Array<string | false | null | undefined>
): string =>
  names
    .filter((name) => name != null && name !== false && name !== '')
    .join(' ')
