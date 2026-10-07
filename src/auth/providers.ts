import { asBoolean, asObject, asOptional, asString } from 'cleaners'
import * as oidc from 'openid-client'
import { asHttps, text } from '../validation.js'
import {
  asEmail,
  asIdentity,
  type Identity,
  type ProviderConfig,
} from './providerConfig.js'

/** Bounds discovery, token, JWKS and user-info responses without weakening TLS. */
export function boundedFetch(transport: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    asHttps(url)
    const response = await transport(input, {
      ...init,
      redirect: 'error',
      signal:
        init?.signal == null
          ? AbortSignal.timeout(10000)
          : AbortSignal.any([init.signal, AbortSignal.timeout(10000)]),
    })
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    if (reader != null) {
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.length
          if (size > 256 * 1024) throw new Error('Provider response too large')
          chunks.push(chunk.value)
        }
      } finally {
        await reader.cancel()
      }
    }
    return new Response(
      response.status === 204 ? null : Buffer.concat(chunks),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    )
  }
}
export function claim(value: unknown, key: string | undefined): unknown {
  if (key == null) return undefined
  let node = value
  for (const part of key.split('.')) {
    if (
      ['__proto__', 'constructor', 'prototype'].includes(part) ||
      node == null ||
      typeof node !== 'object' ||
      !Object.hasOwn(node, part)
    )
      return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}
export interface OAuthProof {
  state: string
  verifier: string
  nonce: string
}
export class Providers {
  private readonly configurations = new Map<
    string,
    Promise<oidc.Configuration>
  >()
  private readonly transport: typeof fetch
  constructor(
    readonly origin: string,
    readonly providers: ProviderConfig[],
    transport: typeof fetch = fetch,
  ) {
    this.transport = boundedFetch(transport)
  }
  provider(id: string): ProviderConfig {
    const provider = this.providers.find((item) => item.id === id)
    if (provider == null) throw new Error('Unknown provider')
    return provider
  }
  redirectUri(id: string): string {
    return this.origin + '/auth/callback/' + this.provider(id).id
  }
  private configuration(provider: ProviderConfig): Promise<oidc.Configuration> {
    const cached = this.configurations.get(provider.id)
    if (cached != null) return cached
    const customFetch: oidc.CustomFetch = async (url, options) =>
      await this.transport(url, {
        ...options,
        body:
          options.body instanceof Uint8Array
            ? new Uint8Array(options.body)
            : options.body,
      })
    const auth =
      provider.authentication === 'basic'
        ? oidc.ClientSecretBasic(provider.clientSecret)
        : oidc.ClientSecretPost(provider.clientSecret)
    const pending = (async (): Promise<oidc.Configuration> => {
      let config: oidc.Configuration
      if (provider.type === 'oidc') {
        config = await oidc.discovery(
          new URL(provider.issuer),
          provider.clientId,
          { id_token_signed_response_alg: provider.signingAlgorithm },
          auth,
          { [oidc.customFetch]: customFetch, timeout: 10 },
        )
        oidc.enableNonRepudiationChecks(config)
      } else {
        config = new oidc.Configuration(
          {
            issuer: provider.issuer,
            authorization_endpoint: provider.authorizationEndpoint,
            token_endpoint: provider.tokenEndpoint,
            userinfo_endpoint: provider.userinfoEndpoint,
            code_challenge_methods_supported: ['S256'],
          },
          provider.clientId,
          undefined,
          auth,
        )
        config[oidc.customFetch] = customFetch
        config.timeout = 10
      }
      const metadata = config.serverMetadata()
      asHttps(metadata.authorization_endpoint)
      asHttps(metadata.token_endpoint)
      if (provider.type === 'oidc') asHttps(metadata.jwks_uri)
      if (metadata.userinfo_endpoint != null)
        asHttps(metadata.userinfo_endpoint)
      return config
    })()
    this.configurations.set(provider.id, pending)
    void pending.catch(() => {
      this.configurations.delete(provider.id)
    })
    return pending
  }
  async authorize(
    id: string,
    proof: OAuthProof,
    switchAccount = false,
  ): Promise<string> {
    const provider = this.provider(id)
    const config = await this.configuration(provider)
    const parameters = !switchAccount
      ? {}
      : (provider.switchParameters ??
        (provider.type === 'oidc' ? { prompt: 'login' } : undefined))
    if (parameters == null)
      throw new Error('This provider needs account switching configuration')
    return oidc.buildAuthorizationUrl(config, {
      ...parameters,
      redirect_uri: this.redirectUri(id),
      scope:
        provider.type === 'oidc'
          ? 'openid profile email'
          : provider.scopes.join(' '),
      state: proof.state,
      nonce: proof.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(proof.verifier),
      code_challenge_method: 'S256',
    }).href
  }
  async identity(
    id: string,
    callback: URL,
    proof: OAuthProof,
  ): Promise<Identity> {
    const provider = this.provider(id)
    const config = await this.configuration(provider)
    if (callback.origin + callback.pathname !== this.redirectUri(id))
      throw new Error('Invalid callback address')
    const tokens = await oidc.authorizationCodeGrant(config, callback, {
      expectedState: proof.state,
      pkceCodeVerifier: proof.verifier,
      ...(provider.type === 'oidc'
        ? { expectedNonce: proof.nonce, idTokenExpected: true }
        : {}),
    })
    if (provider.type === 'oidc') {
      const subject = text(256)(tokens.claims()?.sub)
      const claims =
        config.serverMetadata().userinfo_endpoint == null
          ? tokens.claims()
          : await oidc.fetchUserInfo(config, tokens.access_token, subject)
      const data = asObject({
        sub: text(256),
        name: asOptional(text(120)),
        email: asOptional(asEmail),
        email_verified: asOptional(asBoolean, false),
      })(claims)
      return asIdentity({
        provider: id,
        issuer: provider.issuer,
        subject: data.sub,
        name: data.name ?? 'Account',
        email: data.email,
        emailVerified: data.email_verified,
      })
    }
    const response = await this.transport(provider.userinfoEndpoint, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    if (!response.ok) throw new Error('Provider identity unavailable')
    const data: unknown = await response.json()
    const subject = claim(data, provider.claims.subject)
    return asIdentity({
      provider: id,
      issuer: provider.issuer,
      subject:
        typeof subject === 'number' && Number.isSafeInteger(subject)
          ? String(subject)
          : asString(subject),
      name:
        asOptional(text(120))(claim(data, provider.claims.name)) ?? 'Account',
      email: asOptional(asEmail)(claim(data, provider.claims.email)),
      emailVerified: asOptional(
        asBoolean,
        false,
      )(claim(data, provider.claims.emailVerified)),
    })
  }
}
