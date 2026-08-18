import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { CodexTextRequest, CodexTextResponse } from './adapter.js'
import { OAUTH_STATE_VERSION, type OAuthState } from './auth/state.js'
import { createResponsesStreamTransport } from './responses-stream-transport.js'
import { createResponsesTextTransport } from './responses-transport.js'

/** The documented default endpoint for `hermes proxy start`. */
export const HERMES_CODEX_PROXY_RESPONSES_URL = 'http://127.0.0.1:8645/v1/responses'
export const HERMES_CODEX_PROXY_HEALTH_URL = 'http://127.0.0.1:8645/health'

/**
 * A non-secret local marker accepted by the existing localhost-only Hermes
 * proxy. It is never persisted and is not an OpenAI or Hermes OAuth token.
 */
export const HERMES_LOCAL_PROXY_CLIENT_MARKER = 'hermes-local-broker'

const HERMES_LOCAL_PROXY_SESSION: OAuthState = Object.freeze({
  version: OAUTH_STATE_VERSION,
  accessToken: HERMES_LOCAL_PROXY_CLIENT_MARKER,
  refreshToken: 'broker-owned',
  expiresAt: '9999-12-31T23:59:59.999Z',
})

export interface HermesCodexBrokerRuntime {
  resolveSession(): Promise<OAuthState>
  createResponse(input: CodexTextRequest): Promise<CodexTextResponse>
  streamResponse(input: CodexTextRequest): AsyncIterable<StreamChunk>
}

/**
 * Build the DSH-side client for Hermes's local Codex broker. The only value
 * sent to the broker is a non-secret local marker; Hermes resolves, refreshes,
 * and attaches its private OAuth credential after the request arrives.
 */
export function createHermesCodexBrokerRuntime(
  url = HERMES_CODEX_PROXY_RESPONSES_URL,
): HermesCodexBrokerRuntime {
  const createResponse = createResponsesTextTransport({ url })
  const streamResponse = createResponsesStreamTransport({ url })
  return Object.freeze({
    resolveSession: async () => HERMES_LOCAL_PROXY_SESSION,
    createResponse,
    streamResponse,
  })
}

export interface HermesCodexBrokerStatus {
  configured: boolean
  writable: false
}

/**
 * Return only safe broker readiness metadata. Response bodies, provider errors,
 * and any credential-bearing values are deliberately discarded.
 */
export async function getHermesCodexBrokerStatus(
  fetcher: typeof fetch = fetch,
): Promise<HermesCodexBrokerStatus> {
  try {
    const response = await fetcher(HERMES_CODEX_PROXY_HEALTH_URL)
    if (!response.ok) return Object.freeze({ configured: false, writable: false })
    const value: unknown = await response.json()
    const configured = value !== null
      && typeof value === 'object'
      && (value as Record<string, unknown>).authenticated === true
    return Object.freeze({ configured, writable: false })
  } catch {
    return Object.freeze({ configured: false, writable: false })
  }
}
