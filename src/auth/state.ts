import { Buffer } from 'node:buffer'

export const OAUTH_STATE_VERSION = 1 as const

const MAX_STATE_BYTES = 32 * 1024
const MAX_CREDENTIAL_BYTES = 16 * 1024
const MAX_EXPIRY_BYTES = 32

export interface OAuthState {
  readonly version: typeof OAUTH_STATE_VERSION
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: string
}

function invalidState(): never {
  throw new Error('Invalid OPENAI_CODEX_OAUTH state')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const STATE_KEYS = ['version', 'accessToken', 'refreshToken', 'expiresAt'] as const

function isExactStateRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return false

  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== STATE_KEYS.length || !STATE_KEYS.every(key => ownKeys.includes(key))) return false

  return STATE_KEYS.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && 'value' in descriptor
  })
}

function isWithinUtf8ByteLimit(value: unknown, limit: number): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= limit
}

const CANONICAL_EXPIRY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function isValidExpiry(value: unknown): value is string {
  if (!isWithinUtf8ByteLimit(value, MAX_EXPIRY_BYTES) || !CANONICAL_EXPIRY.test(value)) return false

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function isValidOAuthState(value: unknown): value is OAuthState {
  return (
    isExactStateRecord(value)
    && value.version === OAUTH_STATE_VERSION
    && isWithinUtf8ByteLimit(value.accessToken, MAX_CREDENTIAL_BYTES)
    && value.accessToken.trim() !== ''
    && isWithinUtf8ByteLimit(value.refreshToken, MAX_CREDENTIAL_BYTES)
    && value.refreshToken.trim() !== ''
    && isValidExpiry(value.expiresAt)
  )
}

export function serializeOAuthState(state: OAuthState): string {
  if (!isValidOAuthState(state)) return invalidState()

  const serialized = JSON.stringify({
    version: state.version,
    accessToken: state.accessToken,
    refreshToken: state.refreshToken,
    expiresAt: state.expiresAt,
  })

  if (!isWithinUtf8ByteLimit(serialized, MAX_STATE_BYTES)) return invalidState()
  return serialized
}

export function parseOAuthState(value: string): OAuthState {
  if (!isWithinUtf8ByteLimit(value, MAX_STATE_BYTES)) return invalidState()

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return invalidState()
  }

  if (!isValidOAuthState(parsed)) return invalidState()

  return {
    version: parsed.version,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresAt: parsed.expiresAt,
  }
}
