import { asArray, asBoolean, asObject, asOptional, asString } from 'cleaners'
import { asHttps, object, oneOf, text, type Cleaner } from '../validation.js'

export const asProviderId: Cleaner<string> = (value) => {
  const id = text(64)(value)
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Invalid provider ID')
  return id
}
const asSwitchParameters: Cleaner<Record<string, string>> = (value) => {
  if (
    value == null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > 8
  )
    throw new Error('Invalid account switching parameters')
  const out: Record<string, string> = {}
  const reserved = new Set([
    '__proto__',
    'constructor',
    'prototype',
    'client_id',
    'redirect_uri',
    'response_type',
    'response_mode',
    'scope',
    'state',
    'nonce',
    'code_challenge',
    'code_challenge_method',
    'request',
    'request_uri',
  ])
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || reserved.has(key))
      throw new Error('Reserved authorization parameter')
    out[key] = text(256)(item)
  }
  if (Object.keys(out).length === 0)
    throw new Error('Empty account switching parameters')
  return out
}
const common = {
  id: asProviderId,
  name: text(80),
  issuer: asHttps,
  clientId: text(256),
  clientSecret: text(4096),
  authentication: asOptional(oneOf(['post', 'basic'] as const), 'post'),
  switchParameters: asOptional(asSwitchParameters),
}
const asOidc = object({
  ...common,
  type: oneOf(['oidc'] as const),
  signingAlgorithm: asOptional(
    oneOf(['RS256', 'ES256', 'EdDSA'] as const),
    'RS256',
  ),
})
const asOauth = object({
  ...common,
  type: oneOf(['oauth2'] as const),
  authorizationEndpoint: asHttps,
  tokenEndpoint: asHttps,
  userinfoEndpoint: asHttps,
  scopes: asArray(text(80)),
  claims: object({
    subject: text(80),
    name: asOptional(text(80)),
    email: asOptional(text(80)),
    emailVerified: asOptional(text(80)),
  }),
})
export type ProviderConfig =
  | ReturnType<typeof asOidc>
  | ReturnType<typeof asOauth>
export const asProvider: Cleaner<ProviderConfig> = (value) => {
  const { type } = asObject({ type: asString })(value)
  return type === 'oidc' ? asOidc(value) : asOauth(value)
}
export const asProviders: Cleaner<ProviderConfig[]> = (value) => {
  const providers = asArray(asProvider)(value)
  if (
    providers.length > 20 ||
    new Set(providers.map((provider) => provider.id)).size !== providers.length
  )
    throw new Error('Duplicate or too many providers')
  return providers
}
export const asEmail: Cleaner<string> = (value) => {
  const email = text(254)(value).trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error('Invalid email')
  return email
}
export const asIdentity = object({
  provider: asProviderId,
  issuer: asHttps,
  subject: text(256),
  name: text(120),
  email: asOptional(asEmail),
  emailVerified: asBoolean,
})
export type Identity = ReturnType<typeof asIdentity>
