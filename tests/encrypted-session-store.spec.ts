import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { createAes256GcmSessionCipher, createScopedOpenAiCodexOAuthRef, OAuthSessionStore } from '../src/index.ts'
import { serializeOAuthState } from '../src/auth/state.ts'

describe('encrypted OAuth session persistence', () => {
  it('decrypts the stored session and encrypts its rotated replacement', async () => {
    const cipher = createAes256GcmSessionCipher(Buffer.alloc(32, 9))
    const credential = createScopedOpenAiCodexOAuthRef('[REDACTED_TEST_SCOPE]')
    let persisted = cipher.seal(serializeOAuthState({
      version: 1,
      accessToken: '[REDACTED_EXPIRED_ACCESS_TOKEN]',
      refreshToken: '[REDACTED_REFRESH_TOKEN]',
      expiresAt: '2028-01-01T00:00:00.000Z',
    }), String(credential))
    const credentials = {
      resolve: async () => ({ value: persisted, source: 'memory' }),
      describe: async () => ({ configured: true, source: 'memory', writable: true }),
      set: async (_ref: unknown, value: string) => { persisted = value },
      unset: async () => { persisted = '' },
    }
    const store = new OAuthSessionStore(
      credentials,
      async operation => operation(),
      cipher,
      credential,
    )

    const session = await store.resolveSession(new Date('2029-01-01T00:00:00.000Z'), async () => ({
      version: 1,
      accessToken: '[REDACTED_ROTATED_ACCESS_TOKEN]',
      refreshToken: '[REDACTED_ROTATED_REFRESH_TOKEN]',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }))

    expect(session.expiresAt).toBe('2030-01-01T00:00:00.000Z')
    expect(persisted).not.toContain('[REDACTED_ROTATED_ACCESS_TOKEN]')
    expect(cipher.open(persisted, String(credential))).toBe(serializeOAuthState(session))
  })
})
