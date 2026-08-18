import { CallId, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { OAuthState } from './auth/state.js'

export interface CodexModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

export type CodexInputItem =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

export interface CodexTextRequest {
  model: string
  instructions?: string
  input: readonly CodexInputItem[]
  tools?: readonly ToolSchema[]
  accessToken: string
  maxOutputTokens: number
  signal?: AbortSignal
}

export interface CodexTextResponse {
  outputText: string
  usage?: TokenUsage
  finishReason?: 'stop' | 'max-tokens'
}

export interface CodexTextAdapterOptions {
  models: readonly CodexModel[]
  resolveSession(): Promise<OAuthState>
  createResponse(input: CodexTextRequest): Promise<CodexTextResponse>
  streamResponse?(input: CodexTextRequest): AsyncIterable<StreamChunk>
}

function modelInfo(provider: string, model: CodexModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: ['text'],
  }
}

const MAX_TOOL_DECLARATIONS = 64
const MAX_TOOL_NAME_BYTES = 256
const MAX_TOOL_DESCRIPTION_BYTES = 8 * 1024
const MAX_TOOL_PARAMETERS_BYTES = 1024 * 1024
const inputTextEncoder = new TextEncoder()

function serializeTools(options: GenerateOptions): readonly ToolSchema[] | undefined {
  try {
    const tools = options.tools
    if (tools === undefined) return undefined
    if (!Array.isArray(tools)) throw new Error('invalid tools')
    const toolCount = tools.length
    if (toolCount > MAX_TOOL_DECLARATIONS) {
      throw new Error('invalid tools')
    }
    const serializedTools: ToolSchema[] = []
    for (let index = 0; index < toolCount; index += 1) {
      const tool = tools[index]
      if (tool === null || typeof tool !== 'object') throw new Error('invalid tool')
      const name = tool.name
      const description = tool.description
      const parameters = tool.parameters
      if (typeof name !== 'string' || name.length === 0 || inputTextEncoder.encode(name).byteLength > MAX_TOOL_NAME_BYTES) {
        throw new Error('invalid tool name')
      }
      if (typeof description !== 'string' || inputTextEncoder.encode(description).byteLength > MAX_TOOL_DESCRIPTION_BYTES) {
        throw new Error('invalid tool description')
      }
      if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
        throw new Error('invalid tool parameters')
      }
      const serialized = JSON.stringify(parameters)
      if (typeof serialized !== 'string' || inputTextEncoder.encode(serialized).byteLength > MAX_TOOL_PARAMETERS_BYTES) {
        throw new Error('invalid tool parameters')
      }
      const cloned = JSON.parse(serialized)
      if (cloned === null || typeof cloned !== 'object' || Array.isArray(cloned)) {
        throw new Error('invalid tool parameters')
      }
      serializedTools.push({ name, description, parameters: cloned as Record<string, unknown> })
    }
    return serializedTools
  } catch {
    throw new LlmError('OpenAI Codex tool declarations are invalid', 'INVALID_REQUEST')
  }
}

function textContent(blocks: readonly unknown[]): string {
  let content = ''
  for (const block of blocks) {
    if (block === null || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text' || typeof (block as { text?: unknown }).text !== 'string') {
      throw new LlmError('OpenAI Codex accepts text and tool messages only', 'INVALID_REQUEST')
    }
    content += (block as { text: string }).text
  }
  return content
}

