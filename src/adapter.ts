import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { OAuthState } from './auth/state.js'

export interface CodexModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

export interface CodexTextRequest {
  model: string
  instructions?: string
  input: readonly { role: 'system' | 'user' | 'assistant'; content: string }[]
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
}

function modelInfo(provider: string, model: CodexModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: ['text'],
  }
}

function serializeInput(options: GenerateOptions): CodexTextRequest['input'] {
  return options.messages.map(message => {
    let content = ''
    for (const block of message.content) {
      if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') {
        throw new LlmError('OpenAI Codex text adapter accepts valid text-only messages', 'INVALID_REQUEST')
      }
      content += block.text
    }
    return { role: message.role, content }
  })
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
    if (options.tools !== undefined && options.tools.length > 0) {
      throw new LlmError('OpenAI Codex text adapter does not support tools', 'INVALID_REQUEST')
    }
    const configured = this.config.models.find(entry => entry.id === options.model)
    const maxOutputTokens = options.maxTokens ?? configured?.maxTokens
    if (!isOutputCap(maxOutputTokens)) {
      throw new LlmError('OpenAI Codex requires a positive output token cap', 'INVALID_REQUEST')
    }
    const input = serializeInput(options)
    let session: OAuthState
    try {
      session = await this.config.resolveSession()
    } catch {
      throw new LlmError('OpenAI Codex authentication required', 'AUTH_REQUIRED')
    }
    const response = await this.config.createResponse({
      model: options.model,
      ...options.system === undefined ? {} : { instructions: options.system },
      input,
      accessToken: session.accessToken,
      maxOutputTokens,
      ...options.signal === undefined ? {} : { signal: options.signal },
    })

    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (response.outputText.length > 0) {
      yield { type: 'text-delta', index: 0, text: response.outputText }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: response.outputText } }
    if (response.usage !== undefined) yield { type: 'usage', usage: response.usage }
    yield { type: 'finish', reason: { kind: response.finishReason ?? 'stop' } }
  }
}
