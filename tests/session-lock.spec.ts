import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOAuthSessionFileLock, oauthSessionLockFile } from '../src/index.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('Codex OAuth session lock', () => {
  it('uses a stable private file location beneath the Harness home', () => {
    expect(oauthSessionLockFile('/home/[REDACTED]/.dsh')).toBe('/home/[REDACTED]/.dsh/locks/openai-codex-oauth')
  })

  it('derives distinct private lock locations for distinct account scopes', () => {
    const first = oauthSessionLockFile('/home/[REDACTED]/.dsh', '[REDACTED_ACCOUNT_SCOPE_A]')
    const second = oauthSessionLockFile('/home/[REDACTED]/.dsh', '[REDACTED_ACCOUNT_SCOPE_B]')
    expect(first).not.toBe(second)
    expect(first).toMatch(/^\/home\/\[REDACTED\]\/\.dsh\/locks\/openai-codex-oauth-[a-f0-9]{64}$/)
  })

  it('rejects non-canonical UTF-8 account scopes before deriving a lock location', () => {
    const loneSurrogate = '\uD800'
    expect(() => oauthSessionLockFile('/home/[REDACTED]/.dsh', loneSurrogate)).toThrow('OpenAI Codex OAuth account scope is invalid')
    expect(() => oauthSessionLockFile('/home/[REDACTED]/.dsh', '\uFFFD')).not.toThrow()
  })

  it('serializes callers and releases the sibling lock file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-codex-lock-'))
    temporaryDirectories.push(directory)
    const filename = join(directory, 'private', 'openai-codex-oauth')
    const withLock = createOAuthSessionFileLock(filename)
    const order: string[] = []
    let releaseFirst: (() => void) | undefined
    let enteredFirst: (() => void) | undefined
    const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve })
    const first = withLock(async () => {
      order.push('first')
      enteredFirst?.()
      await new Promise<void>(resolve => { releaseFirst = resolve })
      return 'first-result'
    })
    await firstEntered
    const second = withLock(async () => {
      order.push('second')
      return 'second-result'
    })
    releaseFirst?.()

    await expect(Promise.all([first, second])).resolves.toEqual(['first-result', 'second-result'])
    expect(order).toEqual(['first', 'second'])
    await expect(access(`${filename}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