function serializeInput(options: GenerateOptions): CodexTextRequest['input'] {
  const input: CodexInputItem[] = []
  const unresolvedToolCallIds = new Set<string>()
  const seenToolCallIds = new Set<string>()
  for (const message of options.messages) {
    if (message.role === 'user' && message.content.length === 1 && message.content[0]?.type === 'tool-result') {
      const result = message.content[0]
      if (typeof result.toolCallId !== 'string' || result.toolCallId.length === 0 || !Array.isArray(result.content) || !unresolvedToolCallIds.delete(result.toolCallId)) {
        throw new LlmError('OpenAI Codex accepts correlated tool results only', 'INVALID_REQUEST')
      }
      input.push({ type: 'function_call_output', call_id: result.toolCallId, output: textContent(result.content) })
      continue
    }
    if (message.role !== 'assistant') {
      input.push({ role: message.role, content: textContent(message.content) })
      continue
    }
    let text = ''
    const flushText = (): void => {
      if (text.length > 0) {
        input.push({ role: 'assistant', content: text })
        text = ''
      }
    }
    for (const block of message.content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        text += block.text
        continue
      }
      if (block !== null && typeof block === 'object' && block.type === 'tool-call' && typeof block.id === 'string' && block.id.length > 0 && typeof block.name === 'string' && block.name.length > 0 && typeof block.arguments === 'string') {
        if (seenToolCallIds.has(block.id)) {
          throw new LlmError('OpenAI Codex accepts unique tool-call IDs only', 'INVALID_REQUEST')
        }
        seenToolCallIds.add(block.id)
        unresolvedToolCallIds.add(block.id)
        flushText()
        input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: block.arguments })
        continue
      }
      throw new LlmError('OpenAI Codex accepts valid text and tool-call messages only', 'INVALID_REQUEST')
    }
    flushText()
  }
  if (unresolvedToolCallIds.size !== 0) {
    throw new LlmError('OpenAI Codex requires a result for every tool call', 'INVALID_REQUEST')
  }
  return input
}

function callbackChunk(value: unknown): StreamChunk {
  if (value === null || typeof value !== 'object') throw new Error('invalid stream chunk')
  const chunk = value as Record<string, unknown>
  const type = chunk.type
  const validIndex = (index: unknown): index is number => typeof index === 'number' && Number.isSafeInteger(index) && index >= 0
  if (type === 'block-start') {
    const index = chunk.index
    const blockType = chunk.blockType
    if (!validIndex(index) || (blockType !== 'text' && blockType !== 'reasoning' && blockType !== 'tool-call')) throw new Error('invalid stream chunk')
    return { type, index, blockType }
  }
  if (type === 'text-delta' || type === 'reasoning-delta') {
    const index = chunk.index
    const text = chunk.text
    if (!validIndex(index) || typeof text !== 'string') throw new Error('invalid stream chunk')
    return { type, index, text }
  }
  if (type === 'tool-call-delta') {
    const index = chunk.index
    const id = chunk.id
    const name = chunk.name
    const argumentsDelta = chunk.argumentsDelta
    if (!validIndex(index) || typeof id !== 'string' || id.length === 0 || typeof name !== 'string' || name.length === 0 || typeof argumentsDelta !== 'string') {
      throw new Error('invalid stream chunk')
    }
    return { type, index, id: CallId(id), name, argumentsDelta }
  }
  if (type === 'block-end') {
    const index = chunk.index
    const block = chunk.block
    if (!validIndex(index) || block === null || typeof block !== 'object') throw new Error('invalid stream chunk')
    const source = block as Record<string, unknown>
    const blockType = source.type
    const text = source.text
    if ((blockType === 'text' || blockType === 'reasoning') && typeof text === 'string') {
      return { type, index, block: { type: blockType, text } }
    }
    const id = source.id
    const name = source.name
    const argumentsText = source.arguments
    if (blockType === 'tool-call' && typeof id === 'string' && id.length > 0 && typeof name === 'string' && name.length > 0 && typeof argumentsText === 'string') {
      return { type, index, block: { type: 'tool-call', id: CallId(id), name, arguments: argumentsText } }
    }
    throw new Error('invalid stream chunk')
  }
  if (type === 'usage') {
    const usage = chunk.usage
    if (usage === null || typeof usage !== 'object') throw new Error('invalid stream chunk')
    const inputTokens = (usage as { inputTokens?: unknown }).inputTokens
    const outputTokens = (usage as { outputTokens?: unknown }).outputTokens
    if (typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens < 0 || typeof outputTokens !== 'number' || !Number.isSafeInteger(outputTokens) || outputTokens < 0) throw new Error('invalid stream chunk')
    return { type, usage: { inputTokens, outputTokens } }
  }
  if (type === 'finish') {
    const reason = chunk.reason
    if (reason === null || typeof reason !== 'object') throw new Error('invalid stream finish')
    const kind = (reason as { kind?: unknown }).kind
    if (kind !== 'stop' && kind !== 'tool-calls' && kind !== 'max-tokens') throw new Error('invalid stream finish')
    return { type, reason: { kind } }
  }
  throw new Error('invalid stream chunk')
}

