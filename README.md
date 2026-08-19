# DeepSeek Harness Codex

> **Unofficial OAuth-backed Codex model provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

`@opencnid/dsh-llm-openai-codex` will make Codex available as an interactive DeepSeek Harness model through an OAuth-backed provider plugin.

## Status

Pre-alpha. The project is a behavior-preserving TypeScript port of Codex session handling and Responses translation to DeepSeek Harness public seams.

The deterministic adapter slice now validates persisted-session resolution, pre-credential bounded tool declarations, non-streaming text, SSE text streaming, function-call streaming, tool-result continuations, output-cap enforcement, bounded stream parsing and retained output, strict terminal status handling, and cancellation propagation.

It now also has a **loadable Cordis entrypoint**: the package default export is `openAiCodexPlugin`. It requires `ctx.llm` and `ctx.credentials`, registers the exclusively owned `openai-codex` route, and registers a declarative `openai-codex` configuration entry for Harness surfaces. A request with no plugin-owned OAuth session fails as authentication-required before any network request. A programmatic `runtime` seam remains available for controlled tests and alternative authorized transports.

This package has no Hermes runtime, broker, or credential-store dependency. The plugin will own its OAuth sign-in, refresh, and direct provider transport; those lifecycle slices are still under development and are not live-provider tested.

It is not affiliated with, endorsed by, or supported by OpenAI or DeepSeek.

## Planned behavior

- Plugin-owned browser/manual redirect and device-code sign-in, with one opaque OAuth session in the Harness credential service.
- Serialized refresh and direct, authorized Responses transport without a Hermes or Pi-CLI credential bridge.
- Exclusive `openai-codex` route ownership with reject-only behavior for conflicts.
- Codex Responses text streaming, tool calls, cancellation, and model metadata mapped to the DeepSeek Harness LLM seam.

## Development

Requires Node.js 22.19+ and pnpm.

```bash
pnpm install --frozen-lockfile
pnpm check
```

The test suite uses only in-process fake upstreams. No live OAuth or provider acceptance request is made automatically.

## License

[MIT](LICENSE)
