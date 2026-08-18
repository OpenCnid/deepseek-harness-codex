import { describe, expect, it } from 'vitest'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
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

  it('forwards declared tools and streamed tool chunks through the adapter', async () => {
    let request: unknown
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => session,
      createResponse: async () => ({ outputText: '' }),
      streamResponse: async function* (input) {
        request = input
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: CallId('call-clock'), name: 'clock', argumentsDelta: '{"city":"Paris"}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('call-clock'), name: 'clock', arguments: '{"city":"Paris"}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      },
    })

    const chunks = await collect(adapter.stream({
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      messages: [],
      tools: [{ name: 'clock', description: 'Returns time.', parameters: { type: 'object' } }],
    }))

    expect(request).toEqual({
      model: 'gpt-5-codex',
      input: [],
      tools: [{ name: 'clock', description: 'Returns time.', parameters: { type: 'object' } }],
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      maxOutputTokens: 128_000,
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('serializes prior tool calls and tool results for a continuation', async () => {
    let request: unknown
    const callId = CallId('call-clock')
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => session,
      createResponse: async () => ({ outputText: '' }),
      streamResponse: async function* (input) {
        request = input
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })

    await collect(adapter.stream({
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      messages: [
        createAssistantMessage({
          content: [{ type: 'tool-call', id: callId, name: 'clock', arguments: '{"city":"Paris"}' }],
          source: { provider: 'openai-codex', model: 'gpt-5-codex' },
        }),
        createToolResultMessage({
          callId,
          content: [{ type: 'text', text: '10:00' }],
          isError: false,
        }),
      ],
    }))

    expect(request).toMatchObject({
      input: [
        { type: 'function_call', call_id: 'call-clock', name: 'clock', arguments: '{"city":"Paris"}' },
        { type: 'function_call_output', call_id: 'call-clock', output: '10:00' },
      ],
    })
  })

  it('rejects a tool result that does not match a prior assistant tool call before resolving credentials', async () => {
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
      messages: [
        createAssistantMessage({
          content: [{ type: 'tool-call', id: CallId('call-a'), name: 'clock', arguments: '{}' }],
          source: { provider: 'openai-codex', model: 'gpt-5-codex' },
        }),
        createToolResultMessage({
          callId: CallId('call-b'),
          content: [{ type: 'text', text: '10:00' }],
          isError: false,
        }),
      ],
    }))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(sessionResolved).toBe(false)
  })

  it('rejects an unresolved assistant tool call before resolving credentials', async () => {
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
      messages: [createAssistantMessage({
        content: [{ type: 'tool-call', id: CallId('call-a'), name: 'clock', arguments: '{}' }],
        source: { provider: 'openai-codex', model: 'gpt-5-codex' },
      })],
    }))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(sessionResolved).toBe(false)
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

  it('rejects tools without streaming support before resolving credentials', async () => {
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

  it('normalizes a resolved-session token accessor failure before building a request', async () => {
    const malformedSession = { version: 1, refreshToken: '[REDACTED_REFRESH_TOKEN]', expiresAt: '2030-01-01T00:00:00.000Z' }
    Object.defineProperty(malformedSession, 'accessToken', {
      get() {
        throw new Error('[REDACTED_ACCESS_TOKEN]')
      },
    })
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => malformedSession as never,
      createResponse: async () => ({ outputText: '' }),
    })

    await expect(collect(adapter.stream({ provider: 'openai-codex', model: 'gpt-5-codex', messages: [] })))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED', message: 'OpenAI Codex authentication required' })
  })

  it('normalizes a hostile streaming transport accessor before session resolution', async () => {
    let sessionResolved = false
    const config = {
      models,
      resolveSession: async () => {
        sessionResolved = true
        return session
      },
      createResponse: async () => ({ outputText: '' }),
      get streamResponse(): never {
        throw new Error('[REDACTED_CONFIG_SECRET]')
      },
    }
    const adapter = new CodexTextAdapter(config)

    await expect(collect(adapter.stream({ provider: 'openai-codex', model: 'gpt-5-codex', messages: [] })))
      .rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex response failed' })
    expect(sessionResolved).toBe(false)
  })

  it('rejects non-callable configured transports before resolving a session', async () => {
    for (const config of [
      { streamResponse: 0 as never, createResponse: async () => ({ outputText: '' }) },
      { createResponse: 0 as never },
    ]) {
      let sessionResolved = false
      const adapter = new CodexTextAdapter({
        models,
        resolveSession: async () => {
          sessionResolved = true
          return session
        },
        ...config,
      })

      await expect(collect(adapter.stream({ provider: 'openai-codex', model: 'gpt-5-codex', messages: [] })))
        .rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex response failed' })
      expect(sessionResolved).toBe(false)
    }
  })

  it('rejects hostile tool declarations before resolving a session', async () => {
    let sessionResolved = false
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => {
        sessionResolved = true
        return session
      },
      createResponse: async () => ({ outputText: '' }),
      streamResponse: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } } as const
      },
    })
    const options = {
      provider: 'openai-codex', model: 'gpt-5-codex', messages: [],
      tools: [{
        get name(): never { throw new Error('[REDACTED_TOOL_SECRET]') },
        description: 'desc', parameters: {},
      }],
    }

    await expect(collect(adapter.stream(options as never))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(sessionResolved).toBe(false)
  })

  it('normalizes a hostile caller signal accessor before resolving a session', async () => {
    let sessionResolved = false
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => {
        sessionResolved = true
        return session
      },
      createResponse: async () => ({ outputText: '' }),
    })
    const options = {
      provider: 'openai-codex', model: 'gpt-5-codex', messages: [],
      get signal(): never { throw new Error('[REDACTED_SIGNAL_SECRET]') },
    }

    await expect(collect(adapter.stream(options as never)))
      .rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex response failed' })
    expect(sessionResolved).toBe(false)
  })

  it('rejects a configured stream with a malformed terminal before forwarding it', async () => {
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => session,
      createResponse: async () => ({ outputText: '' }),
      streamResponse: async function* () {
        yield { type: 'finish' } as never
      },
    })

    await expect(collect(adapter.stream({ provider: 'openai-codex', model: 'gpt-5-codex', messages: [] })))
      .rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex response failed' })
  })

  it('does not call a tool-array map override before resolving a session', async () => {
    let sessionResolved = false
    const tools: any = [{
      get name() { throw new Error('tool getter detail') },
      description: 'safe',
      parameters: {},
    }]
    tools.map = () => Array.from({ length: 65 }, () => ({ name: 'bypass', description: 'bypass', parameters: {} }))
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => { sessionResolved = true; return session },
      createResponse: async () => ({ outputText: '' }),
      streamResponse: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as const },
    })

    await expect(async () => {
      for await (const _chunk of adapter.stream({ provider: 'openai-codex', model: 'gpt-5-codex', messages: [], tools })) undefined
    }).rejects.toMatchObject({ code: 'INVALID_REQUEST', message: 'OpenAI Codex tool declarations are invalid' })
    expect(sessionResolved).toBe(false)
  })

  it('uses one bounded tool count when a proxied Array changes length', async () => {
    let observedTools: readonly unknown[] | undefined
    let lengthReads = 0
    const backing = Array.from({ length: 65 }, () => ({ name: 'safe', description: 'safe', parameters: {} }))
    const tools = new Proxy(backing, {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads += 1
          return lengthReads === 1 ? 0 : 65
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => session,
      createResponse: async () => ({ outputText: '' }),
      streamResponse: async function* (request) {
        observedTools = request.tools
        yield { type: 'finish', reason: { kind: 'stop' } } as const
      },
    })

    await collect(adapter.stream({ provider: 'openai-codex', model: 'gpt-5-codex', messages: [], tools }))
    expect(observedTools).toBeUndefined()
  })

  it('rejects configured stream tool-call identity changes before block completion', async () => {
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => session,
      createResponse: async () => ({ outputText: '' }),
      streamResponse: async function* () {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' } as const
        yield { type: 'tool-call-delta', index: 0, id: CallId('call-a'), name: 'first', argumentsDelta: '{}' } as const
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('call-b'), name: 'second', arguments: '{}' } } as const
        yield { type: 'finish', reason: { kind: 'tool-calls' } } as const
      },
    })
    const chunks: StreamChunk[] = []

    await expect(async () => {
      for await (const chunk of adapter.stream({ provider: 'openai-codex', model: 'gpt-5-codex', messages: [] })) chunks.push(chunk)
    }).rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex response failed' })
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: CallId('call-a'), name: 'first', argumentsDelta: '{}' },
    ])
  })

  it('rejects a configured tool-call delta without a stable name', async () => {
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => session,
      createResponse: async () => ({ outputText: '' }),
      streamResponse: async function* () {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' } as const
        yield { type: 'tool-call-delta', index: 0, id: CallId('call-a'), argumentsDelta: '{}' } as unknown as StreamChunk
      },
    })
    const chunks: StreamChunk[] = []

    await expect(async () => {
      for await (const chunk of adapter.stream({ provider: 'openai-codex', model: 'gpt-5-codex', messages: [] })) chunks.push(chunk)
    }).rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex response failed' })
    expect(chunks).toEqual([{ type: 'block-start', index: 0, blockType: 'tool-call' }])
  })

  it('snapshots valid configured chunks and rejects incomplete terminal blocks', async () => {
    let blockTypeReads = 0
    const mutableStart = {
      type: 'block-start', index: 0,
      get blockType() { blockTypeReads += 1; return blockTypeReads === 1 ? 'text' : 'tool-call' },
    }
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => session,
      createResponse: async () => ({ outputText: '' }),
      streamResponse: async function* () {
        yield mutableStart as unknown as StreamChunk
        yield { type: 'block-end', index: 0, block: { type: 'text' } } as unknown as StreamChunk
      },
    })
    const chunks: StreamChunk[] = []

    await expect(async () => {
      for await (const chunk of adapter.stream({ provider: 'openai-codex', model: 'gpt-5-codex', messages: [] })) chunks.push(chunk)
    }).rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex response failed' })
    expect(chunks).toEqual([{ type: 'block-start', index: 0, blockType: 'text' }])
  })

  it('suppresses configured-stream chunks computed after caller abort', async () => {
    const controller = new AbortController()
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => session,
      createResponse: async () => ({ outputText: '' }),
      streamResponse: async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' } as const
        yield { type: 'text-delta', index: 0, text: 'first' } as const
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'first' } } as const
        yield { type: 'finish', reason: { kind: 'stop' } } as const
      },
    })
    const stream = adapter.stream({ provider: 'openai-codex', model: 'gpt-5-codex', messages: [], signal: controller.signal })[Symbol.asyncIterator]()

    expect(await stream.next()).toEqual({ done: false, value: { type: 'block-start', index: 0, blockType: 'text' } })
    controller.abort()
    await expect(stream.next()).rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex response failed' })
  })

  it('rejects a configured stream that emits after finish', async () => {
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => session,
      createResponse: async () => ({ outputText: '' }),
      streamResponse: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } } as const
        yield { type: 'text-delta', index: 0, text: 'late' } as const
      },
    })
    const chunks: StreamChunk[] = []

    await expect(async () => {
      for await (const chunk of adapter.stream({ provider: 'openai-codex', model: 'gpt-5-codex', messages: [] })) chunks.push(chunk)
    }).rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex response failed' })
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('wraps response-transport failures without exposing the session token', async () => {
    const nonStreamingAdapter = new CodexTextAdapter({
      models,
      resolveSession: async () => session,
      createResponse: async input => {
        throw new Error(input.accessToken)
      },
    })
    const streamingAdapter = new CodexTextAdapter({
      models,
      resolveSession: async () => session,
      createResponse: async () => ({ outputText: '' }),
      streamResponse: async function* (input) {
        throw new Error(input.accessToken)
      },
    })

    await expect(collect(nonStreamingAdapter.stream({ provider: 'openai-codex', model: 'gpt-5-codex', messages: [] })))
      .rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex response failed' })
    await expect(collect(streamingAdapter.stream({
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      messages: [],
      tools: [{ name: 'clock', description: 'Returns time.', parameters: { type: 'object' } }],
    }))).rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex response failed' })
  })

  it('normalizes callback result fields before yielding any response chunks', async () => {
    const malformed: { outputText: string; usage?: unknown } = { outputText: 'partial' }
    Object.defineProperty(malformed, 'usage', {
      get() {
        throw new Error('[REDACTED_ACCESS_TOKEN]')
      },
    })
    const adapter = new CodexTextAdapter({
      models,
      resolveSession: async () => session,
      createResponse: async () => malformed as never,
    })
    const chunks: StreamChunk[] = []

    await expect(async () => {
      for await (const chunk of adapter.stream({ provider: 'openai-codex', model: 'gpt-5-codex', messages: [] })) chunks.push(chunk)
    }).rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex response failed' })
    expect(chunks).toEqual([])
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
