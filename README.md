# DeepSeek Harness Codex

> **Unofficial OAuth-backed Codex model provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

`@opencnid/dsh-llm-openai-codex` will make Codex available as an interactive DeepSeek Harness model through an OAuth-backed provider plugin.

## Status

Pre-alpha. The project is a behavior-preserving TypeScript port of Codex session handling and Responses translation to DeepSeek Harness public seams.

The deterministic adapter slice now validates persisted-session resolution, pre-credential bounded tool declarations, non-streaming text, SSE text streaming, function-call streaming, tool-result continuations, output-cap enforcement, bounded stream parsing and retained output, strict terminal status handling, and cancellation propagation. It is **not yet an installable Cordis plugin**: device login, authorized live OAuth transport, Cordis registration, value-free configuration UI, controlled live acceptance, and npm publication remain pending.

It is not affiliated with, endorsed by, or supported by OpenAI or DeepSeek.

## Planned behavior

- Device/browser OAuth login and explicit re-login state.
- One opaque, versioned OAuth session credential; no token values in settings/UI responses.
- Safe access-token refresh with cross-process contention control.
- Exclusive `openai-codex` route ownership with an explicit, value-free migration from conflicting generic profiles.
- Codex Responses text streaming, tool calls, cancellation, and model metadata mapped to the DeepSeek Harness LLM seam.

## Development

Requires Node.js 22.19+ and pnpm.

```bash
pnpm install --frozen-lockfile
pnpm check
```

No live OAuth configuration is documented until the provider-authorized client flow and the first controlled acceptance run are complete.

## License

[MIT](LICENSE)
