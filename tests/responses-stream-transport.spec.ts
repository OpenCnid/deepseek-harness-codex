import { LlmError } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { createResponsesStreamTransport } from '../src/index.ts'

function sseBody(events: readonly object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const payload = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload.slice(0, 37)))
      controller.enqueue(encoder.encode(payload.slice(37)))
      controller.close()
    },
  })
}

describe('Codex Responses stream transport', () => {
  it('maps an ordered text SSE response to legal Harness chunks', async () => {
    let init: RequestInit | undefined
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async (_url, nextInit) => {
        init = nextInit
        return new Response(sseBody([
          { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
          { type: 'response.output_text.delta', output_index: 0, delta: 'Hello' },
          { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
          { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 1 } } },
        ]), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      },
    })

    const chunks = []
    for await (const chunk of transport({
      model: 'gpt-5-codex',
      instructions: 'Be helpful.',
      input: [{ role: 'user', content: 'Hi' }],
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      maxOutputTokens: 7,
    })) chunks.push(chunk)

    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'gpt-5-codex',
      instructions: 'Be helpful.',
      input: [{ role: 'user', content: 'Hi' }],
      max_output_tokens: 7,
      stream: true,
    })
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hello' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('parses an SSE frame delimiter split across transport chunks', async () => {
    const payload = `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\r\n\r\n`
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload.slice(0, -1)))
        controller.enqueue(encoder.encode(payload.slice(-1)))
        controller.close()
      },
    })
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })

    const chunks = []
    for await (const chunk of transport({
      model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
    })) chunks.push(chunk)
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('parses CR-only SSE line endings', async () => {
    const payload = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
      { type: 'response.completed', response: { status: 'completed' } },
    ].map(event => `data: ${JSON.stringify(event)}\r\r`).join('')
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload))
          controller.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    const chunks = []

    for await (const chunk of transport({
      model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
    })) chunks.push(chunk)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('rejects invalid UTF-8 before yielding parsed stream content', async () => {
    const payload = `data: ${JSON.stringify({
      type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-a', name: 'clock', arguments: '{"city":"X"}' },
    })}\n\n`
    const bytes = new TextEncoder().encode(payload)
    const replacementIndex = bytes.indexOf('X'.charCodeAt(0))
    bytes[replacementIndex] = 0xff
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    const chunks = []

    await expect(async () => {
      for await (const chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) chunks.push(chunk)
    }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect(chunks).toEqual([])
  })

  it('rejects an unterminated terminal SSE record at EOF', async () => {
    const payload = `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}`
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload))
          controller.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    const chunks = []

    await expect(async () => {
      for await (const chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) chunks.push(chunk)
    }).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
    expect(chunks).toEqual([])
  })

  it('wraps reader failures without exposing callback-derived LlmError detail', async () => {
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new LlmError('[REDACTED_ACCESS_TOKEN]', 'TRANSPORT'))
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })

    await expect(async () => {
      for await (const _chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) undefined
    }).rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex Responses stream read failed' })
  })

  it('wraps hostile reader result accessors without exposing LlmError detail', async () => {
    const reader = {
      read: async () => ({
        get done(): boolean {
          throw new LlmError('[REDACTED_ACCESS_TOKEN]', 'TRANSPORT')
        },
      }),
      cancel: async () => undefined,
      releaseLock: () => undefined,
    }
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => ({ ok: true, body: { getReader: () => reader } }) as unknown as Response,
    })

    await expect(async () => {
      for await (const _chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) undefined
    }).rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex Responses stream read failed' })
  })

  it('rejects a non-boolean reader completion discriminator', async () => {
    const reader = {
      read: async () => ({ done: 0, value: new Uint8Array() }),
      cancel: async () => undefined,
      releaseLock: () => undefined,
    }
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => ({ ok: true, body: { getReader: () => reader } }) as unknown as Response,
    })

    await expect(async () => {
      for await (const _chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) undefined
    }).rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex Responses stream read failed' })
  })

  it('uses the typed-array intrinsic rather than a hostile byteLength accessor', async () => {
    const value = new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n')
    Object.defineProperty(value, 'byteLength', {
      get() {
        throw new LlmError('[REDACTED_ACCESS_TOKEN]', 'TRANSPORT')
      },
    })
    let reads = 0
    const reader = {
      read: async () => reads++ === 0 ? { done: false, value } : { done: true, value: undefined },
      cancel: async () => undefined,
      releaseLock: () => undefined,
    }
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => ({ ok: true, body: { getReader: () => reader } }) as unknown as Response,
    })

    const chunks = []
    for await (const chunk of transport({
      model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
    })) chunks.push(chunk)
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('wraps an injected fetch accessor failure without exposing callback detail', async () => {
    const options = {
      url: 'https://responses.example.test/v1/responses',
      get fetch(): typeof fetch {
        throw new Error('[REDACTED_ACCESS_TOKEN]')
      },
    }
    const transport = createResponsesStreamTransport(options)

    await expect(async () => {
      for await (const _chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) undefined
    }).rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex Responses stream request failed' })
  })

  it('wraps injected response accessor failures without exposing callback detail', async () => {
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => ({
        get ok(): boolean {
          throw new LlmError('[REDACTED_ACCESS_TOKEN]', 'TRANSPORT')
        },
      }) as Response,
    })

    await expect(async () => {
      for await (const _chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) undefined
    }).rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex Responses stream request failed' })
  })

  it('rejects a non-boolean response success discriminator', async () => {
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => ({ ok: 1 }) as unknown as Response,
    })

    await expect(async () => {
      for await (const _chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) undefined
    }).rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex Responses stream request failed' })
  })

  it('wraps injected stream-body accessor failures without exposing callback detail', async () => {
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => ({
        ok: true,
        get body(): ReadableStream<Uint8Array> {
          throw new Error('[REDACTED_ACCESS_TOKEN]')
        },
      }) as Response,
    })

    await expect(async () => {
      for await (const _chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) undefined
    }).rejects.toMatchObject({ code: 'TRANSPORT', message: 'OpenAI Codex Responses stream body failed' })
  })

  it('cancels the response body when the Harness consumer stops reading', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
          type: 'response.output_item.added', output_index: 0, item: { type: 'message' },
        })}\n\n`))
      },
      cancel() {
        cancelled = true
      },
    })
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    const iterator = transport({
      model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
    })[Symbol.asyncIterator]()

    expect((await iterator.next()).value).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    await iterator.return?.()
    expect(cancelled).toBe(true)
  })

  it('contains hostile abort-listener cleanup errors after a terminal event', async () => {
    const signal = {
      aborted: false,
      addEventListener: () => undefined,
      removeEventListener: () => {
        throw new Error('[REDACTED_ACCESS_TOKEN]')
      },
    } as unknown as AbortSignal
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(sseBody([
        { type: 'response.completed', response: { status: 'completed' } },
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })

    const chunks = []
    for await (const chunk of transport({
      model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7, signal,
    })) chunks.push(chunk)
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('cancels an open response body when the caller aborts', async () => {
    const controller = new AbortController()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
          type: 'response.output_item.added', output_index: 0, item: { type: 'message' },
        })}\n\n`))
      },
      cancel() {
        cancelled = true
      },
    })
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    const iterator = transport({
      model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7, signal: controller.signal,
    })[Symbol.asyncIterator]()

    try {
      expect((await iterator.next()).value).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
      controller.abort()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(cancelled).toBe(true)
      await expect(iterator.next()).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
    } finally {
      await iterator.return?.()
    }
  })

  it('does not wait for an untrusted reader cancellation promise after abort', async () => {
    const controller = new AbortController()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
          type: 'response.output_item.added', output_index: 0, item: { type: 'message' },
        })}\n\n`))
      },
      cancel() {
        cancelled = true
        return new Promise<void>(() => undefined)
      },
    })
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    const iterator = transport({
      model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7, signal: controller.signal,
    })[Symbol.asyncIterator]()

    expect((await iterator.next()).value).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    controller.abort()
    const result = await Promise.race([
      iterator.next().then(() => 'resolved', error => error),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 100)),
    ])
    expect(cancelled).toBe(true)
    expect(result).toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('does not emit records buffered before a caller abort', async () => {
    const controller = new AbortController()
    const payload = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'late' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
      { type: 'response.completed', response: { status: 'completed' } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new TextEncoder().encode(payload))
          streamController.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    const iterator = transport({
      model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7, signal: controller.signal,
    })[Symbol.asyncIterator]()

    try {
      expect((await iterator.next()).value).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
      controller.abort()
      await expect(iterator.next()).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
    } finally {
      await iterator.return?.()
    }
  })

  it('does not emit a buffered block-end after aborting a multi-chunk tool completion', async () => {
    const controller = new AbortController()
    const payload = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-a', name: 'clock' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call-a', name: 'clock', arguments: '{}' } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new TextEncoder().encode(payload))
          streamController.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    const iterator = transport({
      model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7, signal: controller.signal,
    })[Symbol.asyncIterator]()

    try {
      expect((await iterator.next()).value).toEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
      expect((await iterator.next()).value).toEqual({ type: 'tool-call-delta', index: 0, id: 'call-a', name: 'clock', argumentsDelta: '{}' })
      controller.abort()
      await expect(iterator.next()).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
    } finally {
      await iterator.return?.()
    }
  })

  it('rejects an unterminated SSE frame before it can exceed the buffer limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577))
        controller.close()
      },
    })
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })

    await expect(async () => {
      for await (const _chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) undefined
    }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('rejects an oversized transport chunk before decoding it', async () => {
    const decode = vi.spyOn(TextDecoder.prototype, 'decode')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4_194_305))
        controller.close()
      },
    })
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })

    try {
      await expect(async () => {
        for await (const _chunk of transport({
          model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
        })) undefined
      }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
      expect(decode).not.toHaveBeenCalled()
    } finally {
      decode.mockRestore()
    }
  })

  it('charges retained tool metadata against the aggregate output limit', async () => {
    const encoder = new TextEncoder()
    const events = Array.from({ length: 5 }, (_, index) => ({
      type: 'response.output_item.added',
      output_index: index,
      item: { type: 'function_call', call_id: `call-${index}`, name: 'x'.repeat(900_000) },
    }))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        controller.close()
      },
    })
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })

    await expect(async () => {
      for await (const _chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) undefined
    }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('cancels a non-OK response body before reporting the status', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(body, { status: 503, statusText: 'unavailable' }),
    })

    await expect(async () => {
      for await (const _chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) undefined
    }).rejects.toMatchObject({ code: 'HTTP_503' })
    expect(cancelled).toBe(true)
  })

  it('rejects a terminal event whose event type conflicts with its response status', async () => {
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(sseBody([
        { type: 'response.incomplete', response: { status: 'completed' } },
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })

    await expect(async () => {
      for await (const _chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) undefined
    }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('rejects a malformed terminal event before yielding its usage', async () => {
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(sseBody([
        { type: 'response.completed', response: { status: 'failed', usage: { input_tokens: 1, output_tokens: 1 } } },
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    const chunks = []

    await expect(async () => {
      for await (const chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) chunks.push(chunk)
    }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect(chunks).toEqual([])
  })

  it('maps a confirmed max-output incomplete terminal event to Harness max-tokens', async () => {
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(sseBody([
        { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })

    const chunks = []
    for await (const chunk of transport({
      model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
    })) chunks.push(chunk)
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'max-tokens' } }])
  })

  it('accepts multiple sub-limit SSE frames delivered in one network chunk', async () => {
    const payload = [
      { type: 'extension.ignored', padding: 'x'.repeat(600_000) },
      { type: 'extension.ignored', padding: 'x'.repeat(600_000) },
      { type: 'response.completed', response: { status: 'completed' } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      },
    })
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })

    const chunks = []
    for await (const chunk of transport({
      model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
    })) chunks.push(chunk)
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })

  it('rejects an open text block that exceeds the retained-output limit', async () => {
    const encoder = new TextEncoder()
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
      ...Array.from({ length: 9 }, () => ({ type: 'response.output_text.delta', output_index: 0, delta: 'x'.repeat(131_072) })),
    ]
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        controller.close()
      },
    })
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })

    await expect(async () => {
      for await (const _chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) undefined
    }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('rejects a completed tool call whose identity changes after block start', async () => {
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(sseBody([
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-a', name: 'first', arguments: '{}' } },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call-b', name: 'second', arguments: '{}' } },
        { type: 'response.completed', response: { status: 'completed' } },
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })

    await expect(async () => {
      for await (const _chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) undefined
    }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('rejects duplicate function-call IDs across output blocks', async () => {
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(sseBody([
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-same', name: 'clock' } },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call-same', name: 'clock', arguments: '{}' } },
        { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call-same', name: 'clock' } },
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })

    await expect(async () => {
      for await (const _chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) undefined
    }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('rejects streams that exceed the retained tool-call identity limit', async () => {
    const events: Record<string, unknown>[] = []
    for (let index = 0; index <= 64; index += 1) {
      const callId = `call-${index}`
      events.push(
        { type: 'response.output_item.added', output_index: index, item: { type: 'function_call', call_id: callId, name: 'clock' } },
        { type: 'response.output_item.done', output_index: index, item: { type: 'function_call', call_id: callId, name: 'clock', arguments: '{}' } },
      )
    }
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(sseBody(events), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })

    await expect(async () => {
      for await (const _chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) undefined
    }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('charges closed tool-call identities against the aggregate retained-output limit', async () => {
    const events: Record<string, unknown>[] = []
    for (let index = 0; index < 5; index += 1) {
      const callId = `call-${index}-${'x'.repeat(900_000)}`
      events.push(
        { type: 'response.output_item.added', output_index: index, item: { type: 'function_call', call_id: callId, name: 'clock' } },
        { type: 'response.output_item.done', output_index: index, item: { type: 'function_call', call_id: callId, name: 'clock', arguments: '{}' } },
      )
    }
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
          controller.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })

    await expect(async () => {
      for await (const _chunk of transport({
        model: 'gpt-5-codex', input: [], accessToken: '[REDACTED_ACCESS_TOKEN]', maxOutputTokens: 7,
      })) undefined
    }).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('streams a function call and serializes declared tools', async () => {
    let init: RequestInit | undefined
    const transport = createResponsesStreamTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async (_url, nextInit) => {
        init = nextInit
        return new Response(sseBody([
          { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-clock', name: 'clock' } },
          { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city":"' },
          { type: 'response.function_call_arguments.delta', output_index: 0, delta: 'Paris"}' },
          { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call-clock', name: 'clock', arguments: '{"city":"Paris"}' } },
          { type: 'response.completed', response: { status: 'completed' } },
        ]), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      },
    })

    const chunks = []
    for await (const chunk of transport({
      model: 'gpt-5-codex',
      input: [],
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      maxOutputTokens: 7,
      tools: [{ name: 'clock', description: 'Returns time.', parameters: { type: 'object' } }],
    } as never)) chunks.push(chunk)

    expect(JSON.parse(String(init?.body))).toMatchObject({
      tools: [{ type: 'function', name: 'clock', description: 'Returns time.', parameters: { type: 'object' } }],
    })
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call-clock', name: 'clock', argumentsDelta: '{"city":"' },
      { type: 'tool-call-delta', index: 0, id: 'call-clock', name: 'clock', argumentsDelta: 'Paris"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-clock', name: 'clock', arguments: '{"city":"Paris"}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })
})
