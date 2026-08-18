# DeepSeek Harness Codex

> **Unofficial OAuth-backed Codex model provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

`@opencnid/dsh-llm-openai-codex` will make Codex available as an interactive DeepSeek Harness model through an OAuth-backed provider plugin.

## Status

Pre-alpha. The project is a behavior-preserving TypeScript port of Codex session handling and Responses translation to DeepSeek Harness public seams.

The deterministic adapter slice now validates persisted-session resolution, pre-credential bounded tool declarations, non-streaming text, SSE text streaming, function-call streaming, tool-result continuations, output-cap enforcement, bounded stream parsing and retained output, strict terminal status handling, and cancellation propagation.

It now also has a **loadable Cordis entrypoint**: the package default export is `openAiCodexPlugin`. It requires `ctx.llm` and `ctx.credentials`, registers the exclusively owned `openai-codex` route, and registers a declarative `openai-codex` configuration entry for Harness surfaces. `getOpenAiCodexStatus()` queries the local Hermes broker health endpoint and exposes only `{ configured, writable }`; it never resolves, parses, logs, or returns an OAuth value.

The default runtime is a local Hermes Codex broker client. Start the supported broker with `hermes proxy start --provider openai-codex` after authenticating Hermes through `hermes auth add openai-codex`. DSH sends only Responses request data and a non-secret local marker to `http://127.0.0.1:8645/v1/responses`; Hermes resolves, refreshes, and attaches its private OAuth credential inside its own process. The plugin does not read Hermes auth storage, receive Hermes OAuth material, or persist any broker credential. A programmatic `runtime` seam remains available for controlled tests and alternative authorized transports.

It is not affiliated with, endorsed by, or supported by OpenAI or DeepSeek.

## Planned behavior

- Hermes-managed device/browser sign-in; no OAuth login UI or OAuth values in the plugin.
- A local Hermes broker boundary that keeps authentication, refresh, and provider tokens in Hermes.
- Exclusive `openai-codex` route ownership with reject-only behavior for conflicts.
- Codex Responses text streaming, tool calls, cancellation, and model metadata mapped to the DeepSeek Harness LLM seam.

## Development

Requires Node.js 22.19+ and pnpm.

```bash
pnpm install --frozen-lockfile
pnpm check
```

For the serial, affected-only broker gate while this modular work is in progress:

```bash
# Hermes checkout: proxy adapter, private-auth boundary, local forwarding, refresh retry, and route/method restrictions.
scripts/run_codex_broker_tests.sh

# DSH checkout: Cordis broker default, no credential resolution, broker-health status, typecheck, and build.
pnpm run check:broker
```

The test suite uses only in-process fake upstreams. No live OAuth or provider acceptance request is made automatically.

## License

[MIT](LICENSE)
