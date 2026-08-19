import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  createAes256GcmSessionCipher,
  createScopedOpenAiCodexOAuthRef,
  OAuthSessionStore,
} from '../src/index.ts'

describe('account-scoped OAuth session ownership', () => {
  it('rejects non-canonical UTF-8 account scopes before deriving a credential reference', () => {
    const loneSurrogate = '\uD800'
    expect(() => createScopedOpenAiCodexOAuthRef(loneSurrogate)).toThrow('OpenAI Codex OAuth account scope is invalid')
    expect(() => createScopedOpenAiCodexOAuthRef('\uFFFD')).not.toThrow()
  })

  it('fails closed when ciphertext is copied between separate scoped credential references', async () => {
    const values = new Map<unknown, string>()
    const credentials = {
      resolve: async (ref: unknown) => {
        const value = values.get(ref)
        return value === undefined ? undefined : { value, source: 'memory' }
      },
      describe: async () => ({ configured: true, source: 'memory', writable: true }),
      set: async (ref: unknown, value: string) => { values.set(ref, value) },
      unset: async (ref: unknown) => { values.delete(ref) },
    }
    const cipher = createAes256GcmSessionCipher(Buffer.alloc(32, 8))
    const firstRef = createScopedOpenAiCodexOAuthRef('[REDACTED_ACCOUNT_SCOPE_A]')
    const secondRef = createScopedOpenAiCodexOAuthRef('[REDACTED_ACCOUNT_SCOPE_B]')
    const first = new OAuthSessionStore(credentials, async operation => operation(), cipher, firstRef)
    const second = new OAuthSessionStore(credentials, async operation => operation(), cipher, secondRef)

    await first.saveSession({
      version: 1,
      accessToken: '[REDACTED_ACCESS_TOKEN_A]',
      refreshToken: '[REDACTED_REFRESH_TOKEN_A]',
      expiresAt: '2030-01-01T00:00:00.000Z',
    })
    values.set(secondRef, values.get(firstRef) ?? '')

    await expect(second.status()).resolves.toEqual({ authenticated: false })
  })

  it('isolates encrypted credential state and status between opaque account scopes', async () => {
    const values = new Map<unknown, string>()
    const credentials = {
      resolve: async (ref: unknown) => {
        const value = values.get(ref)
        return value === undefined ? undefined : { value, source: 'memory' }
      },
      describe: async (ref: unknown) => ({ configured: values.has(ref), source: values.has(ref) ? 'memory' : undefined, writable: true }),
      set: async (ref: unknown, value: string) => { values.set(ref, value) },
      unset: async (ref: unknown) => { values.delete(ref) },
    }
    const firstRef = createScopedOpenAiCodexOAuthRef('[REDACTED_ACCOUNT_SCOPE_A]')
    const secondRef = createScopedOpenAiCodexOAuthRef('[REDACTED_ACCOUNT_SCOPE_B]')
    const cipher = createAes256GcmSessionCipher(Buffer.alloc(32, 8))
    const first = new OAuthSessionStore(credentials, async operation => operation(), cipher, firstRef)
    const second = new OAuthSessionStore(credentials, async operation => operation(), cipher, secondRef)

    await first.saveSession({
      version: 1,
      accessToken: '[REDACTED_ACCESS_TOKEN_A]',
      refreshToken: '[REDACTED_REFRESH_TOKEN_A]',
      expiresAt: '2030-01-01T00:00:00.000Z',
    })
    await second.saveSession({
      version: 1,
      accessToken: '[REDACTED_ACCESS_TOKEN_B]',
      refreshToken: '[REDACTED_REFRESH_TOKEN_B]',
      expiresAt: '2031-01-01T00:00:00.000Z',
    })

    expect(firstRef).not.toBe(secondRef)
    await expect(first.status()).resolves.toEqual({ authenticated: true, expiresAt: '2030-01-01T00:00:00.000Z' })
    await expect(second.status()).resolves.toEqual({ authenticated: true, expiresAt: '2031-01-01T00:00:00.000Z' })
    await first.disconnect()
    await expect(first.status()).resolves.toEqual({ authenticated: false })
    await expect(second.status()).resolves.toEqual({ authenticated: true, expiresAt: '2031-01-01T00:00:00.000Z' })
  })
})
