import { describe, expect, it } from 'vitest'
import { createOpenAiCodexOAuthClient } from '../src/index.ts'

const clientConfig = {
  authorizationEndpoint: 'https://auth.example.test/authorize',
  tokenEndpoint: 'https://auth.example.test/token',
  deviceAuthorizationEndpoint: 'https://auth.example.test/device',
  responsesUrl: 'https://responses.example.test/v1/responses',
  clientId: '[REDACTED_CLIENT_ID]',
  redirectUri: 'http://127.0.0.1:17890/callback',
  scopes: ['[REDACTED_SCOPE]'],
}

describe('OpenAI Codex OAuth protocol client', () => {
  it('uses PKCE browser authorization and exchanges only a state-bound redirect', async () => {
    let exchange: URLSearchParams | undefined
    const client = createOpenAiCodexOAuthClient({
      ...clientConfig,
      now: () => new Date('2030-01-01T00:00:00.000Z'),
      fetch: async (_url, init) => {
        exchange = new URLSearchParams(String(init?.body))
        return new Response(JSON.stringify({
          access_token: '[REDACTED_ACCESS_TOKEN]',
          refresh_token: '[REDACTED_REFRESH_TOKEN]',
          expires_in: 3600,
        }), { status: 200 })
      },
    })
    const login = client.startBrowserLogin()
    const authorization = new URL(login.authorizationUrl)

    expect(authorization.origin).toBe('https://auth.example.test')
    expect(authorization.searchParams.get('response_type')).toBe('code')
    expect(authorization.searchParams.get('client_id')).toBe('[REDACTED_CLIENT_ID]')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('code_challenge')).toBeTruthy()
    const state = authorization.searchParams.get('state')
    expect(state).toBeTruthy()

    const session = await login.complete(`http://127.0.0.1:17890/callback?code=[REDACTED_AUTHORIZATION_CODE]&state=${state}`)

    expect(session).toEqual({
      version: 1,
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      refreshToken: '[REDACTED_REFRESH_TOKEN]',
      expiresAt: '2030-01-01T01:00:00.000Z',
    })
    expect(exchange?.get('grant_type')).toBe('authorization_code')
    expect(exchange?.get('client_id')).toBe('[REDACTED_CLIENT_ID]')
    expect(exchange?.get('code')).toBe('[REDACTED_AUTHORIZATION_CODE]')
    expect(exchange?.get('redirect_uri')).toBe('http://127.0.0.1:17890/callback')
    expect(exchange?.get('code_verifier')).toBeTruthy()
  })

  it('rejects a browser callback with an unbound state before token exchange', async () => {
    let calls = 0
    const client = createOpenAiCodexOAuthClient({
      ...clientConfig,
      fetch: async () => {
        calls += 1
        return new Response('{}', { status: 500 })
      },
    })
    const login = client.startBrowserLogin()

    await expect(login.complete('http://127.0.0.1:17890/callback?code=[REDACTED_AUTHORIZATION_CODE]&state=unbound')).rejects.toThrow(
      'OpenAI Codex browser authorization could not be verified',
    )
    expect(calls).toBe(0)
  })

  it('starts device authorization and progresses from pending to a completed session', async () => {
    const bodies: URLSearchParams[] = []
    let request = 0
    const client = createOpenAiCodexOAuthClient({
      ...clientConfig,
      now: () => new Date('2030-01-01T00:00:00.000Z'),
      fetch: async (_url, init) => {
        bodies.push(new URLSearchParams(String(init?.body)))
        request += 1
        if (request === 1) {
          return new Response(JSON.stringify({
            device_code: '[REDACTED_DEVICE_CODE]',
            user_code: '[REDACTED_USER_CODE]',
            verification_uri: 'https://auth.example.test/activate',
            verification_uri_complete: 'https://auth.example.test/activate?opaque=[REDACTED]',
            expires_in: 900,
            interval: 5,
          }), { status: 200 })
        }
        if (request === 2) return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 })
        return new Response(JSON.stringify({
          access_token: '[REDACTED_ACCESS_TOKEN]',
          refresh_token: '[REDACTED_REFRESH_TOKEN]',
          expires_in: 3600,
        }), { status: 200 })
      },
    })

    const login = await client.startDeviceLogin()

    expect(login.userCode).toBe('[REDACTED_USER_CODE]')
    expect(login.verificationUri).toBe('https://auth.example.test/activate')
    expect(login.verificationUriComplete).toBe('https://auth.example.test/activate?opaque=[REDACTED]')
    expect(login.expiresAt).toBe('2030-01-01T00:15:00.000Z')
    await expect(login.poll()).resolves.toEqual({ kind: 'pending', retryAfterMs: 5000 })
    await expect(login.poll()).resolves.toEqual({
      kind: 'complete',
      session: {
        version: 1,
        accessToken: '[REDACTED_ACCESS_TOKEN]',
        refreshToken: '[REDACTED_REFRESH_TOKEN]',
        expiresAt: '2030-01-01T01:00:00.000Z',
      },
    })
    expect(bodies[0]?.get('client_id')).toBe('[REDACTED_CLIENT_ID]')
    expect(bodies[1]?.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
    expect(bodies[1]?.get('device_code')).toBe('[REDACTED_DEVICE_CODE]')
  })

  it('rejects an oversized device authorization body without parsing it', async () => {
    const client = createOpenAiCodexOAuthClient({
      ...clientConfig,
      fetch: async () => new Response(JSON.stringify({
        device_code: '[REDACTED_DEVICE_CODE]',
        user_code: '[REDACTED_USER_CODE]',
        verification_uri: 'https://auth.example.test/activate',
        expires_in: 900,
      }), {
        status: 200,
        headers: { 'content-length': String(1024 * 1024 + 1) },
      }),
    })

    await expect(client.startDeviceLogin()).rejects.toThrow('OpenAI Codex device authorization requires re-login')
  })
})
