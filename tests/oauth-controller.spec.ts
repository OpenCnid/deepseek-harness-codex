import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  createAes256GcmSessionCipher,
  createOpenAiCodexOAuthClient,
  createOpenAiCodexOAuthController,
  createScopedOpenAiCodexOAuthRef,
  OAuthSessionStore,
} from '../src/index.ts'

const clientConfig = {
  authorizationEndpoint: 'https://auth.example.test/authorize',
  tokenEndpoint: 'https://auth.example.test/token',
  deviceAuthorizationEndpoint: 'https://auth.example.test/device',
  responsesUrl: 'https://responses.example.test/v1/responses',
  clientId: '[REDACTED_CLIENT_ID]',
  redirectUri: 'http://127.0.0.1:17890/callback',
  scopes: ['[REDACTED_SCOPE]'],
}

describe('OpenAI Codex OAuth controller', () => {
  it('does not expose its client or encrypted session store as runtime properties', () => {
    const controller = createOpenAiCodexOAuthController({
      client: {} as never,
      sessions: {} as never,
    })

    expect(Reflect.ownKeys(controller)).not.toContain('client')
    expect(Reflect.ownKeys(controller)).not.toContain('sessions')
    expect(Object.isFrozen(controller)).toBe(true)
  })

  it('persists a completed browser login encrypted and exposes only value-free status', async () => {
    let persisted: string | undefined
    const credentials = {
      resolve: async () => persisted === undefined ? undefined : { value: persisted, source: 'memory' },
      describe: async () => ({ configured: persisted !== undefined, source: persisted === undefined ? undefined : 'memory', writable: true }),
      set: async (_ref: unknown, value: string) => { persisted = value },
      unset: async () => { persisted = undefined },
    }
    const client = createOpenAiCodexOAuthClient({
      ...clientConfig,
      now: () => new Date('2030-01-01T00:00:00.000Z'),
      fetch: async () => new Response(JSON.stringify({
        access_token: '[REDACTED_ACCESS_TOKEN]',
        refresh_token: '[REDACTED_REFRESH_TOKEN]',
        expires_in: 3600,
      }), { status: 200 }),
    })
    const sessions = new OAuthSessionStore(
      credentials,
      async operation => operation(),
      createAes256GcmSessionCipher(Buffer.alloc(32, 3)),
      createScopedOpenAiCodexOAuthRef('[REDACTED_TEST_SCOPE]'),
    )
    const controller = createOpenAiCodexOAuthController({ client, sessions })
    const login = controller.startBrowserLogin()
    const state = new URL(login.authorizationUrl).searchParams.get('state')

    const status = await login.complete(`http://127.0.0.1:17890/callback?code=[REDACTED_AUTHORIZATION_CODE]&state=${state}`)

    expect(status).toEqual({ authenticated: true, expiresAt: '2030-01-01T01:00:00.000Z' })
    expect(JSON.stringify(status)).not.toContain('[REDACTED_ACCESS_TOKEN]')
    expect(persisted).not.toContain('[REDACTED_ACCESS_TOKEN]')
    await expect(controller.status()).resolves.toEqual(status)
    await controller.disconnect()
    await expect(controller.status()).resolves.toEqual({ authenticated: false })
  })

  it('persists a device-code completion but never returns the device secret', async () => {
    let persisted: string | undefined
    let calls = 0
    const credentials = {
      resolve: async () => persisted === undefined ? undefined : { value: persisted, source: 'memory' },
      describe: async () => ({ configured: persisted !== undefined, source: persisted === undefined ? undefined : 'memory', writable: true }),
      set: async (_ref: unknown, value: string) => { persisted = value },
      unset: async () => { persisted = undefined },
    }
    const client = createOpenAiCodexOAuthClient({
      ...clientConfig,
      now: () => new Date('2030-01-01T00:00:00.000Z'),
      fetch: async () => {
        calls += 1
        if (calls === 1) return new Response(JSON.stringify({
          device_code: '[REDACTED_DEVICE_CODE]',
          user_code: '[REDACTED_USER_CODE]',
          verification_uri: 'https://auth.example.test/activate',
          expires_in: 900,
        }), { status: 200 })
        return new Response(JSON.stringify({
          access_token: '[REDACTED_ACCESS_TOKEN]',
          refresh_token: '[REDACTED_REFRESH_TOKEN]',
          expires_in: 3600,
        }), { status: 200 })
      },
    })
    const sessions = new OAuthSessionStore(
      credentials,
      async operation => operation(),
      createAes256GcmSessionCipher(Buffer.alloc(32, 4)),
      createScopedOpenAiCodexOAuthRef('[REDACTED_TEST_SCOPE]'),
    )
    const controller = createOpenAiCodexOAuthController({ client, sessions })

    const login = await controller.startDeviceLogin()
    const result = await login.poll()

    expect(login).toMatchObject({ userCode: '[REDACTED_USER_CODE]', verificationUri: 'https://auth.example.test/activate' })
    expect(result).toEqual({ kind: 'complete', status: { authenticated: true, expiresAt: '2030-01-01T01:00:00.000Z' } })
    expect(JSON.stringify(result)).not.toContain('[REDACTED_ACCESS_TOKEN]')
    expect(JSON.stringify(login)).not.toContain('[REDACTED_DEVICE_CODE]')
    expect(persisted).not.toContain('[REDACTED_ACCESS_TOKEN]')
  })
})
