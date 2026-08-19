import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { createOAuthSessionFileLock } from '../src/index.ts'

const temporaryDirectories: string[] = []
const children: ChildProcessWithoutNullStreams[] = []

function waitForLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lock contender did not start')), 2_000)
    const onData = (chunk: Buffer): void => {
      if (chunk.toString('utf8').includes(expected)) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        resolve()
      }
    }
    child.stdout.on('data', onData)
    child.once('error', error => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      reject(error)
    })
  })
}

function childExit(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? -1))
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true, maxRetries: 3 })))
})

describe('Codex OAuth cross-process refresh lock', () => {
  it('keeps a separate Node process outside the refresh critical section until the owner releases it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-codex-cross-lock-'))
    temporaryDirectories.push(directory)
    const filename = join(directory, 'private', 'openai-codex-oauth')
    const marker = join(directory, 'contender-entered')
    await mkdir(join(directory, 'private'), { recursive: true, mode: 0o700 })
    const withLock = createOAuthSessionFileLock(filename)
    let releaseOwner: (() => void) | undefined
    let ownerEntered: (() => void) | undefined
    const ownerReady = new Promise<void>(resolve => { ownerEntered = resolve })
    const owner = withLock(async () => {
      ownerEntered?.()
      await new Promise<void>(resolve => { releaseOwner = resolve })
    })
    await ownerReady

    const fixture = fileURLToPath(new URL('./fixtures/lock-contender.mjs', import.meta.url))
    const contender = spawn(process.execPath, [fixture, filename, marker], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(contender)
    await waitForLine(contender, 'attempting')
    await delay(100)
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })

    releaseOwner?.()
    await owner
    await expect(childExit(contender)).resolves.toBe(0)
    expect(await readFile(marker, 'utf8')).toBe('entered')
  }, 10_000)
})
