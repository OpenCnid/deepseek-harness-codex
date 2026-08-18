/**
 * Deterministic protocol shapes for adapter tests.
 *
 * Every credential-bearing or account-bearing field is intentionally redacted.
 * These fixtures must never contain a real credential, device code, account ID,
 * authorization URL parameter, or provider request ID.
 */
export const REDACTED_RESPONSES_FIXTURES = Object.freeze({
  credentialReference: 'OPENAI_CODEX_OAUTH',
  persistedSession: '[REDACTED]',
  textResponse: {
    id: '[REDACTED]',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '[REDACTED]' }],
      },
    ],
  },
  streamingText: [
    { type: 'response.output_text.delta', delta: '[REDACTED]' },
    { type: 'response.completed', response: { id: '[REDACTED]', status: 'completed' } },
  ],
  streamingToolCall: [
    {
      type: 'response.function_call_arguments.delta',
      item_id: '[REDACTED]',
      output_index: 0,
      delta: '[REDACTED]',
    },
    {
      type: 'response.output_item.done',
      item: {
        id: '[REDACTED]',
        type: 'function_call',
        call_id: '[REDACTED]',
        name: '[REDACTED]',
        arguments: '[REDACTED]',
      },
    },
  ],
  requestUnauthorized: {
    status: 401,
    body: { error: { code: 'token_invalidated', message: '[REDACTED]' } },
  },
  refreshSuccess: {
    access_token: '[REDACTED_ACCESS_TOKEN]',
    refresh_token: '[REDACTED_REFRESH_TOKEN]',
    expires_in: 3600,
  },
  refreshTerminal: {
    status: 400,
    body: { error: 'invalid_grant', error_description: '[REDACTED]' },
  },
} as const)
