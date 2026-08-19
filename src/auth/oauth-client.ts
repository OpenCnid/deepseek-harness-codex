import { createHash, randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { readBoundedJson } from '../bounded-json.js'
import { OAuthTerminalRefreshError } from './session-store.js'
import { OAUTH_STATE_VERSION, type OAuthState } from './state.js'

const MAX_CLIENT_ID_BYTES = 512
const MAX_SCOPE_COUNT = 32
const MAX_SCOPE_BYTES = 256
const MAX_CALLBACK_CODE_BYTES = 16 * 1024
const MAX_DEVICE_CODE_BYTES = 16 * 1024
const MAX_USER_CODE_BYTES = 512
const MAX_TOKEN_BYTES = 16 * 1024
const MAX_EXPIRES_SECONDS = 31 * 24 * 60 * 60
const DEFAULT_DEVICE_POLL_MS = 5_000
const MAX_DEVICE_POLL_MS = 60_000
const BASE64URL = /^[A-Za-z0-9_-]+$/

export interface AuthorizedOpenAiCodexOAuthConfig {
  authorizationEndpoint: string
  tokenEndpoint: string
  deviceAuthorizationEndpoint: string
  responsesUrl: string
  clientId: string
  redirectUri: string
  scopes: readonly string[]
  fetch?: typeof fetch
  now?: () => Date
}

export interface OpenAiCodexBrowserLogin {
  readonly authorizationUrl: string
  complete(callbackUrl: string): Promise<OAuthState>
}

export type OpenAiCodexDevicePollResult =
  | { kind: 'pending'; retryAfterMs: number }
  | { kind: 'complete'; session: OAuthState }

export interface OpenAiCodexDeviceLogin {
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete?: string
  readonly expiresAt: string
  poll(): Promise<OpenAiCodexDevicePollResult>
}

export interface OpenAiCodexResponsesTransportConfig {
  readonly url: string
  readonly fetch: typeof fetch
}

export interface OpenAiCodexOAuthClient {
  readonly responsesUrl: string
  readonly responsesTransport: OpenAiCodexResponsesTransportConfig
  startBrowserLogin(): OpenAiCodexBrowserLogin
  startDeviceLogin(): Promise<OpenAiCodexDeviceLogin>
  refresh(session: OAuthState): Promise<OAuthState>
}

interface NormalizedConfig {
  authorizationEndpoint: URL
  tokenEndpoint: URL
  deviceAuthorizationEndpoint: URL
  responsesUrl: string
  clientId: string
  redirectUri: URL
  scopes: readonly string[]
  fetcher: typeof fetch
  now: () => Date
}

function invalidConfiguration(): never {
  throw new Error('OpenAI Codex OAuth configuration is invalid')
}

function browserAuthorizationInvalid(): never {
  throw new Error('OpenAI Codex browser authorization could not be verified')
}

function tokenExchangeFailed(): never {
  throw new Error('OpenAI Codex OAuth token exchange failed')
}

function deviceAuthorizationFailed(): never {
  throw new Error('OpenAI Codex device authorization requires re-login')
}

function validText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes
}

function secureHttpsUrl(value: unknown): URL {
  if (!validText(value, 8 * 1024)) return invalidConfiguration()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return invalidConfiguration()
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') return invalidConfiguration()
  return url
}

function redirectUrl(value: unknown): URL {
  if (!validText(value, 8 * 1024)) return invalidConfiguration()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return invalidConfiguration()
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username !== '' || url.password !== '' || url.hash !== '') {
    return invalidConfiguration()
  }
  return url
}

function scopes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_COUNT) return invalidConfiguration()
  const result: string[] = []
  const seen = new Set<string>()
  for (const scope of value) {
    if (!validText(scope, MAX_SCOPE_BYTES) || /\s/.test(scope) || seen.has(scope)) return invalidConfiguration()
    seen.add(scope)
    result.push(scope)
  }
  return Object.freeze(result)
}

function currentTime(now: () => Date): Date {
  const value = now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return invalidConfiguration()
  return value
}

