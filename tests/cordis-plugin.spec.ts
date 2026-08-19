import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { LlmRuntime, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { CodexTextAdapter } from '../src/adapter.ts'
import { serializeOAuthState } from '../src/auth/state.ts'
import defaultPlugin, {
  OPENAI_CODEX_PROVIDER,
  createAes256GcmSessionCipher,
  createScopedOpenAiCodexOAuthRef,
  openAiCodexPlugin,
} from '../src/index.ts'

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


  it('wires an encrypted authorized runtime seam through the registered Cordis route', async () => {
    const ctx = createContext()
    const accountScope = '[REDACTED_ACCOUNT_SCOPE]'
    const cipher = createAes256GcmSessionCipher(new Uint8Array(32).fill(6))
    const credential = createScopedOpenAiCodexOAuthRef(accountScope)
    await ctx.credentials.set(credential, cipher.seal(serializeOAuthState({
      version: 1,
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      refreshToken: '[REDACTED_REFRESH_TOKEN]',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }), String(credential)))
    await ctx.plugin(openAiCodexPlugin, {
      models: [{ id: 'codex-test', name: 'Codex Test', contextWindow: 16_384, maxTokens: 512 }],
      runtime: {
        authorizedOAuth: () => ({
          client: {
            authorizationEndpoint: 'https://auth.example.test/authorize',
            tokenEndpoint: 'https://auth.example.test/token',
            deviceAuthorizationEndpoint: 'https://auth.example.test/device',
            responsesUrl: 'https://responses.example.test/v1/responses',
            clientId: '[REDACTED_CLIENT_ID]',
            redirectUri: 'http://127.0.0.1:17890/callback',
            scopes: ['[REDACTED_SCOPE]'],
          },
          accountScope,
          encryptionKey: new Uint8Array(32).fill(6),
          transport: { createResponse: async () => ({ outputText: 'connected' }) },
        }),
      },
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

  it('wires an authorized runtime through the plugin-owned encrypted session and direct Responses stream', async () => {
    const ctx = createContext()
    let controller: import('../src/index.ts').OpenAiCodexOAuthController | undefined
    let responseInit: RequestInit | undefined
    const sseBody = (events: readonly object[]): ReadableStream<Uint8Array> => new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')))
        stream.close()
      },
    })
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url) === 'https://auth.example.test/token') {
        return new Response(JSON.stringify({
          access_token: '[REDACTED_ACCESS_TOKEN]',
          refresh_token: '[REDACTED_REFRESH_TOKEN]',
          expires_in: 3600,
        }), { status: 200 })
      }
      if (String(url) === 'https://responses.example.test/v1/responses') {
        responseInit = init
        return new Response(sseBody([
          { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
          { type: 'response.output_text.delta', output_index: 0, delta: 'connected' },
          { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
          { type: 'response.completed', response: { status: 'completed' } },
        ]), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error('unexpected test request')
    }
    await ctx.plugin(openAiCodexPlugin, {
      models: [{ id: 'codex-test', name: 'Codex Test', contextWindow: 16_384, maxTokens: 512 }],
      runtime: {
        authorizedOAuth: () => ({
          client: {
            authorizationEndpoint: 'https://auth.example.test/authorize',
            tokenEndpoint: 'https://auth.example.test/token',
            deviceAuthorizationEndpoint: 'https://auth.example.test/device',
            responsesUrl: 'https://responses.example.test/v1/responses',
            clientId: '[REDACTED_CLIENT_ID]',
            redirectUri: 'http://127.0.0.1:17890/callback',
            scopes: ['[REDACTED_SCOPE]'],
            fetch: fetcher,
            now: () => new Date('2030-01-01T00:00:00.000Z'),
          },
          accountScope: '[REDACTED_ACCOUNT_SCOPE]',
          encryptionKey: new Uint8Array(32).fill(5),
          onController: value => { controller = value },
        }),
      },
    })
    expect(controller).toBeDefined()
    const login = controller!.startBrowserLogin()
    const state = new URL(login.authorizationUrl).searchParams.get('state')
    await expect(login.complete(`http://127.0.0.1:17890/callback?code=[REDACTED_AUTHORIZATION_CODE]&state=${state}`)).resolves.toEqual({
      authenticated: true,
      expiresAt: '2030-01-01T01:00:00.000Z',
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
    expect(responseInit?.headers).toMatchObject({ authorization: 'Bearer [REDACTED_ACCESS_TOKEN]' })
    expect(JSON.parse(String(responseInit?.body))).toMatchObject({ model: 'codex-test', stream: true })
  })

  it('rejects generic transport callbacks that bypass an authorized encrypted runtime', async () => {
    const ctx = createContext()
    await expect(ctx.plugin(openAiCodexPlugin, {
      models: [{ id: 'codex-test', name: 'Codex Test', contextWindow: 16_384, maxTokens: 512 }],
      runtime: {
        createResponse: async () => ({ outputText: 'not-authorized' }),
      },
    } as never)).rejects.toThrow('OpenAI Codex plugin configuration is invalid')
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('rejects a declarative authorized runtime in place of the programmatic factory', async () => {
    const ctx = createContext()
    await expect(ctx.plugin(openAiCodexPlugin, {
      models: [{ id: 'codex-test', name: 'Codex Test', contextWindow: 16_384, maxTokens: 512 }],
      runtime: { authorizedOAuth: {} },
    } as never)).rejects.toThrow('OpenAI Codex plugin configuration is invalid')
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('requires a plugin-owned OAuth session by default without calling a broker', async () => {
    const ctx = createContext()
    const fetcher = vi.fn()
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
      }))).resolves.toEqual([{
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: 'AUTH_REQUIRED', message: 'OpenAI Codex authentication required' },
        },
      }])
      expect(fetcher).not.toHaveBeenCalled()
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
  })
})
