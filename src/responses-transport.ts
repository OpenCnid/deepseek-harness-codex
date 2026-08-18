import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { CodexTextRequest, CodexTextResponse } from './adapter.js'

export interface ResponsesTextTransportOptions {
  url: string
  fetch?: typeof fetch
}

interface WireUsage {
  input_tokens?: unknown
  output_tokens?: unknown
}

interface WireOutputText {
  type?: unknown
  text?: unknown
}

interface WireOutputMessage {
  type?: unknown
  content?: unknown
}

interface WireIncompleteDetails {
  reason?: unknown
}

interface WireResponse {
  output_text?: unknown
  output?: unknown
  usage?: WireUsage
  status?: unknown
  incomplete_details?: WireIncompleteDetails
}

function outputText(value: WireResponse): string | undefined {
  if (typeof value.output_text === 'string') return value.output_text
  if (!Array.isArray(value.output)) return undefined
  const text: string[] = []
  for (const item of value.output) {
    if (item === null || typeof item !== 'object') continue
    const message = item as WireOutputMessage
    if (message.type !== 'message' || !Array.isArray(message.content)) continue
    for (const content of message.content) {
      if (content === null || typeof content !== 'object') continue
      const block = content as WireOutputText
      if (block.type === 'output_text' && typeof block.text === 'string') text.push(block.text)
    }
  }
  return text.length === 0 ? undefined : text.join('')
}

function isOutputCap(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function finishReason(value: WireResponse): CodexTextResponse['finishReason'] {
  if (value.status === 'completed') return undefined
  if (value.status === 'incomplete' && value.incomplete_details?.reason === 'max_output_tokens') {
    return 'max-tokens'
  }
  throw new LlmError('OpenAI Codex Responses did not complete', 'INCOMPLETE_RESPONSE')
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function parseResponse(value: unknown): CodexTextResponse {
  if (value === null || typeof value !== 'object') {
    throw new LlmError('OpenAI Codex Responses returned an invalid response', 'INVALID_RESPONSE')
  }
  const response = value as WireResponse
  const text = outputText(response)
  if (text === undefined) {
    throw new LlmError('OpenAI Codex Responses returned no text output', 'INVALID_RESPONSE')
  }
  const inputTokens = tokenCount(response.usage?.input_tokens)
  const outputTokens = tokenCount(response.usage?.output_tokens)
  const reason = finishReason(response)
  return {
    outputText: text,
    ...reason === undefined ? {} : { finishReason: reason },
    ...inputTokens === undefined || outputTokens === undefined
      ? {}
      : { usage: { inputTokens, outputTokens } },
  }
}

export function createResponsesTextTransport(options: ResponsesTextTransportOptions): (input: CodexTextRequest) => Promise<CodexTextResponse> {
  const fetcher = options.fetch ?? fetch
  return async input => {
    if (!isOutputCap(input.maxOutputTokens)) {
      throw new LlmError('OpenAI Codex requires a positive output token cap', 'INVALID_REQUEST')
    }
    let response: Response
    try {
      response = await fetcher(options.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          'content-type': 'application/json',
          ...attributionHeaders(),
        },
        body: JSON.stringify({
          model: input.model,
          ...input.instructions === undefined ? {} : { instructions: input.instructions },
          input: input.input,
          max_output_tokens: input.maxOutputTokens,
          stream: false,
        }),
        ...input.signal === undefined ? {} : { signal: input.signal },
      })
    } catch (_error) {
      throw new LlmError('OpenAI Codex Responses request failed', 'TRANSPORT')
    }
    if (!response.ok) {
      throw new LlmError(`OpenAI Codex Responses request failed (HTTP ${response.status})`, `HTTP_${response.status}`, {
        status: response.status,
      })
    }
    let parsed: unknown
    try {
      parsed = await response.json()
    } catch (_error) {
      throw new LlmError('OpenAI Codex Responses returned invalid JSON', 'INVALID_RESPONSE')
    }
    return parseResponse(parsed)
  }
}