function normalizeConfig(value: AuthorizedOpenAiCodexOAuthConfig): NormalizedConfig {
  if (value === null || typeof value !== 'object') return invalidConfiguration()
  if (!validText(value.clientId, MAX_CLIENT_ID_BYTES) || /\s/.test(value.clientId)) return invalidConfiguration()
  if (value.fetch !== undefined && typeof value.fetch !== 'function') return invalidConfiguration()
  if (value.now !== undefined && typeof value.now !== 'function') return invalidConfiguration()
  const authorizationEndpoint = secureHttpsUrl(value.authorizationEndpoint)
  const tokenEndpoint = secureHttpsUrl(value.tokenEndpoint)
  const deviceAuthorizationEndpoint = secureHttpsUrl(value.deviceAuthorizationEndpoint)
  const responsesUrl = secureHttpsUrl(value.responsesUrl).toString()
  return {
    authorizationEndpoint,
    tokenEndpoint,
    deviceAuthorizationEndpoint,
    responsesUrl,
    clientId: value.clientId,
    redirectUri: redirectUrl(value.redirectUri),
    scopes: scopes(value.scopes),
    fetcher: value.fetch ?? fetch,
    now: value.now ?? (() => new Date()),
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function seconds(value: unknown, fallback?: number): number | undefined {
  const resolved = value === undefined ? fallback : value
  return typeof resolved === 'number' && Number.isSafeInteger(resolved) && resolved > 0 && resolved <= MAX_EXPIRES_SECONDS ? resolved : undefined
}

function newExpiry(now: Date, lifetimeSeconds: number): string {
  const expiresAt = now.getTime() + lifetimeSeconds * 1000
  if (!Number.isSafeInteger(expiresAt) || !Number.isFinite(expiresAt)) return tokenExchangeFailed()
  return new Date(expiresAt).toISOString()
}

function sessionFromToken(value: unknown, now: Date, fallbackRefreshToken?: string): OAuthState {
  const token = object(value)
  const accessToken = token?.access_token
  const refreshToken = token?.refresh_token === undefined ? fallbackRefreshToken : token?.refresh_token
  const expiresIn = seconds(token?.expires_in)
  if (!validText(accessToken, MAX_TOKEN_BYTES) || !validText(refreshToken, MAX_TOKEN_BYTES) || expiresIn === undefined) return tokenExchangeFailed()
  return {
    version: OAUTH_STATE_VERSION,
    accessToken,
    refreshToken,
    expiresAt: newExpiry(now, expiresIn),
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await readBoundedJson(response)
  } catch {
    return undefined
  }
}

async function postForm(config: NormalizedConfig, endpoint: URL, body: URLSearchParams): Promise<{ ok: boolean; status: number; body: unknown }> {
  let response: Response
  try {
    response = await config.fetcher(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
  } catch {
    return tokenExchangeFailed()
  }
  const parsed = await readJson(response)
  return { ok: response.ok, status: response.status, body: parsed }
}

function opaqueValue(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

function verifierChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url')
}

function isSameRedirect(callback: URL, expected: URL): boolean {
  if (callback.protocol !== expected.protocol || callback.hostname !== expected.hostname || callback.port !== expected.port || callback.pathname !== expected.pathname) {
    return false
  }
  for (const [key, value] of expected.searchParams) {
    if (callback.searchParams.get(key) !== value) return false
  }
  return true
}

function deviceError(value: unknown): string | undefined {
  const record = object(value)
  return typeof record?.error === 'string' ? record.error : undefined
}

function deviceVerificationUri(value: unknown): string | undefined {
  if (!validText(value, 8 * 1024)) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

class Client implements OpenAiCodexOAuthClient {
  readonly responsesUrl: string
  readonly responsesTransport: OpenAiCodexResponsesTransportConfig

  constructor(private readonly config: NormalizedConfig) {
    this.responsesUrl = config.responsesUrl
    this.responsesTransport = Object.freeze({ url: config.responsesUrl, fetch: config.fetcher })
  }

  startBrowserLogin(): OpenAiCodexBrowserLogin {
    const state = opaqueValue(32)
    const verifier = opaqueValue(48)
    const url = new URL(this.config.authorizationEndpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.config.clientId)
    url.searchParams.set('redirect_uri', this.config.redirectUri.toString())
    url.searchParams.set('scope', this.config.scopes.join(' '))
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', verifierChallenge(verifier))
    url.searchParams.set('code_challenge_method', 'S256')
    const authorizationUrl = url.toString()

    return Object.freeze({
      authorizationUrl,
      complete: async (callbackUrl: string): Promise<OAuthState> => {
        let callback: URL
        try {
          callback = new URL(callbackUrl)
        } catch {
          return browserAuthorizationInvalid()
        }
        const code = callback.searchParams.get('code')
        const returnedState = callback.searchParams.get('state')
        if (!isSameRedirect(callback, this.config.redirectUri) || !validText(code, MAX_CALLBACK_CODE_BYTES) || returnedState !== state) {
          return browserAuthorizationInvalid()
        }
        const response = await postForm(this.config, this.config.tokenEndpoint, new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.config.clientId,
          code,
          redirect_uri: this.config.redirectUri.toString(),
          code_verifier: verifier,
        }))
        if (!response.ok) return tokenExchangeFailed()
        return sessionFromToken(response.body, currentTime(this.config.now))
      },
    })
  }

  async startDeviceLogin(): Promise<OpenAiCodexDeviceLogin> {
    const response = await postForm(this.config, this.config.deviceAuthorizationEndpoint, new URLSearchParams({
      client_id: this.config.clientId,
      scope: this.config.scopes.join(' '),
    }))
    const body = object(response.body)
    const code = body?.device_code
    const userCode = body?.user_code
    const verificationUri = deviceVerificationUri(body?.verification_uri)
    const verificationUriComplete = body?.verification_uri_complete === undefined ? undefined : deviceVerificationUri(body.verification_uri_complete)
    const lifetime = seconds(body?.expires_in)
    const interval = seconds(body?.interval, DEFAULT_DEVICE_POLL_MS / 1000)
    if (!response.ok || !validText(code, MAX_DEVICE_CODE_BYTES) || !validText(userCode, MAX_USER_CODE_BYTES) || verificationUri === undefined || lifetime === undefined || interval === undefined) {
      return deviceAuthorizationFailed()
    }
    if (body?.verification_uri_complete !== undefined && verificationUriComplete === undefined) return deviceAuthorizationFailed()
    const started = currentTime(this.config.now)
    const expiresAtMs = started.getTime() + lifetime * 1000
    let retryAfterMs = Math.min(interval * 1000, MAX_DEVICE_POLL_MS)
    let completed = false

    return Object.freeze({
      userCode,
      verificationUri,
      ...verificationUriComplete === undefined ? {} : { verificationUriComplete },
      expiresAt: new Date(expiresAtMs).toISOString(),
      poll: async (): Promise<OpenAiCodexDevicePollResult> => {
        if (completed || currentTime(this.config.now).getTime() >= expiresAtMs) return deviceAuthorizationFailed()
        const next = await postForm(this.config, this.config.tokenEndpoint, new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: this.config.clientId,
          device_code: code,
        }))
        if (next.ok) {
          completed = true
          return { kind: 'complete', session: sessionFromToken(next.body, currentTime(this.config.now)) }
        }
        const error = deviceError(next.body)
        if (error === 'authorization_pending') return { kind: 'pending', retryAfterMs }
        if (error === 'slow_down') {
          retryAfterMs = Math.min(retryAfterMs + 5_000, MAX_DEVICE_POLL_MS)
          return { kind: 'pending', retryAfterMs }
        }
        return deviceAuthorizationFailed()
      },
    })
  }

  async refresh(session: OAuthState): Promise<OAuthState> {
    const response = await postForm(this.config, this.config.tokenEndpoint, new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      refresh_token: session.refreshToken,
    }))
    if (!response.ok) {
      if (response.status === 400 || response.status === 401) throw new OAuthTerminalRefreshError()
      return tokenExchangeFailed()
    }
    return sessionFromToken(response.body, currentTime(this.config.now), session.refreshToken)
  }
}

/**
 * Creates a live OAuth protocol client only from an approved, injected public
 * client/grant contract. No OpenAI endpoint, client identity, scope, redirect,
 * provider header, or credential is embedded in this package.
 */
export function createOpenAiCodexOAuthClient(config: AuthorizedOpenAiCodexOAuthConfig): OpenAiCodexOAuthClient {
  return new Client(normalizeConfig(config))
}
