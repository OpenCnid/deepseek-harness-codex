import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { parseOAuthState, serializeOAuthState, type OAuthState } from './state.js'

export const OPENAI_CODEX_OAUTH = credentialRef('OPENAI_CODEX_OAUTH')

const DEFAULT_EXPIRY_SKEW_MS = 30_000

export interface OAuthCredentialProvider {
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
  describe(ref: CredentialRef): Promise<CredentialInfo>
  set(ref: CredentialRef, value: string): Promise<void>
  unset(ref: CredentialRef): Promise<void>
}

export type OAuthSessionLock = <T>(operation: () => Promise<T>) => Promise<T>
export type OAuthSessionRefresh = (session: OAuthState) => Promise<OAuthState>

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
  ) {}

  async resolveSession(now: Date, refresh: OAuthSessionRefresh): Promise<OAuthState> {
    const current = await this.read()
    if (current !== undefined && isUsable(current, now)) return current
    if (current === undefined) return reLoginRequired()

    return this.withLock(async () => {
      const lockedCurrent = await this.read()
      if (lockedCurrent !== undefined && isUsable(lockedCurrent, now)) return lockedCurrent
      if (lockedCurrent === undefined) return reLoginRequired()

      const info = await this.credentials.describe(OPENAI_CODEX_OAUTH)
      if (!info.writable) return reLoginRequired()

      try {
        const refreshed = await refresh(lockedCurrent)
        await this.credentials.set(OPENAI_CODEX_OAUTH, serializeOAuthState(refreshed))
        return refreshed
      } catch (error) {
        if (!(error instanceof OAuthTerminalRefreshError)) throw error
        await this.credentials.unset(OPENAI_CODEX_OAUTH)
        return reLoginRequired()
      }
    })
  }

  private async read(): Promise<OAuthState | undefined> {
    const resolved = await this.credentials.resolve(OPENAI_CODEX_OAUTH)
    return resolved === undefined ? undefined : parseOAuthState(resolved.value)
  }
}
