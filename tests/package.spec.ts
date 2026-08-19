import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

const packageJson = new URL('../package.json', import.meta.url)
const standaloneContract = new URL('../docs/codex-oauth-port-contract.md', import.meta.url)
const legacyHermesContract = new URL('../docs/hermes-port-contract.md', import.meta.url)
const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const cleanScript = join(repoRoot, 'scripts', 'clean-dist.mjs')
const staleBrokerArtifacts = [
  'hermes-codex-broker.d.ts',
  'hermes-codex-broker.d.ts.map',
  'hermes-codex-broker.js',
  'hermes-codex-broker.js.map',
] as const

interface PackageManifest {
  license: string
  name: string
  scripts?: Record<string, string>
}

async function loadManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(fileURLToPath(packageJson), 'utf8')) as PackageManifest
}

function tarField(buffer: Buffer, start: number, length: number): string {
  return buffer.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '')
}

function packedEntries(archive: Buffer): string[] {
  const tar = gunzipSync(archive)
  const entries: string[] = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const prefix = tarField(header, 345, 155)
    const name = tarField(header, 0, 100)
    entries.push(prefix.length === 0 ? name : `${prefix}/${name}`)
    const size = Number.parseInt(tarField(header, 124, 12).trim() || '0', 8)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

function runPnpm(args: readonly string[], cwd: string, timeout = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    let output = ''
    let settled = false
    const appendOutput = (chunk: unknown) => {
      output = `${output}${String(chunk)}`.slice(-16_384)
    }
    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    const child = spawn('pnpm', args, {
      cwd,
      shell: process.platform === 'win32',
      signal: controller.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', appendOutput)
    child.stderr?.on('data', appendOutput)
    child.once('error', error => {
      settle(() => {
        const reason = controller.signal.aborted ? `timed out after ${timeout} ms` : error.message
        reject(new Error(`pnpm ${args[0] ?? 'command'} ${reason}: ${output || '(no output)'}`))
      })
    })
    child.once('close', code => {
      settle(() => {
        if (code === 0) resolve()
        else reject(new Error(`pnpm ${args[0] ?? 'command'} failed with exit code ${code ?? 'unknown'}: ${output || '(no output)'}`))
      })
    })
  })
}

describe('package manifest', () => {
  it('declares the public provider identity', async () => {
    const manifest = await loadManifest()

    expect(manifest.name).toBe('@opencnid/dsh-llm-openai-codex')
    expect(manifest.license).toBe('MIT')
  })

  it('does not declare legacy broker verification scripts', async () => {
    const manifest = await loadManifest()

    expect(manifest.scripts).not.toHaveProperty('test:broker')
    expect(manifest.scripts).not.toHaveProperty('check:broker')
  })

  it('cleans stale broker artifacts before packaging an isolated fixture', async () => {
    const manifest = await loadManifest()
    expect(manifest.scripts?.clean).toBe('node scripts/clean-dist.mjs')
    expect(manifest.scripts?.build).toBe('pnpm run clean && tsc -p tsconfig.json')
    expect(manifest.scripts?.prepack).toBe('pnpm run build')

    const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-codex-pack-'))
    const fixtureScript = join(fixtureRoot, 'scripts', 'clean-dist.mjs')
    const fixtureBuild = join(fixtureRoot, 'scripts', 'build.mjs')
    const fixtureDist = join(fixtureRoot, 'dist')
    const packageOutput = join(fixtureRoot, 'package-output')
    try {
      await mkdir(join(fixtureRoot, 'scripts'), { recursive: true })
      await mkdir(fixtureDist, { recursive: true })
      await mkdir(packageOutput, { recursive: true })
      await writeFile(fixtureScript, await readFile(cleanScript))
      await writeFile(fixtureBuild, "import { mkdir, writeFile } from 'node:fs/promises'\nimport { fileURLToPath } from 'node:url'\n\nconst dist = fileURLToPath(new URL('../dist', import.meta.url))\nawait mkdir(dist, { recursive: true })\nawait writeFile(new URL('../dist/current.js', import.meta.url), 'export {}\\n')\n")
      await writeFile(join(fixtureRoot, 'package.json'), `${JSON.stringify({
        files: ['dist'],
        name: '@opencnid/package-lifecycle-fixture',
        scripts: {
          build: 'pnpm run clean && node scripts/build.mjs',
          clean: 'node scripts/clean-dist.mjs',
          prepack: 'pnpm run build',
        },
        version: '0.0.0',
      }, null, 2)}\n`)
      await Promise.all(staleBrokerArtifacts.map(async artifact => {
        await writeFile(join(fixtureDist, artifact), 'obsolete generated artifact')
      }))

      await runPnpm(['pack', '--pack-destination', 'package-output'], fixtureRoot)

      const archives = await readdir(packageOutput)
      expect(archives).toHaveLength(1)
      const entries = packedEntries(await readFile(join(packageOutput, archives[0]!)))
      expect(entries).toContain('package/dist/current.js')
      expect(entries.filter(entry => entry.startsWith('package/dist/hermes-codex-broker.'))).toEqual([])
    } finally {
      await rm(fixtureRoot, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 })
    }
  }, 15_000)

  it('documents the standalone OAuth boundary without a legacy broker contract', async () => {
    await expect(access(fileURLToPath(legacyHermesContract))).rejects.toMatchObject({ code: 'ENOENT' })

    const contract = await readFile(fileURLToPath(standaloneContract), 'utf8')
    expect(contract).toContain('Pi is behavioral reference material only')
    expect(contract).not.toMatch(/\bHermes\b/i)
  })
})
