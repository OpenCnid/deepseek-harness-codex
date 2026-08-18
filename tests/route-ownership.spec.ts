import { describe, expect, it } from 'vitest'
import { assertOpenAiCodexRouteAvailable } from '../src/index.ts'

describe('openai-codex route ownership', () => {
  it('allows the dedicated plugin to claim an unregistered route', () => {
    expect(() => assertOpenAiCodexRouteAvailable([{ id: 'openai' }])).not.toThrow()
  })

  it('refuses to claim a route already registered by another adapter', () => {
    expect(() => assertOpenAiCodexRouteAvailable([{ id: 'openai-codex' }])).toThrow(
      'openai-codex is already registered; remove llm-pi-ai.providers.openai-codex before enabling this plugin',
    )
  })
})
