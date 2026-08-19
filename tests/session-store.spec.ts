import { describe, expect, it } from 'vitest'
import { OAuthSessionStore, OAuthTerminalRefreshError, createAes256GcmSessionCipher, createScopedOpenAiCodexOAuthRef } from '../src/index.ts'
import { serializeOAuthState } from '../src/auth/state.ts'

const cipher = createAes256GcmSessionCipher(new Uint8Array(32).fill(7))
const credential = createScopedOpenAiCodexOAuthRef('[REDACTED_TEST_SCOPE]')
const binding = String(credential)

function createStore(
  credentials: ConstructorParameters<typeof OAuthSessionStore>[0],
  withLock: ConstructorParameters<typeof OAuthSessionStore>[1],
): OAuthSessionStore {
  return new OAuthSessionStore(credentials, withLock, cipher, credential)
}

describe('Codex OAuth session store', () => {
  it('returns a current session without locking or refreshing', async () => {
    let persisted: string | undefined = serializeOAuthState({
      version: 1,
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      refreshToken: '[REDACTED_REFRESH_TOKEN]',
      expiresAt: '2030-01-01T00:00:00.000Z',
    })
    const credentials = {
      resolve: async () => ({ value: cipher.seal(persisted ?? '', binding), source: 'memory' as const }),
      describe: async () => ({ configured: true, source: 'memory' as const, writable: true }),
      set: async (_ref: unknown, value: string) => { persisted = cipher.open(value, binding) },
      unset: async () => { persisted = undefined },
    }
    let lockCalls = 0
    let refreshCalls = 0
    const store = createStore(credentials, async operation => {
      lockCalls += 1
      return operation()
    })

    const session = await store.resolveSession(new Date('2029-01-01T00:00:00.000Z'), async state => {
      refreshCalls += 1
      return state
    })

    expect(session.expiresAt).toBe('2030-01-01T00:00:00.000Z')
    expect(lockCalls).toBe(0)
    expect(refreshCalls).toBe(0)
  })

  it('refreshes an expired session under the lock and persists its rotated state', async () => {
    let persisted: string | undefined = serializeOAuthState({
      version: 1,
      accessToken: '[REDACTED_EXPIRED_ACCESS_TOKEN]',
      refreshToken: '[REDACTED_EXPIRED_REFRESH_TOKEN]',
      expiresAt: '2028-01-01T00:00:00.000Z',
    })
    let lockCalls = 0
    let refreshCalls = 0
    const credentials = {
      resolve: async () => persisted === undefined ? undefined : { value: cipher.seal(persisted ?? '', binding), source: 'memory' as const },
      describe: async () => ({ configured: true, source: 'memory' as const, writable: true }),
      set: async (_ref: unknown, value: string) => { persisted = cipher.open(value, binding) },
      unset: async () => { persisted = undefined },
    }
    const store = createStore(credentials, async operation => {
      lockCalls += 1
      return operation()
    })

    const session = await store.resolveSession(new Date('2029-01-01T00:00:00.000Z'), async () => {
      refreshCalls += 1
      return {
        version: 1,
        accessToken: '[REDACTED_ROTATED_ACCESS_TOKEN]',
        refreshToken: '[REDACTED_ROTATED_REFRESH_TOKEN]',
        expiresAt: '2030-01-01T00:00:00.000Z',
      }
    })

    expect(session.expiresAt).toBe('2030-01-01T00:00:00.000Z')
    expect(lockCalls).toBe(1)
    expect(refreshCalls).toBe(1)
    expect(persisted).toBe(serializeOAuthState(session))
  })

  it('adopts a concurrent caller’s rotated session after re-resolving under the lock', async () => {
    let persisted: string | undefined = serializeOAuthState({
      version: 1,
      accessToken: '[REDACTED_EXPIRED_ACCESS_TOKEN]',
      refreshToken: '[REDACTED_EXPIRED_REFRESH_TOKEN]',
      expiresAt: '2028-01-01T00:00:00.000Z',
    })
    let refreshCalls = 0
    let queued = Promise.resolve()
    const credentials = {
      resolve: async () => persisted === undefined ? undefined : { value: cipher.seal(persisted ?? '', binding), source: 'memory' as const },
      describe: async () => ({ configured: true, source: 'memory' as const, writable: true }),
      set: async (_ref: unknown, value: string) => { persisted = cipher.open(value, binding) },
      unset: async () => { persisted = undefined },
    }
    const store = createStore(credentials, async operation => {
      const task = queued.then(operation, operation)
      queued = task.then(() => undefined, () => undefined)
      return task
    })
    const refresh = async () => {
      refreshCalls += 1
      return {
        version: 1 as const,
        accessToken: '[REDACTED_ROTATED_ACCESS_TOKEN]',
        refreshToken: '[REDACTED_ROTATED_REFRESH_TOKEN]',
        expiresAt: '2030-01-01T00:00:00.000Z',
      }
    }

    const sessions = await Promise.all([
      store.resolveSession(new Date('2029-01-01T00:00:00.000Z'), refresh),
      store.resolveSession(new Date('2029-01-01T00:00:00.000Z'), refresh),
    ])

    expect(refreshCalls).toBe(1)
    expect(sessions[0]?.expiresAt).toBe('2030-01-01T00:00:00.000Z')
    expect(sessions[1]?.expiresAt).toBe('2030-01-01T00:00:00.000Z')
  })

  it('removes a terminally invalid session and reports a value-free re-login requirement', async () => {
    let persisted: string | undefined = serializeOAuthState({
      version: 1,
      accessToken: '[REDACTED_EXPIRED_ACCESS_TOKEN]',
      refreshToken: '[REDACTED_EXPIRED_REFRESH_TOKEN]',
      expiresAt: '2028-01-01T00:00:00.000Z',
    })
    const credentials = {
      resolve: async () => persisted === undefined ? undefined : { value: cipher.seal(persisted ?? '', binding), source: 'memory' as const },
      describe: async () => ({ configured: true, source: 'memory' as const, writable: true }),
      set: async (_ref: unknown, value: string) => { persisted = cipher.open(value, binding) },
      unset: async () => { persisted = undefined },
    }
    const store = createStore(credentials, async operation => operation())

    await expect(store.resolveSession(new Date('2029-01-01T00:00:00.000Z'), async () => {
      throw new OAuthTerminalRefreshError()
    })).rejects.toThrow('OpenAI Codex OAuth requires re-login')
    expect(persisted).toBeUndefined()
  })

  it('does not refresh or overwrite an expired session from a read-only credential source', async () => {
    const persisted = serializeOAuthState({
      version: 1,
      accessToken: '[REDACTED_EXPIRED_ACCESS_TOKEN]',
      refreshToken: '[REDACTED_EXPIRED_REFRESH_TOKEN]',
      expiresAt: '2028-01-01T00:00:00.000Z',
    })
    let refreshCalls = 0
    const credentials = {
      resolve: async () => ({ value: cipher.seal(persisted ?? '', binding), source: 'env' as const }),
      describe: async () => ({ configured: true, source: 'env' as const, writable: false }),
      set: async () => { throw new Error('set must not be called') },
      unset: async () => { throw new Error('unset must not be called') },
    }
    const store = createStore(credentials, async operation => operation())

    await expect(store.resolveSession(new Date('2029-01-01T00:00:00.000Z'), async state => {
      refreshCalls += 1
      return state
    })).rejects.toThrow('OpenAI Codex OAuth requires re-login')
    expect(refreshCalls).toBe(0)
  })
})
