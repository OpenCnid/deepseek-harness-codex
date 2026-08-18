import { attributionHeaders, CallId, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { CodexTextRequest } from './adapter.js'

export interface ResponsesStreamTransportOptions {
  url: string
  fetch?: typeof fetch
}

type OpenBlock =
  | { kind: 'text'; text: string; bytes: number }
  | { kind: 'tool-call'; id: ReturnType<typeof CallId>; idBytes: number; name: string; arguments: string; bytes: number }

interface OpenBlockState {
  blocks: Map<number, OpenBlock>
  toolCallIds: Set<string>
  retainedBytes: number
}

type WireRecord = Record<string, unknown>

const textEncoder = new TextEncoder()
const MAX_SSE_FRAME_BYTES = 1_048_576
const MAX_SSE_TRANSPORT_CHUNK_BYTES = 4 * MAX_SSE_FRAME_BYTES
const MAX_BLOCK_BYTES = 1_048_576
const MAX_RETAINED_OUTPUT_BYTES = 4 * 1_048_576
const MAX_OPEN_BLOCKS = 64
const MAX_TOOL_CALL_IDS = 64
const typedArrayByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')?.get

function byteLength(value: Uint8Array): number {
  if (typedArrayByteLength === undefined) throw new Error('typed array length unavailable')
  return typedArrayByteLength.call(value)
}

function record(value: unknown): WireRecord | undefined {
  return value !== null && typeof value === 'object' ? value as WireRecord : undefined
}

function outputIndex(value: WireRecord): number {
  const index = value.output_index
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw new LlmError('OpenAI Codex Responses stream has an invalid output index', 'MALFORMED_RESPONSE')
  }
  return index
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isOutputCap(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function usage(value: unknown): TokenUsage | undefined {
  const details = record(value)
  const inputTokens = tokenCount(details?.input_tokens)
  const outputTokens = tokenCount(details?.output_tokens)
  return inputTokens === undefined || outputTokens === undefined ? undefined : { inputTokens, outputTokens }
}

function finish(eventType: 'response.completed' | 'response.incomplete', value: unknown, sawToolCall: boolean): StreamChunk {
  const response = record(value)
  if (eventType === 'response.completed') {
    if (response?.status !== 'completed') {
      throw new LlmError('OpenAI Codex Responses stream terminal event is inconsistent', 'MALFORMED_RESPONSE')
    }
    return { type: 'finish', reason: { kind: sawToolCall ? 'tool-calls' : 'stop' } }
  }
  if (response?.status !== 'incomplete') {
    throw new LlmError('OpenAI Codex Responses stream terminal event is inconsistent', 'MALFORMED_RESPONSE')
  }
  if (record(response.incomplete_details)?.reason === 'max_output_tokens') {
    return { type: 'finish', reason: { kind: 'max-tokens' } }
  }
  throw new LlmError('OpenAI Codex Responses stream did not complete', 'INCOMPLETE_RESPONSE')
}

async function* sseEvents(response: Response, signal?: AbortSignal): AsyncGenerator<WireRecord> {
  let body: ReadableStream<Uint8Array> | null
  try {
    body = response.body
  } catch {
    throw new LlmError('OpenAI Codex Responses stream body failed', 'TRANSPORT')
  }
  if (body === null) {
    throw new LlmError('OpenAI Codex Responses stream has no body', 'EMPTY_RESPONSE')
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = body.getReader()
  } catch {
    throw new LlmError('OpenAI Codex Responses stream body failed', 'TRANSPORT')
  }
  let frame = new Uint8Array()
  let reachedEnd = false
  const cancelReader = (): void => {
    try {
      void Promise.resolve(reader.cancel()).catch(() => undefined)
    } catch {
      // Reader disposal cannot override the fixed public transport error.
    }
  }
  const cancelOnAbort = (): void => {
    void cancelReader()
  }
  const isAborted = (): boolean => {
    try {
      return signal?.aborted === true
    } catch {
      throw new LlmError('OpenAI Codex Responses stream signal failed', 'TRANSPORT')
    }
  }
  try {
    if (isAborted()) {
      cancelOnAbort()
    } else {
      signal?.addEventListener('abort', cancelOnAbort, { once: true })
    }
  } catch {
    throw new LlmError('OpenAI Codex Responses stream signal failed', 'TRANSPORT')
  }
  const assertNotAborted = (): void => {
    if (isAborted()) {
      throw new LlmError('OpenAI Codex Responses stream was cancelled', 'STREAM_CLOSED')
    }
  }

  const parseFrame = (source: string): WireRecord | undefined => {
    const data = source
      .split(/\r\n|\r|\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (data.length === 0 || data === '[DONE]') return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      throw new LlmError('OpenAI Codex Responses stream contains invalid JSON', 'MALFORMED_RESPONSE')
    }
    const event = record(parsed)
    if (event === undefined || typeof event.type !== 'string') {
      throw new LlmError('OpenAI Codex Responses stream contains an invalid event', 'MALFORMED_RESPONSE')
    }
    return event
  }

  const appendFrame = (bytes: Uint8Array): void => {
    if (bytes.byteLength > MAX_SSE_FRAME_BYTES - frame.byteLength) {
      throw new LlmError('OpenAI Codex Responses stream frame exceeds the size limit', 'MALFORMED_RESPONSE')
    }
    if (bytes.byteLength === 0) return
    const next = new Uint8Array(frame.byteLength + bytes.byteLength)
    next.set(frame)
    next.set(bytes, frame.byteLength)
    frame = next
  }

  const lineEndingLength = (bytes: Uint8Array, index: number): number => {
    if (bytes[index] === 0x0d) return bytes[index + 1] === 0x0a ? 2 : 1
    return bytes[index] === 0x0a ? 1 : 0
  }

  const findBoundary = (bytes: Uint8Array, from = 0): { start: number; end: number } | undefined => {
    for (let index = from; index < bytes.byteLength; index += 1) {
      const firstLength = lineEndingLength(bytes, index)
      if (firstLength === 0) continue
      const secondLength = lineEndingLength(bytes, index + firstLength)
      if (secondLength !== 0) return { start: index, end: index + firstLength + secondLength }
    }
    return undefined
  }

  const emitFrame = (): WireRecord | undefined => {
    let source: string
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(frame)
    } catch {
      throw new LlmError('OpenAI Codex Responses stream contains invalid UTF-8', 'MALFORMED_RESPONSE')
    }
    frame = new Uint8Array()
    return parseFrame(source)
  }

  try {
    while (true) {
      assertNotAborted()
      let done: boolean
      let value: Uint8Array | undefined
      try {
        const readResult = await reader.read()
        const rawDone = readResult.done
        if (typeof rawDone !== 'boolean') throw new Error('invalid reader result')
        done = rawDone
        const rawValue = readResult.value
        if (!done) {
          if (!(rawValue instanceof Uint8Array)) throw new Error('invalid reader value')
          const rawByteLength = byteLength(rawValue)
          if (!Number.isSafeInteger(rawByteLength) || rawByteLength < 0) {
            throw new Error('invalid reader value')
          }
          value = new Uint8Array(rawValue)
        }
      } catch {
        throw new LlmError('OpenAI Codex Responses stream read failed', 'TRANSPORT')
      }
      assertNotAborted()
      if (done) {
        reachedEnd = true
        break
      }
      if (value === undefined) {
        throw new LlmError('OpenAI Codex Responses stream read failed', 'TRANSPORT')
      }
      if (value.byteLength > MAX_SSE_TRANSPORT_CHUNK_BYTES) {
        throw new LlmError('OpenAI Codex Responses stream transport chunk exceeds the size limit', 'MALFORMED_RESPONSE')
      }

      let offset = 0
      const tailLength = Math.min(frame.byteLength, 3)
      if (tailLength > 0 && value.byteLength > 0) {
        const bridge = new Uint8Array(tailLength + Math.min(value.byteLength, 3))
        bridge.set(frame.slice(frame.byteLength - tailLength))
        bridge.set(value.slice(0, Math.min(value.byteLength, 3)), tailLength)
        const boundary = findBoundary(bridge)
        if (boundary !== undefined && boundary.start < tailLength && boundary.end > tailLength) {
          frame = frame.slice(0, frame.byteLength - (tailLength - boundary.start))
          const event = emitFrame()
          if (event !== undefined) yield event
          offset = boundary.end - tailLength
        }
      }

      while (offset < value.byteLength) {
        assertNotAborted()
        const boundary = findBoundary(value, offset)
        if (boundary === undefined) {
          appendFrame(value.slice(offset))
          break
        }
        appendFrame(value.slice(offset, boundary.start))
        const event = emitFrame()
        if (event !== undefined) yield event
        offset = boundary.end
      }
    }
    if (frame.byteLength > 0) {
      throw new LlmError('OpenAI Codex Responses stream ended with an unterminated record', 'STREAM_CLOSED')
    }
  } catch (error) {
    if (error instanceof LlmError) throw error
    throw new LlmError('OpenAI Codex Responses stream read failed', 'TRANSPORT')
  } finally {
    try {
      signal?.removeEventListener('abort', cancelOnAbort)
    } catch {
      // Signal cleanup cannot override the fixed public transport error.
    }
    if (!reachedEnd) {
      cancelReader()
    }
    try {
      reader.releaseLock()
    } catch {
      // Reader disposal cannot override the fixed public transport error.
    }
  }
}

function retain(state: OpenBlockState, block: OpenBlock, value: string): void {
  const bytes = textEncoder.encode(value).byteLength
  if (bytes > MAX_BLOCK_BYTES - block.bytes || bytes > MAX_RETAINED_OUTPUT_BYTES - state.retainedBytes) {
    throw new LlmError('OpenAI Codex Responses stream retained output exceeds the size limit', 'MALFORMED_RESPONSE')
  }
  block.bytes += bytes
  state.retainedBytes += bytes
}

function release(state: OpenBlockState, index: number, block: OpenBlock): void {
  state.blocks.delete(index)
  state.retainedBytes -= block.kind === 'tool-call' ? block.bytes - block.idBytes : block.bytes
}

function added(event: WireRecord, state: OpenBlockState): Extract<StreamChunk, { type: 'block-start' }> {
  const index = outputIndex(event)
  if (state.blocks.has(index)) {
    throw new LlmError('OpenAI Codex Responses stream reopened an output block', 'MALFORMED_RESPONSE')
  }
  if (state.blocks.size >= MAX_OPEN_BLOCKS) {
    throw new LlmError('OpenAI Codex Responses stream has too many open output blocks', 'MALFORMED_RESPONSE')
  }
  const item = record(event.item)
  if (item?.type === 'message') {
    state.blocks.set(index, { kind: 'text', text: '', bytes: 0 })
    return { type: 'block-start', index, blockType: 'text' }
  }
  if (item?.type === 'function_call') {
    const callId = nonEmptyString(item.call_id)
    const name = nonEmptyString(item.name)
    if (callId === undefined || name === undefined || (item.arguments !== undefined && typeof item.arguments !== 'string')) {
      throw new LlmError('OpenAI Codex Responses stream has an invalid tool call', 'MALFORMED_RESPONSE')
    }
    if (state.toolCallIds.has(callId)) {
      throw new LlmError('OpenAI Codex Responses stream reused a tool call ID', 'MALFORMED_RESPONSE')
    }
    if (state.toolCallIds.size >= MAX_TOOL_CALL_IDS) {
      throw new LlmError('OpenAI Codex Responses stream has too many tool call IDs', 'MALFORMED_RESPONSE')
    }
    const argumentsText = typeof item.arguments === 'string' ? item.arguments : ''
    const idBytes = textEncoder.encode(callId).byteLength
    const block: OpenBlock = { kind: 'tool-call', id: CallId(callId), idBytes, name, arguments: argumentsText, bytes: 0 }
    retain(state, block, callId)
    retain(state, block, name)
    retain(state, block, argumentsText)
    state.toolCallIds.add(callId)
    state.blocks.set(index, block)
    return { type: 'block-start', index, blockType: 'tool-call' }
  }
  throw new LlmError('OpenAI Codex Responses stream has an unsupported output item', 'UNSUPPORTED_RESPONSE')
}

function textDelta(event: WireRecord, state: OpenBlockState): StreamChunk {
  const index = outputIndex(event)
  const delta = event.delta
  const block = state.blocks.get(index)
  if (block?.kind !== 'text' || typeof delta !== 'string') {
    throw new LlmError('OpenAI Codex Responses stream has an invalid text delta', 'MALFORMED_RESPONSE')
  }
  retain(state, block, delta)
  block.text += delta
  return { type: 'text-delta', index, text: delta }
}

function toolDelta(event: WireRecord, state: OpenBlockState): StreamChunk {
  const index = outputIndex(event)
  const delta = event.delta
  const block = state.blocks.get(index)
  if (block?.kind !== 'tool-call' || typeof delta !== 'string') {
    throw new LlmError('OpenAI Codex Responses stream has an invalid tool-call delta', 'MALFORMED_RESPONSE')
  }
  retain(state, block, delta)
  block.arguments += delta
  return { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: delta }
}

function done(event: WireRecord, state: OpenBlockState): StreamChunk[] {
  const index = outputIndex(event)
  const block = state.blocks.get(index)
  const item = record(event.item)
  if (block === undefined || item === undefined) {
    throw new LlmError('OpenAI Codex Responses stream ended an unknown output block', 'MALFORMED_RESPONSE')
  }
  if (block.kind === 'text' && item.type === 'message') {
    release(state, index, block)
    return [{ type: 'block-end', index, block: { type: 'text', text: block.text } }]
  }
  if (block.kind === 'tool-call' && item.type === 'function_call') {
    const callId = nonEmptyString(item.call_id)
    const name = nonEmptyString(item.name)
    if (callId !== block.id || name !== block.name || (item.arguments !== undefined && typeof item.arguments !== 'string')) {
      throw new LlmError('OpenAI Codex Responses stream changed tool-call identity', 'MALFORMED_RESPONSE')
    }
    const finalArguments = typeof item.arguments === 'string' ? item.arguments : block.arguments
    if (!finalArguments.startsWith(block.arguments)) {
      throw new LlmError('OpenAI Codex Responses stream changed tool arguments', 'MALFORMED_RESPONSE')
    }
    const trailing = finalArguments.slice(block.arguments.length)
    retain(state, block, trailing)
    const chunks: StreamChunk[] = []
    if (trailing.length > 0) {
      chunks.push({ type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: trailing })
    }
    release(state, index, block)
    chunks.push({ type: 'block-end', index, block: { type: 'tool-call', id: block.id, name: block.name, arguments: finalArguments } })
    return chunks
  }
  throw new LlmError('OpenAI Codex Responses stream changed an output block type', 'MALFORMED_RESPONSE')
}

export function createResponsesStreamTransport(options: ResponsesStreamTransportOptions): (input: CodexTextRequest) => AsyncIterable<StreamChunk> {
  return async function* (input) {
    let maxOutputTokens: number | undefined
    let signal: AbortSignal | undefined
    try {
      maxOutputTokens = input.maxOutputTokens
      signal = input.signal
    } catch {
      throw new LlmError('OpenAI Codex Responses stream request failed', 'TRANSPORT')
    }
    if (!isOutputCap(maxOutputTokens)) {
      throw new LlmError('OpenAI Codex requires a positive output token cap', 'INVALID_REQUEST')
    }
    const assertNotAborted = (): void => {
      let aborted: boolean
      try {
        aborted = signal?.aborted === true
      } catch {
        throw new LlmError('OpenAI Codex Responses stream signal failed', 'TRANSPORT')
      }
      if (aborted) {
        throw new LlmError('OpenAI Codex Responses stream was cancelled', 'STREAM_CLOSED')
      }
    }
    assertNotAborted()
    let fetcher: typeof fetch
    try {
      fetcher = options.fetch ?? fetch
    } catch {
      throw new LlmError('OpenAI Codex Responses stream request failed', 'TRANSPORT')
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
          ...input.tools === undefined ? {} : {
            tools: input.tools.map(tool => ({
              type: 'function',
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          },
          max_output_tokens: maxOutputTokens,
          stream: true,
        }),
        ...signal === undefined ? {} : { signal },
      })
    } catch {
      throw new LlmError('OpenAI Codex Responses stream request failed', 'TRANSPORT')
    }
    let isOk: boolean
    let failedStatus: number | undefined
    try {
      isOk = response.ok
      if (typeof isOk !== 'boolean') throw new Error('invalid response status')
      if (!isOk) {
        const status = response.status
        if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
          throw new Error('invalid status')
        }
        failedStatus = status
        await response.body?.cancel().catch(() => undefined)
      }
    } catch {
      throw new LlmError('OpenAI Codex Responses stream request failed', 'TRANSPORT')
    }
    if (!isOk) {
      throw new LlmError(`OpenAI Codex Responses stream request failed (HTTP ${failedStatus})`, `HTTP_${failedStatus}`, {
        status: failedStatus,
      })
    }

    const open: OpenBlockState = { blocks: new Map<number, OpenBlock>(), toolCallIds: new Set<string>(), retainedBytes: 0 }
    let sawToolCall = false
    for await (const event of sseEvents(response, signal)) {
      switch (event.type) {
        case 'response.output_item.added': {
          const chunk = added(event, open)
          if (chunk.blockType === 'tool-call') sawToolCall = true
          assertNotAborted()
          yield chunk
          break
        }
        case 'response.output_text.delta':
          assertNotAborted()
          yield textDelta(event, open)
          break
        case 'response.function_call_arguments.delta':
          assertNotAborted()
          yield toolDelta(event, open)
          break
        case 'response.output_item.done':
          for (const chunk of done(event, open)) {
            assertNotAborted()
            yield chunk
          }
          break
        case 'response.completed':
        case 'response.incomplete': {
          if (open.blocks.size !== 0) {
            throw new LlmError('OpenAI Codex Responses stream completed with open output blocks', 'STREAM_CLOSED')
          }
          const result = record(event.response)
          const terminal = finish(event.type, result, sawToolCall)
          const finalUsage = usage(result?.usage)
          if (finalUsage !== undefined) {
            assertNotAborted()
            yield { type: 'usage', usage: finalUsage }
          }
          assertNotAborted()
          yield terminal
          return
        }
        case 'error':
        case 'response.failed':
          throw new LlmError('OpenAI Codex Responses stream failed', 'TRANSPORT')
        default:
          break
      }
    }
    throw new LlmError('OpenAI Codex Responses stream ended before completion', 'STREAM_CLOSED')
  }
}
