import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { CodexTextAdapter, type CodexModel, type CodexTextRequest, type CodexTextResponse } from './adapter.js'
import { createOAuthSessionFileLock } from './auth/session-lock.js'
import { OAuthSessionStore, type OAuthSessionRefresh } from './auth/session-store.js'
import type { OAuthState } from './auth/state.js'
import {
  createHermesCodexBrokerRuntime,
  getHermesCodexBrokerStatus,
  type HermesCodexBrokerStatus,
} from './hermes-codex-broker.js'
import { assertOpenAiCodexRouteAvailable, OPENAI_CODEX_PROVIDER } from './route-ownership.js'

export const OPENAI_CODEX_SETTINGS_NAMESPACE = 'openai-codex'

const MAX_CONFIGURED_MODELS = 64
const MAX_MODEL_TEXT_BYTES = 256
const modelTextEncoder = new TextEncoder()

export interface CodexPluginRuntime {
  refreshSession?: OAuthSessionRefresh
  createResponse?: (input: CodexTextRequest) => Promise<CodexTextResponse>
  streamResponse?: (input: CodexTextRequest) => AsyncIterable<StreamChunk>
}

/**
 * Programmatic runtime callbacks are intentionally separate from stored settings.
 * A configuration UI receives only the provider-directory entry and OAuth status;
 * it never receives, renders, or persists an OAuth value.
 */
export interface OpenAiCodexPluginConfig {
  models: readonly CodexModel[]
  runtime?: CodexPluginRuntime
}

export type OpenAiCodexStatus = HermesCodexBrokerStatus

/**
 * Read only the local Hermes broker's safe health metadata. This never resolves,
 * parses, logs, or returns an OAuth value from either DSH or Hermes storage.
 */
export function getOpenAiCodexStatus(fetcher?: typeof fetch): Promise<OpenAiCodexStatus> {
  return getHermesCodexBrokerStatus(fetcher)
}
function invalidConfig(): never {
  throw new Error('OpenAI Codex plugin configuration is invalid')
}

function validModelText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && modelTextEncoder.encode(value).byteLength <= MAX_MODEL_TEXT_BYTES
}

function validPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function normalizeModels(value: unknown): readonly CodexModel[] {
  try {
    if (!Array.isArray(value)) return invalidConfig()
    const count = value.length
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_CONFIGURED_MODELS) return invalidConfig()
    const models: CodexModel[] = []
    for (let index = 0; index < count; index += 1) {
      const candidate = value[index]
      if (candidate === null || typeof candidate !== 'object') return invalidConfig()
      const model = candidate as Record<string, unknown>
      const id = model.id
      const name = model.name
      const contextWindow = model.contextWindow
      const maxTokens = model.maxTokens
      if (!validModelText(id) || !validModelText(name) || !validPositiveInteger(contextWindow) || !validPositiveInteger(maxTokens)) {
        return invalidConfig()
      }
      models.push(Object.freeze({ id, name, contextWindow, maxTokens }))
    }
    return Object.freeze(models)
  } catch {
    return invalidConfig()
  }
}

interface NormalizedCodexPluginRuntime {
  refreshSession?: OAuthSessionRefresh
  resolveSession?: () => Promise<OAuthState>
  createResponse: (input: CodexTextRequest) => Promise<CodexTextResponse>
  streamResponse?: (input: CodexTextRequest) => AsyncIterable<StreamChunk>
}

function normalizeRuntime(value: unknown): NormalizedCodexPluginRuntime {
  try {
    if (value === undefined) {
      return createHermesCodexBrokerRuntime()
    }
    if (value === null || typeof value !== 'object') return invalidConfig()
    const runtime = value as Record<string, unknown>
    const refreshSession = runtime.refreshSession
    const createResponse = runtime.createResponse
    const streamResponse = runtime.streamResponse
    if (refreshSession !== undefined && typeof refreshSession !== 'function') return invalidConfig()
    if (createResponse !== undefined && typeof createResponse !== 'function') return invalidConfig()
    if (streamResponse !== undefined && typeof streamResponse !== 'function') return invalidConfig()
    return {
      refreshSession: (refreshSession as OAuthSessionRefresh | undefined) ?? (async () => { throw new Error('OpenAI Codex OAuth refresh is unavailable') }),
      createResponse: (createResponse as CodexPluginRuntime['createResponse'] | undefined) ?? (async () => { throw new Error('OpenAI Codex authorized transport is unavailable') }),
      ...(streamResponse === undefined ? {} : { streamResponse: streamResponse as NonNullable<CodexPluginRuntime['streamResponse']> }),
    }
  } catch {
    return invalidConfig()
  }
}

function normalizeConfig(value: unknown): { models: readonly CodexModel[]; runtime: NormalizedCodexPluginRuntime } {
  try {
    if (value === null || typeof value !== 'object') return invalidConfig()
    const config = value as Record<string, unknown>
    return { models: normalizeModels(config.models), runtime: normalizeRuntime(config.runtime) }
  } catch {
    return invalidConfig()
  }
}

export const openAiCodexPlugin = {
  name: '@opencnid/dsh-llm-openai-codex',
  inject: ['llm', 'credentials'],
  apply(ctx: Context, config: OpenAiCodexPluginConfig): () => void {
    const normalized = normalizeConfig(config)
    const registeredRoutes = [
      ...ctx.llm.listProviders(),
      ...ctx.llm.listConfigurableProviders().map(entry => ({ id: entry.provider })),
    ]
    assertOpenAiCodexRouteAvailable(registeredRoutes)

    const sessions = new OAuthSessionStore(ctx.credentials, createOAuthSessionFileLock())
    const resolveSession = normalized.runtime.resolveSession ?? (() => sessions.resolveSession(
      new Date(),
      normalized.runtime.refreshSession ?? (async () => { throw new Error('OpenAI Codex OAuth refresh is unavailable') }),
    ))
    const adapter = new CodexTextAdapter({
      models: normalized.models,
      resolveSession,
      createResponse: normalized.runtime.createResponse,
      ...normalized.runtime.streamResponse === undefined ? {} : { streamResponse: normalized.runtime.streamResponse },
    })
    const directory = ctx.llm.registerConfigurableProviders([{
      provider: OPENAI_CODEX_PROVIDER,
      displayName: 'OpenAI Codex',
      settingsNs: OPENAI_CODEX_SETTINGS_NAMESPACE,
      settingsPath: [],
      declared: false,
    }])
    try {
      const route = ctx.llm.registerAdapter([OPENAI_CODEX_PROVIDER], adapter)
      return () => {
        route()
        directory()
      }
    } catch (error) {
      directory()
      throw error
    }
  },
} satisfies Plugin.Object<OpenAiCodexPluginConfig>
