import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { CodexTextAdapter, type CodexModel, type CodexTextRequest, type CodexTextResponse } from './adapter.js'
import { createOAuthSessionFileLock, oauthSessionLockFile } from './auth/session-lock.js'
import { createAes256GcmSessionCipher, type OAuthSessionCipher } from './auth/session-cipher.js'
import { createOpenAiCodexOAuthClient, type AuthorizedOpenAiCodexOAuthConfig, type OpenAiCodexOAuthClient } from './auth/oauth-client.js'
import { createOpenAiCodexOAuthController, type OpenAiCodexOAuthController } from './auth/oauth-controller.js'
import { OAuthSessionStore, createScopedOpenAiCodexOAuthRef, type OAuthSessionRefresh } from './auth/session-store.js'
import { createResponsesTextTransport } from './responses-transport.js'
import { createResponsesStreamTransport } from './responses-stream-transport.js'
import { assertOpenAiCodexRouteAvailable, OPENAI_CODEX_PROVIDER } from './route-ownership.js'

export const OPENAI_CODEX_SETTINGS_NAMESPACE = 'openai-codex'

const MAX_CONFIGURED_MODELS = 64
const MAX_MODEL_TEXT_BYTES = 256
const modelTextEncoder = new TextEncoder()

export interface AuthorizedCodexTransportOverrides {
  /** Deterministic test seam; production uses the direct transport defaults. */
  refreshSession?: OAuthSessionRefresh
  /** Deterministic test seam; production uses the direct transport defaults. */
  createResponse?: (input: CodexTextRequest) => Promise<CodexTextResponse>
  /** Deterministic test seam; production uses the direct transport defaults. */
  streamResponse?: (input: CodexTextRequest) => AsyncIterable<StreamChunk>
}

export interface AuthorizedCodexPluginRuntime {
  /**
   * An approved, programmatically injected OAuth distribution contract. It is
   * deliberately not read from Cordis settings or serialized by this plugin.
   */
  client: AuthorizedOpenAiCodexOAuthConfig
  /** Stable non-secret local scope that partitions credential ownership. */
  accountScope: string
  /** A stable, plugin-owned 256-bit key supplied by a secure secret provider. */
  encryptionKey: Uint8Array
  /** Receives the value-free browser/device/status/disconnect control surface. */
  onController?: (controller: OpenAiCodexOAuthController) => void
  /** Optional deterministic direct-transport seam, still bound to this encrypted session. */
  transport?: AuthorizedCodexTransportOverrides
}

export interface CodexPluginRuntime {
  /**
   * Programmatic-only factory. A function boundary prevents OAuth contract and
   * encryption-key material from being represented in declarative settings.
   */
  authorizedOAuth?: () => AuthorizedCodexPluginRuntime
}

/**
 * Programmatic runtime callbacks are intentionally separate from stored settings.
 * A configuration UI receives only the provider-directory entry; it never receives,
 * renders, or persists an OAuth value.
 */
