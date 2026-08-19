import { createHash } from 'node:crypto'

const MAX_ACCOUNT_SCOPE_BYTES = 4 * 1024

/**
 * Validates an opaque account scope as a canonical UTF-8 JavaScript string and
 * derives its stable, non-reversible SHA-256 identifier. Using the validated
 * UTF-8 bytes for both credential and lock derivation prevents lossy Unicode
 * replacement from collapsing separate account scopes.
 */
export function hashOpenAiCodexAccountScope(accountScope: string): string {
  if (typeof accountScope !== 'string' || accountScope.length === 0) {
    throw new Error('OpenAI Codex OAuth account scope is invalid')
  }
  const bytes = Buffer.from(accountScope, 'utf8')
  if (bytes.byteLength > MAX_ACCOUNT_SCOPE_BYTES || bytes.toString('utf8') !== accountScope) {
    throw new Error('OpenAI Codex OAuth account scope is invalid')
  }
  return createHash('sha256').update(bytes).digest('hex')
}
