import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { hashOpenAiCodexAccountScope } from './account-scope.js'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { parseOAuthState, serializeOAuthState, type OAuthState } from './state.js'
import type { OAuthSessionCipher } from './session-cipher.js'

/**
 * Derives a stable credential reference from a non-secret account scope without
 * persisting or exposing the scope itself. The controller and status surface
 * only ever operate on the one derived reference they were constructed with.
 */
export function createScopedOpenAiCodexOAuthRef(accountScope: string): CredentialRef {
  return credentialRef(`OPENAI_CODEX_OAUTH_${hashOpenAiCodexAccountScope(accountScope).toUpperCase()}`)
}

const DEFAULT_EXPIRY_SKEW_MS = 30_000

export interface OAuthCredentialProvider {
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
  describe(ref: CredentialRef): Promise<CredentialInfo>
  set(ref: CredentialRef, value: string): Promise<void>
  unset(ref: CredentialRef): Promise<void>
}

export type OAuthSessionLock = <T>(operation: () => Promise<T>) => Promise<T>
export type OAuthSessionRefresh = (session: OAuthState) => Promise<OAuthState>
export type OAuthSessionStatus =
  | { authenticated: false }
  | { authenticated: true; expiresAt: string }

export class OAuthTerminalRefreshError extends Error {
  constructor() {
    super('OpenAI Codex OAuth refresh requires re-login')
    this.name = 'OAuthTerminalRefreshError'
  }
}

function isUsable(session: OAuthState, now: Date): boolean {
  return Date.parse(session.expiresAt) > now.getTime() + DEFAULT_EXPIRY_SKEW_MS
}

function reLoginRequired(): never {
  throw new Error('OpenAI Codex OAuth requires re-login')
}

export class OAuthSessionStore {
  constructor(
    private readonly credentials: OAuthCredentialProvider,
    private readonly withLock: OAuthSessionLock,
    private readonly cipher: OAuthSessionCipher,
    private readonly credential: CredentialRef,
  ) {}

  async saveSession(session: OAuthState): Promise<void> {
    await this.withLock(async () => {
      const info = await this.credentials.describe(this.credential)
      if (!info.writable) return reLoginRequired()
      await this.credentials.set(this.credential, this.encode(session))
    })
  }

  async disconnect(): Promise<void> {
    await this.withLock(async () => {
      const info = await this.credentials.describe(this.credential)
      if (!info.writable) return reLoginRequired()
      await this.credentials.unset(this.credential)
    })
  }

  async status(): Promise<OAuthSessionStatus> {
    try {
      const session = await this.read()
      return session === undefined ? { authenticated: false } : { authenticated: true, expiresAt: session.expiresAt }
    } catch {
      return { authenticated: false }
    }
  }

  async resolveSession(now: Date, refresh: OAuthSessionRefresh): Promise<OAuthState> {
    const current = await this.read()
    if (current !== undefined && isUsable(current, now)) return current
    if (current === undefined) return reLoginRequired()

    return this.withLock(async () => {
      const lockedCurrent = await this.read()
      if (lockedCurrent !== undefined && isUsable(lockedCurrent, now)) return lockedCurrent
      if (lockedCurrent === undefined) return reLoginRequired()

      const info = await this.credentials.describe(this.credential)
      if (!info.writable) return reLoginRequired()

      try {
        const refreshed = await refresh(lockedCurrent)
        await this.credentials.set(this.credential, this.encode(refreshed))
        return refreshed
      } catch (error) {
        if (!(error instanceof OAuthTerminalRefreshError)) throw error
        await this.credentials.unset(this.credential)
        return reLoginRequired()
      }
    })
  }

  private credentialBinding(): string {
    return String(this.credential)
  }

  private encode(state: OAuthState): string {
    return this.cipher.seal(serializeOAuthState(state), this.credentialBinding())
  }

  private async read(): Promise<OAuthState | undefined> {
    const resolved = await this.credentials.resolve(this.credential)
    if (resolved === undefined) return undefined
    return parseOAuthState(this.cipher.open(resolved.value, this.credentialBinding()))
  }
}
