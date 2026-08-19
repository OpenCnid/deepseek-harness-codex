import { describe, expect, it } from 'vitest'
import { createResponsesTextTransport } from '../src/index.ts'

describe('Codex Responses text transport', () => {
  it('sends the standard Responses payload with OAuth bearer authorization', async () => {
    const controller = new AbortController()
    let url: string | undefined
    let init: RequestInit | undefined
    const transport = createResponsesTextTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async (nextUrl, nextInit) => {
        url = String(nextUrl)
        init = nextInit
        return new Response(JSON.stringify({
          status: 'completed',
          output_text: 'hello',
          usage: { input_tokens: 3, output_tokens: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })

    const result = await transport({
      model: 'gpt-5-codex',
      instructions: 'Be helpful.',
      input: [{ role: 'user', content: 'Hi' }],
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      maxOutputTokens: 7,
      signal: controller.signal,
    })

    expect(url).toBe('https://responses.example.test/v1/responses')
    expect(init?.method).toBe('POST')
    expect(init?.signal).toBe(controller.signal)
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer [REDACTED_ACCESS_TOKEN]',
      'content-type': 'application/json',
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'gpt-5-codex',
      instructions: 'Be helpful.',
      input: [{ role: 'user', content: 'Hi' }],
      max_output_tokens: 7,
      stream: false,
    })
    expect(result).toEqual({ outputText: 'hello', usage: { inputTokens: 3, outputTokens: 1 } })
  })

  it('reads raw API output-message text when no convenience output_text field is present', async () => {
    const transport = createResponsesTextTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(JSON.stringify({
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello' }],
        }],
        usage: { input_tokens: 3, output_tokens: 1 },
      }), { status: 200 }),
    })

    await expect(transport({
      model: 'gpt-5-codex',
      input: [{ role: 'user', content: 'Hi' }],
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      maxOutputTokens: 7,
    })).resolves.toEqual({ outputText: 'hello', usage: { inputTokens: 3, outputTokens: 1 } })
  })

  it('maps a max-output-token incomplete response to a max-tokens finish reason', async () => {
    const transport = createResponsesTextTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(JSON.stringify({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output_text: 'partial',
      }), { status: 200 }),
    })

    await expect(transport({
      model: 'gpt-5-codex',
      input: [{ role: 'user', content: 'Hi' }],
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      maxOutputTokens: 7,
    })).resolves.toEqual({ outputText: 'partial', finishReason: 'max-tokens' })
  })

  it('rejects a successful response without a confirmed completion status', async () => {
    const transport = createResponsesTextTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response(JSON.stringify({ output_text: 'partial' }), { status: 200 }),
    })

    await expect(transport({
      model: 'gpt-5-codex',
      input: [],
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      maxOutputTokens: 7,
    })).rejects.toMatchObject({ code: 'INCOMPLETE_RESPONSE' })
  })

  it('defensively rejects a missing output cap from an untyped caller', async () => {
    const transport = createResponsesTextTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response('{}', { status: 200 }),
    })

    await expect(transport({
      model: 'gpt-5-codex',
      input: [],
      accessToken: '[REDACTED_ACCESS_TOKEN]',
    } as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('cancels a non-success response body before mapping its public error', async () => {
    let cancelled = false
    const transport = createResponsesTextTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => ({
        ok: false,
        status: 502,
        body: new ReadableStream<Uint8Array>({
          cancel() { cancelled = true },
        }),
      } as unknown as Response),
    })

    await expect(transport({
      model: 'gpt-5-codex',
      input: [],
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      maxOutputTokens: 7,
    })).rejects.toMatchObject({ code: 'HTTP_502' })
    expect(cancelled).toBe(true)
  })

  it('rejects an oversized successful response before JSON parsing', async () => {
    const transport = createResponsesTextTransport({
      url: 'https://responses.example.test/v1/responses',
      fetch: async () => new Response('{"status":"completed","output_text":"ignored"}', {
        status: 200,
        headers: { 'content-length': String(1024 * 1024 + 1) },
      }),
    })

    await expect(transport({
      model: 'gpt-5-codex',
      input: [],
      accessToken: '[REDACTED_ACCESS_TOKEN]',
      maxOutputTokens: 7,
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})
