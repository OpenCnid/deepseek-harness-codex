import type { OpenAiCodexBrowserLogin, OpenAiCodexDeviceLogin, OpenAiCodexOAuthClient } from './oauth-client.js'
import { OAuthSessionStore, type OAuthSessionStatus } from './session-store.js'

export interface OpenAiCodexControllerBrowserLogin {
  readonly authorizationUrl: string
  complete(callbackUrl: string): Promise<OAuthSessionStatus>
}

export type OpenAiCodexControllerDevicePollResult =
  | { kind: 'pending'; retryAfterMs: number }
  | { kind: 'complete'; status: OAuthSessionStatus }

export interface OpenAiCodexControllerDeviceLogin {
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete?: string
  readonly expiresAt: string
  poll(): Promise<OpenAiCodexControllerDevicePollResult>
}

export interface OpenAiCodexOAuthController {
  status(): Promise<OAuthSessionStatus>
  startBrowserLogin(): OpenAiCodexControllerBrowserLogin
  startDeviceLogin(): Promise<OpenAiCodexControllerDeviceLogin>
  disconnect(): Promise<void>
}

export interface OpenAiCodexOAuthControllerOptions {
  client: OpenAiCodexOAuthClient
  sessions: OAuthSessionStore
}

function connected(expiresAt: string): OAuthSessionStatus {
  return { authenticated: true, expiresAt }
}

function browserLogin(login: OpenAiCodexBrowserLogin, sessions: OAuthSessionStore): OpenAiCodexControllerBrowserLogin {
  return Object.freeze({
    authorizationUrl: login.authorizationUrl,
    complete: async (callbackUrl: string) => {
      const session = await login.complete(callbackUrl)
      await sessions.saveSession(session)
      return connected(session.expiresAt)
    },
  })
}

function deviceLogin(login: OpenAiCodexDeviceLogin, sessions: OAuthSessionStore): OpenAiCodexControllerDeviceLogin {
  return Object.freeze({
    userCode: login.userCode,
    verificationUri: login.verificationUri,
    ...login.verificationUriComplete === undefined ? {} : { verificationUriComplete: login.verificationUriComplete },
    expiresAt: login.expiresAt,
    poll: async (): Promise<OpenAiCodexControllerDevicePollResult> => {
      const result = await login.poll()
      if (result.kind === 'pending') return result
      await sessions.saveSession(result.session)
      return { kind: 'complete', status: connected(result.session.expiresAt) }
    },
  })
}

/**
 * Value-free control surface for one plugin-owned encrypted OAuth session.
 * User-facing browser and device progress remains available, while access and
 * refresh tokens never leave the controller's auth boundary.
 */
export function createOpenAiCodexOAuthController(options: OpenAiCodexOAuthControllerOptions): OpenAiCodexOAuthController {
  const { client, sessions } = options
  return Object.freeze({
    status: () => sessions.status(),
    startBrowserLogin: () => browserLogin(client.startBrowserLogin(), sessions),
    startDeviceLogin: async () => deviceLogin(await client.startDeviceLogin(), sessions),
    disconnect: () => sessions.disconnect(),
  })
}
