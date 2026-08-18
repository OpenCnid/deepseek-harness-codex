import { describe, expect, it } from 'vitest'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { CodexTextAdapter } from '../src/index.ts'

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const session = {
  version: 1 as const,
  accessToken: '[REDACTED_ACCESS_TOKEN]',
  refreshToken: '[REDACTED_REFRESH_TOKEN]',
  expiresAt: '2030-01-01T00:00:00.000Z',
}

const models = [{ id: 'gpt-5-codex', name: 'GPT-5 Codex', contextWindow: 400_000, maxTokens: 128_000 }]

describe('Codex text adapter', () => {
  it('maps one text response into legal Harness chunks', async () => {
    let request: unknown
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => session,
      createResponse: async input => {
        request = input
        return { outputText: 'hello', usage: { inputTokens: 3, outputTokens: 1 } }
      },
    })

    const chunks = await collect(adapter.stream({
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      maxTokens: 7,
      system: 'Be helpful.',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))

    expect(request).toEqual({
      model: 'gpt-5-codex',
      instructions: 'Be helpful.',
      input: [{ role: 'user', content: 'Hi' }],
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      maxOutputTokens: 7,
    })
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('uses the configured model cap when the host supplies none', async () => {
    let maxOutputTokens: number | undefined
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => session,
      createResponse: async input => {
        maxOutputTokens = input.maxOutputTokens
        return { outputText: '' }
      },
    })

    await collect(adapter.stream({ provider: 'openai-codex', model: 'gpt-5-codex', messages: [] }))

    expect(maxOutputTokens).toBe(128_000)
  })

  it('rejects an unconfigured model without an explicit output cap before resolving credentials', async () => {
    let sessionResolved = false
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => {
        sessionResolved = true
        return session
      },
      createResponse: async () => ({ outputText: '' }),
    })

    await expect(collect(adapter.stream({ provider: 'openai-codex', model: 'unknown', messages: [] })))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(sessionResolved).toBe(false)
  })

  it('rejects tool schemas before resolving credentials in the text-only slice', async () => {
    let sessionResolved = false
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => {
        sessionResolved = true
        return session
      },
      createResponse: async () => ({ outputText: '' }),
    })

    await expect(collect(adapter.stream({
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      messages: [],
      tools: [{ name: 'clock', description: 'Returns time.', parameters: {} }],
    }))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(sessionResolved).toBe(false)
  })

  it('wraps credential-resolution failures without leaking their detail', async () => {
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => {
        throw new Error('[REDACTED_SESSION_FAILURE]')
      },
      createResponse: async () => ({ outputText: '' }),
    })

    await expect(collect(adapter.stream({ provider: 'openai-codex', model: 'gpt-5-codex', messages: [] })))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED', message: 'OpenAI Codex authentication required' })
    await expect(collect(adapter.stream({ provider: 'openai-codex', model: 'gpt-5-codex', messages: [] })))
      .rejects.not.toThrow('[REDACTED_SESSION_FAILURE]')
  })

  it('rejects malformed text blocks before resolving credentials', async () => {
    let sessionResolved = false
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => {
        sessionResolved = true
        return session
      },
      createResponse: async () => ({ outputText: '' }),
    })

    await expect(collect(adapter.stream({
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      messages: [{ role: 'user', content: [{ type: 'text', text: 1 }] }] as never,
    }))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(sessionResolved).toBe(false)
  })

  it('maps output-cap completion to a max-tokens finish', async () => {
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => session,
      createResponse: async () => ({ outputText: 'partial', finishReason: 'max-tokens' }),
    })

    const chunks = await collect(adapter.stream({ provider: 'openai-codex', model: 'gpt-5-codex', messages: [] }))

    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('exposes configured model metadata for the exclusive provider route', async () => {
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => session,
      createResponse: async () => ({ outputText: '' }),
    })

    expect(adapter.providerInfo('openai-codex')).toEqual({ id: 'openai-codex', name: 'OpenAI Codex' })
    expect(await adapter.listModels('openai-codex')).toEqual([{
      provider: 'openai-codex',
      id: 'gpt-5-codex',
      name: 'GPT-5 Codex',
      inputModalities: ['text'],
    }])
    expect(await adapter.resolveModel('openai-codex', 'gpt-5-codex')).toMatchObject({
      provider: 'openai-codex',
      id: 'gpt-5-codex',
      context: { contextWindow: 400_000 },
      defaultMaxTokens: 128_000,
    })
  })

  it('forwards the caller cancellation signal to the response transport', async () => {
    const controller = new AbortController()
    let observed: AbortSignal | undefined
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => session,
      createResponse: async input => {
        observed = input.signal
        return { outputText: '' }
      },
    })

    await collect(adapter.stream({
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      messages: [],
      signal: controller.signal,
    }))

    expect(observed).toBe(controller.signal)
  })
})
