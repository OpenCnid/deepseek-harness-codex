# Hermes Codex behavior port contract

**Status:** source-grounded local-broker contract — it does not authorize the DSH package to reuse an OAuth client, endpoint, or first-party client identity.

## Purpose

This document defines the behavior that `@opencnid/dsh-llm-openai-codex` must preserve while adapting Hermes Agent’s Codex integration to DeepSeek Harness’s public TypeScript/Cordis APIs. It is intentionally a contract, not a source-code port.

| Surface | Contract |
|---|---|
| Provider route | `openai-codex` |
| Credential reference | No DSH OAuth credential in the default broker path |
| Persistence unit | Hermes-owned OAuth session; DSH persists no broker credential |
| Host adapter | DeepSeek Harness `LlmAdapter` via the local Hermes proxy |
| Scope | Interactive Codex through the user-authenticated Hermes broker; not API-key OpenAI support |

## Provenance and license boundary

| Source | Revision | Use in this project |
|---|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca) | `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` | Public Cordis, LLM, credential, attribution, and file-lock contracts |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/133381508fb111955fe68e4c4e31d5a0c906a8e7) | `133381508fb111955fe68e4c4e31d5a0c906a8e7` | Behavioral reference for device login, session renewal, error classification, and Responses translation |

Both source trees are MIT licensed at the recorded revisions. This document and its redacted fixtures are an independent behavioral specification, not copied implementation code. Any future copied or materially derived source must retain the applicable notices.

## Host boundary

The plugin must use only published DeepSeek Harness contracts:

- It is mounted as a Cordis plugin and registers the unique provider route `openai-codex` through `ctx.llm.registerAdapter()`.
- It subclasses `LlmAdapter` and implements `stream(options)`, honoring `options.signal` and emitting only Harness `StreamChunk` events.
- The default runtime sends Responses requests to Hermes’s loopback Codex proxy at `http://127.0.0.1:8645/v1/responses`. It uses only a fixed non-secret local marker; it does not resolve, read, write, log, or return a DSH OAuth credential.
- Hermes’s proxy resolves and refreshes its own managed OAuth session inside the Hermes process, replaces the inbound marker, and forwards only `POST /v1/responses` upstream. DSH never receives a Hermes access token, refresh token, auth-store value, device code, OAuth client material, or raw broker authentication error.
- Every forwarded Responses request includes `attributionHeaders()`.

No upstream `src/*` internal import is permitted. No duplicate adapter route is permitted.

## Provider-route ownership and migration

`openai-codex` is exclusively owned by this plugin. A deployment must not configure
`llm-pi-ai.providers.openai-codex` while this plugin is enabled: DeepSeek Harness
atomically rejects duplicate adapter registration, leaving whichever adapter mounted
first as the active route.

The plugin performs reject-only preflight: it never copies, imports, migrates,
adopts, unregisters, or mutates another provider’s route or credential state. A
failed preflight leaves the existing adapter and all credential references intact.
Uninstalling this plugin likewise does not recreate a generic profile or write any
credential; reconfiguration is an explicit operator choice.

## OAuth authorization and broker boundary

Hermes is evidence of desired behavior, **not** authorization for the DSH package
to reuse Hermes’s OAuth application identity, device-flow parameters, first-party
client headers, account-header conventions, or backend URL selection. The DSH
package does none of those things.

The supported handoff is a local first-party Hermes boundary:

1. The operator completes `hermes auth add openai-codex` in Hermes.
2. The operator starts `hermes proxy start --provider openai-codex` on the default
   loopback binding, or explicitly configures an equivalent local Hermes proxy.
3. The DSH plugin sends OpenAI Responses payloads to the loopback proxy. It sends
   no Hermes OAuth credential and never opens Hermes’s credential storage.
4. The Hermes `OpenAICodexAdapter` is the sole component that calls its own
   Codex runtime resolver, performs refresh/rotation, and attaches the resulting
   bearer upstream. On an upstream 401 it can force at most one Hermes-managed
   refresh and retry when the credential changed.

The broker forwards only `POST /v1/responses`; it rejects other paths and methods
before resolving a credential. Its health endpoint exposes only safe metadata:
`status`, a display name, and an `authenticated` boolean. The DSH status helper
maps that to `{ configured, writable: false }` and discards all other values.

