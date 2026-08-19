# DeepSeek Harness Codex

> **Unofficial OAuth-backed Codex model provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

`@opencnid/dsh-llm-openai-codex` will make Codex available as an interactive DeepSeek Harness model through an OAuth-backed provider plugin.

## Status

Pre-alpha. The project is a behavior-preserving TypeScript port of Codex session handling and Responses translation to DeepSeek Harness public seams.

The deterministic adapter slice now validates persisted-session resolution, pre-credential bounded tool declarations, non-streaming text, SSE text streaming, function-call streaming, tool-result continuations, output-cap enforcement, bounded stream parsing and retained output, strict terminal status handling, and cancellation propagation.

It now also has a **loadable Cordis entrypoint**: the package default export is `openAiCodexPlugin`. It requires `ctx.llm` and `ctx.credentials`, registers the exclusively owned `openai-codex` route, and registers a declarative value-free configuration entry for Harness surfaces. A request with no plugin-owned OAuth session fails as authentication-required before any network request. The programmatic `runtime` seam supports deterministic tests; its authorized form is a non-serializable factory that supplies the plugin-owned live lifecycle without placing OAuth material in Cordis settings.

This package has no Hermes runtime, broker, Pi-CLI state, or external credential-store dependency. Its authorized runtime provides PKCE browser redirects, device-code polling, AES-256-GCM encrypted account-scoped sessions, value-free status/disconnect operations, cross-process refresh coordination, and direct Responses text/SSE transports. It embeds no provider client identity, endpoint, grant, or entitlement. See [the authorized runtime contract](docs/authorized-oauth-runtime.md).

It is not affiliated with, endorsed by, or supported by OpenAI or DeepSeek.

## Runtime requirements

Live traffic is opt-in. A host integration must inject an approved provider distribution contract, a stable non-secret canonical UTF-8 account scope, and a stable 32-byte encryption key sourced from a secure operating-system or deployment secret provider. These values must never be placed in `cordis.yml`, model settings, logs, fixtures, or public issue/PR discussion.

The controller exposes browser/device progress and `{ authenticated, expiresAt }` status only; it never exposes session credentials. Controlled live acceptance requires an authorized account and user consent. The test suite always uses fake upstreams.

## Delivered behavior

- Plugin-owned PKCE browser/manual redirect and device-code sign-in with encrypted account-scoped persistence.
- Refresh-on-demand under a private cross-process file lock, including terminal re-login cleanup.
- Direct, authorized Responses text and SSE streaming with tool calls, cancellation, and strict error mapping.
- Exclusive `openai-codex` route ownership with reject-only behavior for conflicts.

## Development

Requires Node.js 22.19+ and pnpm.

```bash
pnpm install --frozen-lockfile
pnpm check
```

The test suite uses only in-process fake upstreams. No live OAuth or provider acceptance request is made automatically.

## License

[MIT](LICENSE)
