import { asBoolean, asNumber, asObject, asOptional } from 'cleaners'

/** `GET /api/setup`, on the master's own listener: whether first-run setup is done. */
export const SETUP_PATH = '/api/setup'

export interface SetupStatus {
  configured: boolean
  /** While unconfigured: when the next setup code guess is checked; 0 for now. */
  waitUntil?: number
}

export const asSetupStatus = asObject<SetupStatus>({
  configured: asBoolean,
  waitUntil: asOptional(asNumber),
})
