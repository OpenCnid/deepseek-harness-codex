# Hermes Codex behavior port contract

**Status:** source-grounded implementation contract — not authorization to use an OAuth client, endpoint, or first-party client identity.

## Purpose

This document defines the behavior that `@opencnid/dsh-llm-openai-codex` must preserve while adapting Hermes Agent’s Codex integration to DeepSeek Harness’s public TypeScript/Cordis APIs. It is intentionally a contract, not a source-code port.

| Surface | Contract |
|---|---|
| Provider route | `openai-codex` |
| Credential reference | `OPENAI_CODEX_OAUTH` |
| Persistence unit | One opaque, versioned OAuth-session value |
| Host adapter | DeepSeek Harness `LlmAdapter` |
| Scope | Interactive Codex via an OpenAI-permitted OAuth flow; not API-key OpenAI support |

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
- It resolves and writes the single credential reference through `ctx.credentials`; configuration and status surfaces use `describe()` and never receive the secret value.
- Every provider HTTP request includes `attributionHeaders()`.
- The eventual refresh transaction uses a cross-process lock around the entire resolve → evaluate → refresh → replace sequence. DeepSeek Harness publishes `withFileLock()` for this shape.

No upstream `src/*` internal import is permitted. No duplicate adapter route is permitted.

## Provider-route ownership and migration

`openai-codex` is exclusively owned by this plugin. A deployment must not configure
`llm-pi-ai.providers.openai-codex` while this plugin is enabled: DeepSeek Harness
atomically rejects duplicate adapter registration, leaving whichever adapter mounted
first as the active route.

Before enabling this plugin, the installer/configuration surface must remove the
`openai-codex` profile from the `llm-pi-ai` section and preserve it only as a
user-visible migration record; it must never copy a credential value into this
plugin or silently repurpose another provider route. The plugin's eventual mount
preflight must fail loudly and value-free when that route is already registered. It
must not unregister another adapter or mutate the user's `llm-pi-ai` settings.

A failed preflight leaves the existing adapter and all credential references intact.
Uninstalling this plugin likewise does not recreate a generic profile or write any
credential; reconfiguration is an explicit operator choice.

## OAuth authorization boundary

Hermes is evidence of desired behavior, **not** authority to reuse its OAuth application identity, device-flow parameters, first-party client headers, account-header conventions, or backend URL selection.

Before a live authorization implementation is enabled, OpenCnid must obtain and record:

1. an OpenAI-authorized client identity for this distribution;
2. the provider-approved OAuth grant/device-flow requirements and redirect behavior;
3. the permitted request authentication and account-context mechanism; and
4. the currently supported Codex/Responses endpoint and model entitlement policy.

Until those facts are available, the implementation may exercise only injected/fake OAuth transports in tests. It must not present itself as a first-party Codex client or send copied first-party-looking identifiers.

## Session lifecycle contract

### 1. Login is user-mediated and bounded

The authorized implementation presents only the provider-approved verification location and user code, polls no faster than the returned interval (with a safe local minimum), supports cancellation, and has a finite timeout. Pending authorization remains pending; it is not an error state and it is never persisted as a usable session.

A successful device result is exchanged by the provider-approved grant flow. The resulting access credentials, rotating refresh credentials, expiry information, and essential non-secret session metadata become one new session value only after validation succeeds.

### 2. One opaque persisted value

`OPENAI_CODEX_OAUTH` stores exactly one serialized, versioned state value. The stored value is always treated as `[REDACTED]` in logs, fixtures, documentation, diagnostics, UI, Git history, and error messages.

The in-memory state contract contains a schema version, usable access credentials, rotating refresh credentials, an expiry instant or equivalent expiry facts, and minimal non-secret session metadata. It is never split across independent credential references. Invalid JSON, unknown schema versions, missing credentials, and invalid expiry facts are terminal re-login states with value-free errors.

### 3. Restart recovery

