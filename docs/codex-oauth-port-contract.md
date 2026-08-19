# Standalone Codex OAuth behavior contract

## Purpose

`@opencnid/dsh-llm-openai-codex` provides the dedicated `openai-codex` route for DeepSeek Harness. It owns the route, its OAuth lifecycle, and its direct authorized Responses transport.

## Scope

- The plugin persists one opaque, versioned OAuth session through the Harness credential service.
- Browser/manual-redirect and device-code login are required user-facing flows.
- Refresh re-resolves the credential inside a user-private lock, rotates only to a writable source, and returns a value-free re-login result after a terminal failure.
- The adapter preserves bounded Responses text streaming, function calls, tool-result continuations, cancellation, output caps, and terminal-state validation.
- A route conflict fails before any registration or mutation. Operators must remove the generic `llm-pi-ai.providers.openai-codex` route before enabling this specialized plugin.

## Reference boundary

Pi is behavioral reference material only. Its browser/device interaction patterns, refresh lifecycle, and response translation can inform tests and user experience. This package does not read Pi CLI state, reuse another application's OAuth client identity, deep-import private source files, or transfer credentials between applications.

## Authority boundary

A public implementation is not authorization to reuse its client identity, grants, scopes, redirects, request headers, endpoints, account conventions, or service entitlements. Before live login or direct provider traffic, record an approved distribution client/grant and the corresponding provider transport contract. Until then, use deterministic injected transports only.

## Credential boundary

The persisted session is opaque outside the auth module. Tokens, device codes, callback values, account identifiers, raw provider bodies, and raw credential state must not appear in settings, logs, status output, errors, fixtures, tests, documentation, commits, or PR discussion.

## Current implementation stage

The package provides an authorized, injected OAuth runtime factory: PKCE browser redirects, device-code polling, AES-256-GCM encrypted canonical-UTF-8 account-scoped persistence, credential-free status/disconnect ownership, refresh under a cross-process file lock, bounded OAuth/non-streaming JSON parsing, and direct Responses text/SSE transports. It contains no provider-specific distribution client, endpoint, grant, or entitlement.

Live acceptance remains opt-in. It requires an approved provider distribution contract, an eligible user account with consent, and a secure stable local key source; deterministic tests use injected fake transports only. See [Authorized runtime](authorized-oauth-runtime.md).
