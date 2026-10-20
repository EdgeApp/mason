/** Derive an existing TeamStation account's canonical 128-bit Base58 subject. */
export function teamStationSubjectOf(decimal: string): string {
  if (
    typeof decimal !== 'string' ||
    decimal.trim() !== decimal ||
    !/^[1-9][0-9]*$/.test(decimal)
  )
    throw new Error('Expected a positive decimal TeamStation subject')
  let value = BigInt(decimal)
  if (value > 9007199254740991n)
    throw new Error('TeamStation legacy subject exceeds the safe integer range')
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let encoded = ''
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)]! + encoded
    value /= 58n
  }
  return `usr_${encoded.padStart(22, '1')}`
}