A new Harness process re-resolves `OPENAI_CODEX_OAUTH` for each model operation. A valid, unexpired value enables an authenticated request without repeating device login. UI/status code may state `configured`, `expired`, or `re-login required`; it never reads or renders the value.

### 4. Refresh is proactive, serialized, and atomic

Before a request, the session layer evaluates expiry with a bounded skew. If renewal is necessary, it acquires the cross-process lock, re-resolves the credential under the lock, and evaluates expiry again. A waiting caller must adopt a prior caller’s freshly stored session instead of replaying an already-consumed refresh credential.

A successful refresh atomically replaces the complete session state. If the provider returns a new refresh credential, that credential replaces the old one in the same durable write as the new access credential and expiry facts.

The session store implements this transaction using the Harness credential seam plus a file lock rooted at the resolved Harness home (`locks/openai-codex-oauth`). It creates the lock parent owner-only, uses Harness `withFileLock()` to serialize processes, and re-reads the canonical credential after acquiring the lock. A read-only credential source is never refreshed or overwritten.

### 5. Failure classification

| Condition | Required behavior |
|---|---|
| Login pending | Continue bounded polling; no persistence yet |
| Login cancelled or expired | Stop cleanly; leave no usable session behind |
| Refresh rate limit or quota response | Preserve the session, report a retry-later state, and honor a supported delay when available |
| Invalid grant/token, refresh reuse, or token-endpoint 401/403 | Stop refreshing that chain, remove usable token material from the canonical session, retain only value-free diagnostics, and require re-login |
| Request-level 401 | At most one reactive refresh/client-rebuild/retry; never loop indefinitely or switch accounts |

## Responses adapter contract

The first authenticated vertical slice sends one stateless text turn assembled from the exact model, instructions/system content, and converted ordered conversation input. It does not rely on provider-side conversation state.

Subsequent slices translate provider streaming into the Harness protocol:

- emit indexed `block-start`, text/reasoning/tool deltas, `block-end`, optional usage, and exactly one terminal `finish`;
- emit no event after `finish`;
- preserve raw tool argument JSON and correlate tool call IDs with later tool results;
- honor `AbortSignal` for both request and stream cancellation; and
- keep opaque Responses replay material adapter-private and issuer-compatible. If opaque replay is rejected, disable it for that session and retry once with visible history and tool continuity intact.

Provider-native event parsing is isolated from `LlmAdapter`; no provider wire object leaks into the Harness-facing API.

## Value-free status contract

The configuration/model surface may expose only:

- `unconfigured`
- `authorizing`
- `configured`
- `refreshing`
- `re-login required`
- `error`

It must never expose access credentials, refresh credentials, device codes, authorization URLs carrying sensitive parameters, account identifiers, or raw provider error bodies.

## Deterministic acceptance tests

The following acceptance cases are required before any live release:

1. A valid versioned state round-trips in memory; malformed/unknown versions fail without including `[REDACTED]` contents in the error.
2. A fake authorized device transport completes login and stores one opaque session value.
3. A fake expired session triggers exactly one refresh across concurrent callers.
4. A rotated refresh result replaces the full persisted value; a fresh session object simulates restart and uses the replacement.
5. A retryable refresh failure preserves the prior session; terminal refresh failure requires re-login without revealing values.
6. A fake authenticated text response maps into legal Harness chunks.
7. Streaming text, tool calls, cancellation, request-401 recovery, and replay rejection each have deterministic tests.
8. A controlled live sequence, performed only with an authorized integration, proves login → persistence → text turn → forced-expiry test fixture → restart recovery → second text turn.

The forced-expiry scenario is a test fixture, never a user-facing command or production refresh mode.

## Explicitly deferred

- Live OAuth client identity, grant endpoints, scopes, redirect semantics, and provider authorization.
- First-party Codex/ChatGPT client fingerprinting and account-context headers.
- Live model catalog/status UI.
- Streaming tool calls, replay, cancellation, and native compaction implementation.
- Publication to npm.

These deferments do not relax the behavior contract; they prevent the project from inventing provider authorization or shipping an unsupported client identity.
