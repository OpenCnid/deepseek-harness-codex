import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { OAuthSessionLock } from './session-store.js'

export function oauthSessionLockFile(home: string = resolveDshHome()): string {
  return join(home, 'locks', 'openai-codex-oauth')
}

export function createOAuthSessionFileLock(filename: string = oauthSessionLockFile()): OAuthSessionLock {
  return async operation => {
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
    return withFileLock(filename, operation)
  }
}
