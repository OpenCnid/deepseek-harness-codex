export const OPENAI_CODEX_PROVIDER = 'openai-codex'

export interface RegisteredProviderRoute {
  readonly id: string
}

export function assertOpenAiCodexRouteAvailable(providers: readonly RegisteredProviderRoute[]): void {
  for (const provider of providers) {
    if (provider.id === OPENAI_CODEX_PROVIDER) {
      throw new Error(
        'openai-codex is already registered; remove llm-pi-ai.providers.openai-codex before enabling this plugin',
      )
    }
  }
}
