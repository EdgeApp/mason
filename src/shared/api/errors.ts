import { asNumber, asObject, asOptional, asString } from 'cleaners'

/**
 * What every route answers on an error: a message, and for a locked sign-in
 * or setup when to try again (ms since the epoch).
 */
export interface ErrorBody {
  error: string
  retryAt?: number
}

export const asErrorBody = asObject<ErrorBody>({
  error: asString,
  retryAt: asOptional(asNumber),
})
