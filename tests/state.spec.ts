import { describe, expect, it } from 'vitest'

import { parseOAuthState, serializeOAuthState } from '../src/auth/state.js'

describe('Codex OAuth state codec', () => {
  it('round-trips one versioned opaque session in memory', () => {
    const state = {
      version: 1,
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      refreshToken: '[REDACTED_REFRESH_TOKEN]',
      expiresAt: '2030-01-01T00:00:00.000Z',
    } as const

    expect(parseOAuthState(serializeOAuthState(state))).toEqual(state)
  })

  it('rejects malformed state without echoing its value', () => {
    const malformed = '{"accessToken":"[REDACTED_ACCESS_TOKEN]"'

    expect(() => parseOAuthState(malformed)).toThrow('Invalid OPENAI_CODEX_OAUTH state')
    expect(() => parseOAuthState(malformed)).not.toThrow(malformed)
  })

  it('rejects a state without a refresh credential', () => {
    const missingRefresh = JSON.stringify({
      version: 1,
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      expiresAt: '2030-01-01T00:00:00.000Z',
    })

    expect(() => parseOAuthState(missingRefresh)).toThrow('Invalid OPENAI_CODEX_OAUTH state')
  })

  it('rejects a state with an empty access credential', () => {
    const emptyAccess = JSON.stringify({
      version: 1,
      accessToken: '',
      refreshToken: '[REDACTED_REFRESH_TOKEN]',
      expiresAt: '2030-01-01T00:00:00.000Z',
    })

    expect(() => parseOAuthState(emptyAccess)).toThrow('Invalid OPENAI_CODEX_OAUTH state')
  })

  it('rejects an unknown schema version', () => {
    const unsupportedVersion = JSON.stringify({
      version: 2,
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      refreshToken: '[REDACTED_REFRESH_TOKEN]',
      expiresAt: '2030-01-01T00:00:00.000Z',
    })

    expect(() => parseOAuthState(unsupportedVersion)).toThrow('Invalid OPENAI_CODEX_OAUTH state')
  })

  it('rejects an invalid expiry instant', () => {
    const invalidExpiry = JSON.stringify({
      version: 1,
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      refreshToken: '[REDACTED_REFRESH_TOKEN]',
      expiresAt: 'not-a-timestamp',
    })

    expect(() => parseOAuthState(invalidExpiry)).toThrow('Invalid OPENAI_CODEX_OAUTH state')
  })

  it('accepts only canonical UTC expiry instants', () => {
    for (const expiresAt of [
      '2030-02-29T00:00:00.000Z',
      '2030-01-01T00:00:00.000',
      ' 2030-01-01T00:00:00.000Z',
    ]) {
      const state = JSON.stringify({
        version: 1,
        accessToken: '[REDACTED_ACCESS_TOKEN]',
        refreshToken: '[REDACTED_REFRESH_TOKEN]',
        expiresAt,
      })

      expect(() => parseOAuthState(state)).toThrow('Invalid OPENAI_CODEX_OAUTH state')
    }
  })

  it('rejects oversized opaque state data before parsing or serialization', () => {
    const oversizedState = {
      version: 1,
      accessToken: '[REDACTED_ACCESS_TOKEN]'.repeat(2048),
      refreshToken: '[REDACTED_REFRESH_TOKEN]',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }

    expect(() => serializeOAuthState(oversizedState as never)).toThrow('Invalid OPENAI_CODEX_OAUTH state')
    expect(() => parseOAuthState(JSON.stringify(oversizedState))).toThrow('Invalid OPENAI_CODEX_OAUTH state')
  })

  it('rejects an oversized refresh credential', () => {
    const oversizedState = {
      version: 1,
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      refreshToken: '[REDACTED_REFRESH_TOKEN]'.repeat(2048),
      expiresAt: '2030-01-01T00:00:00.000Z',
    }

    expect(() => serializeOAuthState(oversizedState as never)).toThrow('Invalid OPENAI_CODEX_OAUTH state')
    expect(() => parseOAuthState(JSON.stringify(oversizedState))).toThrow('Invalid OPENAI_CODEX_OAUTH state')
  })

  it('rejects aggregate state data above 32 KiB even when each field is bounded', () => {
    const state = {
      version: 1,
      accessToken: '[REDACTED_ACCESS_TOKEN]'.repeat(712),
      refreshToken: '[REDACTED_REFRESH_TOKEN]'.repeat(682),
      expiresAt: '2030-01-01T00:00:00.000Z',
    }

    expect(() => serializeOAuthState(state as never)).toThrow('Invalid OPENAI_CODEX_OAUTH state')
    expect(() => parseOAuthState(JSON.stringify(state))).toThrow('Invalid OPENAI_CODEX_OAUTH state')
  })

  it('requires exactly the expected own data fields', () => {
    const state = {
      version: 1,
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      refreshToken: '[REDACTED_REFRESH_TOKEN]',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }
    const inheritedState = Object.create(state)
    const accessorState = {
      version: 1,
      refreshToken: '[REDACTED_REFRESH_TOKEN]',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }
    Object.defineProperty(accessorState, 'accessToken', {
      enumerable: true,
      get: () => '[REDACTED_ACCESS_TOKEN]',
    })

    expect(() => parseOAuthState(JSON.stringify({ ...state, unexpected: '[REDACTED]' }))).toThrow(
      'Invalid OPENAI_CODEX_OAUTH state',
    )
    expect(() => serializeOAuthState(inheritedState as never)).toThrow('Invalid OPENAI_CODEX_OAUTH state')
    expect(() => serializeOAuthState(accessorState as never)).toThrow('Invalid OPENAI_CODEX_OAUTH state')
  })

  it('refuses to serialize an invalid state without echoing its value', () => {
    const invalidState = {
      version: 1,
      accessToken: '',
      refreshToken: '[REDACTED_REFRESH_TOKEN]',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }

    expect(() => serializeOAuthState(invalidState as never)).toThrow('Invalid OPENAI_CODEX_OAUTH state')
  })
})