export interface OpenAiCodexPluginConfig {
  models: readonly CodexModel[]
  runtime?: CodexPluginRuntime
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

interface NormalizedAuthorizedRuntime {
  client: OpenAiCodexOAuthClient
  cipher: OAuthSessionCipher
  accountScope: string
  refreshSession: OAuthSessionRefresh
  createResponse: (input: CodexTextRequest) => Promise<CodexTextResponse>
  streamResponse?: (input: CodexTextRequest) => AsyncIterable<StreamChunk>
  onController?: (controller: OpenAiCodexOAuthController) => void
}

interface NormalizedCodexPluginRuntime {
  refreshSession: OAuthSessionRefresh
  createResponse: (input: CodexTextRequest) => Promise<CodexTextResponse>
  streamResponse?: (input: CodexTextRequest) => AsyncIterable<StreamChunk>
  authorized?: NormalizedAuthorizedRuntime
}

function normalizeTransportOverrides(
  value: unknown,
  client: OpenAiCodexOAuthClient,
): Pick<NormalizedAuthorizedRuntime, 'refreshSession' | 'createResponse' | 'streamResponse'> {
  const direct = client.responsesTransport
  const defaults = {
    refreshSession: (session: Parameters<OAuthSessionRefresh>[0]) => client.refresh(session),
    createResponse: createResponsesTextTransport(direct),
    streamResponse: createResponsesStreamTransport(direct),
  }
  if (value === undefined) return defaults
  if (value === null || typeof value !== 'object') return invalidConfig()
  const overrides = value as Record<string, unknown>
  const refreshSession = overrides.refreshSession
  const createResponse = overrides.createResponse
  const streamResponse = overrides.streamResponse
  if ((refreshSession !== undefined && typeof refreshSession !== 'function')
    || (createResponse !== undefined && typeof createResponse !== 'function')
    || (streamResponse !== undefined && typeof streamResponse !== 'function')) return invalidConfig()
  return {
    refreshSession: (refreshSession as OAuthSessionRefresh | undefined) ?? defaults.refreshSession,
    createResponse: (createResponse as ((input: CodexTextRequest) => Promise<CodexTextResponse>) | undefined) ?? defaults.createResponse,
    ...streamResponse === undefined && createResponse !== undefined
      ? {}
      : { streamResponse: (streamResponse as ((input: CodexTextRequest) => AsyncIterable<StreamChunk>) | undefined) ?? defaults.streamResponse },
  }
}

function normalizeAuthorizedRuntime(value: unknown): NormalizedAuthorizedRuntime {
  if (value === null || typeof value !== 'object') return invalidConfig()
  const authorized = value as Record<string, unknown>
  const client = authorized.client
  const accountScope = authorized.accountScope
  const encryptionKey = authorized.encryptionKey
  const onController = authorized.onController
  if (client === null || typeof client !== 'object' || typeof accountScope !== 'string' || !(encryptionKey instanceof Uint8Array) || (onController !== undefined && typeof onController !== 'function')) {
    return invalidConfig()
  }
  createScopedOpenAiCodexOAuthRef(accountScope)
  const oauthClient = createOpenAiCodexOAuthClient(client as AuthorizedOpenAiCodexOAuthConfig)
  return {
    client: oauthClient,
    cipher: createAes256GcmSessionCipher(encryptionKey),
    accountScope,
    ...normalizeTransportOverrides(authorized.transport, oauthClient),
    ...onController === undefined ? {} : { onController: onController as (controller: OpenAiCodexOAuthController) => void },
  }
}

function normalizeRuntime(value: unknown): NormalizedCodexPluginRuntime {
  try {
    if (value === undefined) {
      return {
        refreshSession: async () => { throw new Error('OpenAI Codex OAuth refresh is unavailable') },
        createResponse: async () => { throw new Error('OpenAI Codex authorized transport is unavailable') },
      }
    }
    if (value === null || typeof value !== 'object') return invalidConfig()
    const runtime = value as Record<string, unknown>
    if (runtime.refreshSession !== undefined || runtime.createResponse !== undefined || runtime.streamResponse !== undefined) return invalidConfig()
    const authorizedFactory = runtime.authorizedOAuth
    if (typeof authorizedFactory !== 'function') return invalidConfig()
    const authorized = normalizeAuthorizedRuntime(authorizedFactory())
    return {
      refreshSession: authorized.refreshSession,
      createResponse: authorized.createResponse,
      streamResponse: authorized.streamResponse,
      authorized,
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

    const authorized = normalized.runtime.authorized
    const sessions = authorized === undefined
      ? undefined
      : new OAuthSessionStore(
          ctx.credentials,
          createOAuthSessionFileLock(oauthSessionLockFile(undefined, authorized.accountScope)),
          authorized.cipher,
          createScopedOpenAiCodexOAuthRef(authorized.accountScope),
        )
    const controller = authorized === undefined || sessions === undefined
      ? undefined
      : createOpenAiCodexOAuthController({ client: authorized.client, sessions })
    const resolveSession = sessions === undefined
      ? async () => { throw new Error('OpenAI Codex OAuth requires re-login') }
      : () => sessions.resolveSession(new Date(), normalized.runtime.refreshSession)
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
      try {
        if (controller !== undefined) normalized.runtime.authorized?.onController?.(controller)
      } catch (error) {
        route()
        throw error
      }
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