interface CallbackBlockState {
  blockType: string
  toolCall?: { id: string; name: string }
}

interface CallbackStreamState {
  blocks: Map<number, CallbackBlockState>
  toolCallIds: Set<string>
}

function trackCallbackChunk(chunk: StreamChunk, state: CallbackStreamState): void {
  if (chunk.type === 'block-start') {
    if (state.blocks.has(chunk.index) || state.blocks.size >= 64) throw new Error('invalid stream block')
    state.blocks.set(chunk.index, { blockType: chunk.blockType })
    return
  }
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    const block = state.blocks.get(chunk.index)
    if (block === undefined || block.blockType !== (chunk.type === 'text-delta' ? 'text' : 'reasoning')) throw new Error('invalid stream block')
    return
  }
  if (chunk.type === 'tool-call-delta') {
    const block = state.blocks.get(chunk.index)
    if (block === undefined || block.blockType !== 'tool-call') throw new Error('invalid stream block')
    if (block.toolCall === undefined) {
      if (chunk.name === undefined || state.toolCallIds.size >= 64 || state.toolCallIds.has(chunk.id)) throw new Error('invalid tool call')
      state.toolCallIds.add(chunk.id)
      block.toolCall = { id: chunk.id, name: chunk.name }
    } else if (block.toolCall.id !== chunk.id || (chunk.name !== undefined && block.toolCall.name !== chunk.name)) {
      throw new Error('invalid tool call')
    }
    return
  }
  if (chunk.type === 'block-end') {
    const block = state.blocks.get(chunk.index)
    if (block === undefined || block.blockType !== chunk.block.type) throw new Error('invalid stream block')
    if (chunk.block.type === 'tool-call') {
      const toolCall = block.toolCall
      if (toolCall === undefined || toolCall.id !== chunk.block.id || (toolCall.name !== undefined && toolCall.name !== chunk.block.name)) {
        throw new Error('invalid tool call')
      }
    }
    state.blocks.delete(chunk.index)
    return
  }
  if (chunk.type === 'finish' && state.blocks.size !== 0) throw new Error('stream ended with open blocks')
}

