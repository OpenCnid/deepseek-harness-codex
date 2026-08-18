import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { LlmRuntime, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { CodexTextAdapter } from '../src/adapter.ts'
import { OPENAI_CODEX_OAUTH } from '../src/auth/session-store.ts'
import { serializeOAuthState } from '../src/auth/state.ts'
import defaultPlugin, { OPENAI_CODEX_PROVIDER, getOpenAiCodexStatus, openAiCodexPlugin } from '../src/index.ts'

class MemoryCredentials extends CredentialProvider {
  private readonly values = new Map<CredentialRef, string>()
  private resolutionCount = 0

  get resolveCalls(): number {
    return this.resolutionCount
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    this.resolutionCount += 1
    const value = this.values.get(ref)
    return value === undefined ? undefined : { value, source: 'test' }
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: this.values.has(ref), source: this.values.has(ref) ? 'test' : undefined, writable: true }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
  }

  async unset(ref: CredentialRef): Promise<void> {
    this.values.delete(ref)
  }
}

function createContext(): Context {
  const ctx = new Context()
  new LlmRuntime(ctx)
  new MemoryCredentials(ctx)
  return ctx
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('OpenAI Codex Cordis plugin', () => {
  it('exports the Cordis plugin as the package default', () => {
    expect(defaultPlugin).toBe(openAiCodexPlugin)
  })

  it('rejects malformed configuration before registering any route or directory entry', async () => {
    const ctx = createContext()

    await expect(ctx.plugin(openAiCodexPlugin, {
      models: [{ id: 'codex-test', name: 'Codex Test', contextWindow: 0, maxTokens: 512 }],
    } as never)).rejects.toThrow('OpenAI Codex plugin configuration is invalid')
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('reports Hermes broker authentication with value-free status metadata', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      status: 'ok',
      upstream: 'openai-codex',
      authenticated: true,
    }), { headers: { 'content-type': 'application/json' } }))

    await expect(getOpenAiCodexStatus(fetcher)).resolves.toEqual({ configured: true, writable: false })
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:8645/health')
  })

  it('fails closed on malformed Hermes broker health metadata', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      authenticated: 'true',
      upstream: 'untrusted',
    }), { headers: { 'content-type': 'application/json' } }))

    await expect(getOpenAiCodexStatus(fetcher)).resolves.toEqual({ configured: false, writable: false })
  })

  it('wires a configured runtime through the registered Cordis route', async () => {
    const ctx = createContext()
    await ctx.credentials.set(OPENAI_CODEX_OAUTH, serializeOAuthState({
      version: 1,
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      refreshToken: '[REDACTED_REFRESH_TOKEN]',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }))
    await ctx.plugin(openAiCodexPlugin, {
      models: [{ id: 'codex-test', name: 'Codex Test', contextWindow: 16_384, maxTokens: 512 }],
      runtime: { createResponse: async () => ({ outputText: 'connected' }) },
    })

    await expect(collect(ctx.llm.stream({
      provider: OPENAI_CODEX_PROVIDER,
      model: 'codex-test',
      maxTokens: 10,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'plugin', plugin: 'test' } })],
    }))).resolves.toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'connected' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'connected' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('uses the local Hermes Codex broker by default without resolving a plugin OAuth credential', async () => {
    const ctx = createContext()
    const fetcher = vi.fn(async () => new Response([
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message"}}\n\n',
      'data: {"type":"response.output_text.delta","output_index":0,"delta":"through broker"}\n\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message"}}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetcher)
    try {
      await ctx.plugin(openAiCodexPlugin, {
        models: [{ id: 'codex-test', name: 'Codex Test', contextWindow: 16_384, maxTokens: 512 }],
      })

      await expect(collect(ctx.llm.stream({
        provider: OPENAI_CODEX_PROVIDER,
        model: 'codex-test',
        maxTokens: 10,
        messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'plugin', plugin: 'test' } })],
      }))).resolves.toEqual([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'through broker' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'through broker' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ])
      expect(fetcher).toHaveBeenCalledWith(
        'http://127.0.0.1:8645/v1/responses',
        expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer hermes-local-broker' }) }),
      )
      expect((ctx.credentials as unknown as MemoryCredentials).resolveCalls).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('refuses a route already owned by another adapter without declaring a duplicate setting', async () => {
    const ctx = createContext()
    ctx.llm.registerAdapter([OPENAI_CODEX_PROVIDER], new CodexTextAdapter({
      models: [],
      resolveSession: async () => { throw new Error('not used') },
      createResponse: async () => ({ outputText: '' }),
    }))

    await expect(ctx.plugin(openAiCodexPlugin, { models: [] })).rejects.toThrow(
      'openai-codex is already registered; remove llm-pi-ai.providers.openai-codex before enabling this plugin',
    )
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('registers the exclusive provider and a value-free configuration entry', async () => {
    const ctx = createContext()

    await ctx.plugin(openAiCodexPlugin, {
      models: [{ id: 'codex-test', name: 'Codex Test', contextWindow: 16_384, maxTokens: 512 }],
    })

    expect(ctx.llm.listProviders()).toEqual([{ id: OPENAI_CODEX_PROVIDER, name: 'OpenAI Codex' }])
    expect(ctx.llm.listConfigurableProviders()).toEqual([{
      provider: OPENAI_CODEX_PROVIDER,
      displayName: 'OpenAI Codex',
      settingsNs: 'openai-codex',
      settingsPath: [],
      declared: false,
    }])
    await expect(getOpenAiCodexStatus()).resolves.toEqual({ configured: false, writable: false })
  })
})
