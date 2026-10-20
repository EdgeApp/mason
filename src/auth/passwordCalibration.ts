import {
  asClientHash,
  asNewPasswordParameters,
  clientParameters,
  type ClientPasswordCosts,
  DEFAULT_PASSWORD_COSTS,
  MAX_CLIENT_PASSWORD_ITERATIONS,
  type PasswordKdf,
} from './passwordProtocol.js'

// Hermes supplies this monotonic timer, but React Native's types omit it.
declare const performance: { now: () => number }

export const PASSWORD_HASH_TARGET_MS = 3000
const calibrationSalt = '000102030405060708090a0b0c0d0e0f'

export interface PasswordCalibration {
  baselineMs: number
  costs: ClientPasswordCosts
}

/** One public-input sample; never uses or retains a person's password. */
export async function calibratePasswordCosts(
  derive: PasswordKdf,
  baseline: ClientPasswordCosts = DEFAULT_PASSWORD_COSTS,
  targetMs = PASSWORD_HASH_TARGET_MS,
  now: () => number = () => performance.now(),
): Promise<PasswordCalibration> {
  const parameters = asNewPasswordParameters(
    clientParameters(calibrationSalt, baseline),
  )
  if (!Number.isFinite(targetMs) || targetMs <= 0)
    throw new Error('Password hashing target must be a positive duration')
  const start = now()
  asClientHash(await derive('Public password calibration sample', parameters))
  const baselineMs = now() - start
  if (!Number.isFinite(baselineMs) || baselineMs <= 0)
    throw new Error('Could not measure password preparation. Please retry')
  return {
    baselineMs,
    costs: {
      memoryKiB: parameters.memoryKiB,
      parallelism: parameters.parallelism,
      iterations: Math.min(
        MAX_CLIENT_PASSWORD_ITERATIONS,
        Math.max(
          parameters.iterations,
          Math.ceil((parameters.iterations * targetMs) / baselineMs),
        ),
      ),
    },
  }
}