No DSH credential reference, session state, access credential, refresh credential,
device code, verification URL, client material, provider error body, or account
metadata is persisted, rendered, logged, serialized, or returned by the default
broker path. The earlier `OPENAI_CODEX_OAUTH` state codec remains a testable
legacy programmatic seam; it is not used by the default Cordis runtime.

## Responses adapter contract

The first authenticated vertical slice sends one stateless text turn assembled from the exact model, instructions/system content, and converted ordered conversation input. It does not rely on provider-side conversation state.

Subsequent slices translate provider streaming into the Harness protocol:

- validate and snapshot declared tools before credential resolution: at most 64, nonempty names ≤256 UTF-8 bytes, descriptions ≤8 KiB, and JSON-object parameter schemas ≤1 MiB; then forward only the sanitized copies;
- enforce the same structural chunk lifecycle for configured stream callbacks: unique active indexes, matching block types, no more than 64 active blocks or 64 tool identities, and exact tool ID/name continuity from delta through block completion;
- emit indexed `block-start`, text/reasoning/tool deltas, `block-end`, optional usage, and exactly one terminal `finish`;
- emit no event after `finish`; a `response.completed` event must carry `status: "completed"` before emitting natural completion, while a `response.incomplete` event maps to `max-tokens` only with `status: "incomplete"` and `incomplete_details.reason: "max_output_tokens"`;
- preserve raw tool argument JSON; require each streamed tool-call ID to be unique, preserve its identical ID/name from start through completion, correlate it with exactly one later tool result, and reject streams exceeding 64 retained tool-call identities;
- bound each network delivery to 4 MiB, each retained SSE frame to 1 MiB, and open output-block count plus per-block and aggregate retained output (including tool metadata and completed tool-call identities), failing value-free on any limit; decode UTF-8 strictly, accept CR, LF, or CRLF SSE line endings, and reject unterminated records at EOF;
- honor `AbortSignal` for both request and stream cancellation, actively cancelling the response reader on caller abort and preventing remaining buffered records or output chunks from being emitted; and
- keep opaque Responses replay material adapter-private and issuer-compatible. If opaque replay is rejected, disable it for that session and retry once with visible history and tool continuity intact.

Provider-native event parsing is isolated from `LlmAdapter`; no provider wire object leaks into the Harness-facing API.

## Value-free status contract

The configuration/model surface may expose only safe broker state, currently
`{ configured, writable: false }`, where `configured` means that the loopback
Hermes broker reports an authenticated Codex session. If the broker is absent,
unreachable, malformed, or unauthenticated, the helper returns `configured: false`.
It must never expose access credentials, refresh credentials, device codes,
authorization URLs carrying sensitive parameters, account identifiers, raw provider
error bodies, or health payload fields other than the safe boolean.

## Deterministic acceptance tests

The following acceptance cases are required before release:

1. Hermes registers `openai-codex`; its CLI help and provider list advertise it.
2. Hermes has an authenticated-state check that reads no token value and a resolver
   failure that returns only a generic re-authentication error.
3. The broker forwards only `POST /v1/responses`, replaces the inbound marker with
   the Hermes-resolved bearer, and rejects all other paths or methods before
   credential resolution.
4. An upstream 401 causes at most one forced Hermes refresh and retry, only when
   the resolver returns a changed credential.
5. The Cordis default runtime sends a deterministic Responses stream to the
   loopback broker and performs zero DSH credential resolutions.
6. The broker-health status function returns only `{ configured, writable: false }`
   and does not surface arbitrary health payload data.
7. Streaming text, tool calls, cancellation, request-401 recovery, and replay
   rejection each have deterministic tests.
8. A controlled live sequence, performed only after explicit authorization, proves
   Hermes login → local broker → DSH text turn without logging, exporting, or
   persisting Hermes OAuth material in DSH.

## Explicitly deferred

- A direct DSH-owned OAuth client identity, grant endpoints, scopes, redirect semantics, and provider authorization.
- First-party Codex/ChatGPT client fingerprinting and account-context headers.
- Controlled live acceptance against an authenticated broker, including upstream request-401 recovery and replay support.
- Publication to npm.

These deferments do not relax the broker boundary; they prevent the DSH package
from inventing provider authorization or shipping an unsupported client identity.
