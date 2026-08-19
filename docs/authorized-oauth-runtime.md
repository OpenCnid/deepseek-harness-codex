# Authorized standalone Codex OAuth runtime

## What this package owns

The `openai-codex` plugin owns one **account-scoped**, encrypted OAuth session and the direct Responses transport that consumes its short-lived access credential. It does not read or write Pi CLI state, Hermes state, a broker endpoint, a model configuration file, or another application's credential store.

The runtime deliberately has two layers:

1. **Programmatic authorized-runtime factory** — a host integration supplies a non-serializable factory that returns an approved OAuth distribution contract, a stable canonical UTF-8 account scope, and a 256-bit encryption key obtained from a secure operating-system or deployment secret provider.
2. **Credential-free controller/status surface** — the host receives connected status and disconnect methods with no session credentials. Browser and device methods return the short-lived user-facing instructions required to complete that login, but those values are not persisted by the controller or included in status results.

The injected runtime is not a Cordis settings value. Do not put client metadata, endpoint contracts, encryption keys, session material, or any OAuth value in `cordis.yml`, model/provider settings, logs, docs, fixtures, or issue/PR discussion.

## Provider authority is required

The package embeds **no** provider client identity, endpoint, redirect, scope, header, or subscription entitlement. Before enabling live traffic, the deploying organization must separately obtain an approved public-client/distribution grant and transport contract from the provider. An OpenAI account or a copied implementation is not authority to reuse another application's client registration.

Until that contract is injected by the host, the plugin remains credential-gated and does not make network requests.

## Encryption and account isolation

The session serialization is authenticated-encrypted with AES-256-GCM before it is passed to the Harness credential provider for durable storage. A fresh random nonce is used for every write, and the derived credential identity is authenticated as associated data; ciphertext copied between scoped records, tampered ciphertext, malformed ciphertext, or a prior unbound ciphertext format fails closed without returning contents.

The encryption key is held only in process memory. The host must provide the same stable 32-byte key for the same account scope after restart, from a secure local secret provider. The plugin never persists, displays, or derives that key from an OAuth credential. If the key is lost, operators must disconnect the unreadable session and authorize again.

A stable, non-secret local `accountScope` produces a SHA-256-derived credential reference. The original scope is neither persisted by the plugin nor included in status output. Each controller is bound to one scope, so disconnecting or refreshing one scoped session cannot mutate another.

## Browser and device authorization

The controller supports both protocol-safe, host-mediated flows:

- `startBrowserLogin()` returns a PKCE authorization URL. The host opens it in the user's browser, then sends the registered redirect back to `complete()`. The redirect URI, state nonce, authorization code, and PKCE verifier are verified before token exchange.
- `startDeviceLogin()` returns the user-facing verification URI/code and expiry. The host calls `poll()` at the supplied interval. Pending responses remain pending; completion is persisted immediately; denial, expiry, or malformed data produces a value-free re-login result.

The controller persists a successful session internally and returns only `{ authenticated, expiresAt }`. Its frozen closure-backed surface has no reachable runtime property for the OAuth client or encrypted session store. `disconnect()` removes only its account-scoped encrypted credential.

## Refresh and direct transport

Every request re-resolves the account-scoped session. A valid session is used directly. Near expiry, refresh is single-flight under a private file lock beneath the Harness home; the lock is backed by an exclusive lockfile and serializes separate Node processes as well as concurrent calls in one process. The lock holder re-reads the credential after acquisition so it adopts a sibling's rotation instead of issuing a duplicate refresh. Terminal refresh failures remove only the affected scoped session and require login again.

An approved runtime automatically creates direct non-streaming and SSE Responses transports from the same injected contract. OAuth and non-streaming response bodies are bounded by both bytes and record count before strict decoding and parsing; rejected non-streaming bodies are cancelled before their public error is returned. The existing adapter continues to enforce streaming terminal states, tool-call and tool-result correlation, cancellation, bounded records/output, and mapped errors. Requests use the short-lived resolved access credential only in the outbound authorization header; it is never added to status, settings, errors, or logs.

## Controlled live acceptance

Deterministic tests use fake endpoints and explicitly redacted placeholders. A live acceptance test is opt-in and may run only with an authorized account, user consent, an approved distribution contract, and a secure local key source. Do not record provider responses or credentials in test output.