function isOutputCap(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export class CodexTextAdapter extends LlmAdapter {
  constructor(private readonly config: CodexTextAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'OpenAI Codex' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const configured = this.config.models.find(entry => entry.id === model)
    return Promise.resolve(configured === undefined
      ? { provider, id: model, name: model, inputModalities: ['text'] }
      : {
        ...modelInfo(provider, configured),
        context: { contextWindow: configured.contextWindow },
        defaultMaxTokens: configured.maxTokens,
      })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let streamResponse: CodexTextAdapterOptions['streamResponse']
    let createResponse: CodexTextAdapterOptions['createResponse'] | undefined
    try {
      streamResponse = this.config.streamResponse
      if (streamResponse !== undefined && typeof streamResponse !== 'function') {
        throw new Error('invalid stream response transport')
      }
      if (streamResponse === undefined) {
        createResponse = this.config.createResponse
        if (typeof createResponse !== 'function') throw new Error('invalid response transport')
      }
    } catch {
      throw new LlmError('OpenAI Codex response failed', 'TRANSPORT')
    }
    const tools = serializeTools(options)
    if (tools !== undefined && tools.length > 0 && streamResponse === undefined) {
      throw new LlmError('OpenAI Codex tools require a streaming response transport', 'INVALID_REQUEST')
    }
    let model: string
    let instructions: string | undefined
    try {
      model = options.model
      instructions = options.system
    } catch {
      throw new LlmError('OpenAI Codex response failed', 'TRANSPORT')
    }
    let configured: CodexModel | undefined
    try {
      configured = this.config.models.find(entry => entry.id === model)
    } catch {
      throw new LlmError('OpenAI Codex response failed', 'TRANSPORT')
    }
    let maxOutputTokens: number | undefined
    try {
      maxOutputTokens = options.maxTokens ?? configured?.maxTokens
    } catch {
      throw new LlmError('OpenAI Codex response failed', 'TRANSPORT')
    }
    if (!isOutputCap(maxOutputTokens)) {
      throw new LlmError('OpenAI Codex requires a positive output token cap', 'INVALID_REQUEST')
    }
    let requestSignal: AbortSignal | undefined
    try {
      requestSignal = options.signal
    } catch {
      throw new LlmError('OpenAI Codex response failed', 'TRANSPORT')
    }
    const assertNotAborted = (): void => {
      let aborted: boolean
      try {
        aborted = requestSignal?.aborted === true
      } catch {
        throw new LlmError('OpenAI Codex response failed', 'TRANSPORT')
      }
      if (aborted) throw new LlmError('OpenAI Codex response was cancelled', 'STREAM_CLOSED')
    }
    assertNotAborted()
    let input: CodexTextRequest['input']
    try {
      input = serializeInput(options)
    } catch {
      throw new LlmError('OpenAI Codex request input is invalid', 'INVALID_REQUEST')
    }
    let accessToken: string
    try {
      const session = await this.config.resolveSession()
      accessToken = session.accessToken
    } catch {
      throw new LlmError('OpenAI Codex authentication required', 'AUTH_REQUIRED')
    }
    assertNotAborted()
    const request: CodexTextRequest = {
      model,
      ...instructions === undefined ? {} : { instructions },
      input,
      ...tools === undefined || tools.length === 0 ? {} : { tools },
      accessToken,
      maxOutputTokens,
      ...requestSignal === undefined ? {} : { signal: requestSignal },
    }
    if (streamResponse !== undefined) {
      try {
        let finished = false
        const state: CallbackStreamState = { blocks: new Map(), toolCallIds: new Set() }
        for await (const rawChunk of streamResponse(request)) {
          assertNotAborted()
          if (finished) throw new Error('stream emitted after finish')
          const chunk = callbackChunk(rawChunk)
          trackCallbackChunk(chunk, state)
          if (chunk.type === 'finish') finished = true
          assertNotAborted()
          yield chunk
        }
        if (!finished) throw new Error('stream ended before finish')
      } catch {
        throw new LlmError('OpenAI Codex response failed', 'TRANSPORT')
      }
      return
    }
    let outputText: string
    let responseUsage: TokenUsage | undefined
    let finishReason: 'stop' | 'max-tokens' | undefined
    try {
      const response = await createResponse!(request)
      outputText = response.outputText
      const candidateUsage = response.usage
      finishReason = response.finishReason
      if (typeof outputText !== 'string' || (finishReason !== undefined && finishReason !== 'stop' && finishReason !== 'max-tokens')) {
        throw new Error('invalid response')
      }
      if (candidateUsage !== undefined) {
        if (!Number.isSafeInteger(candidateUsage.inputTokens) || candidateUsage.inputTokens < 0 || !Number.isSafeInteger(candidateUsage.outputTokens) || candidateUsage.outputTokens < 0) {
          throw new Error('invalid response')
        }
        responseUsage = { inputTokens: candidateUsage.inputTokens, outputTokens: candidateUsage.outputTokens }
      }
    } catch {
      throw new LlmError('OpenAI Codex response failed', 'TRANSPORT')
    }

    assertNotAborted()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (outputText.length > 0) {
      assertNotAborted()
      yield { type: 'text-delta', index: 0, text: outputText }
    }
    assertNotAborted()
    yield { type: 'block-end', index: 0, block: { type: 'text', text: outputText } }
    if (responseUsage !== undefined) {
      assertNotAborted()
      yield { type: 'usage', usage: responseUsage }
    }
    assertNotAborted()
    yield { type: 'finish', reason: { kind: finishReason ?? 'stop' } }
  }
}
