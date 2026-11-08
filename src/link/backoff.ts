/**
 * Jittered exponential backoff: the wait before retry `attempt` (1 for the
 * first), doubling from `base` up to `max`, within a quarter either way.
 */
export function backoffDelay(
  attempt: number,
  base = 1000,
  max = 60_000,
): number {
  const raw = Math.min(max, base * 2 ** Math.max(0, attempt - 1))
  return Math.min(max, Math.round(raw * (0.75 + Math.random() * 0.5)))
}
