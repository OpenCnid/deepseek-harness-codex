import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageJson = new URL('../package.json', import.meta.url)

describe('package manifest', () => {
  it('declares the public provider identity', async () => {
    const manifest = JSON.parse(await readFile(fileURLToPath(packageJson), 'utf8')) as {
      license: string
      name: string
    }

    expect(manifest.name).toBe('@opencnid/dsh-llm-openai-codex')
    expect(manifest.license).toBe('MIT')
  })
})
