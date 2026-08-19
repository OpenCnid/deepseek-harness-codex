import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { createAes256GcmSessionCipher } from '../src/index.ts'

const binding = '[REDACTED_CREDENTIAL_BINDING]'

describe('encrypted OAuth session cipher', () => {
  it('round-trips opaque session state without leaving plaintext in the stored value', () => {
    const cipher = createAes256GcmSessionCipher(Buffer.alloc(32, 7))
    const plaintext = '{"accessToken":"[REDACTED_ACCESS_TOKEN]"}'

    const encrypted = cipher.seal(plaintext, binding)

    expect(encrypted).not.toContain(plaintext)
    expect(cipher.open(encrypted, binding)).toBe(plaintext)
  })

  it('rejects a tampered encrypted session without echoing its content', () => {
    const cipher = createAes256GcmSessionCipher(Buffer.alloc(32, 7))
    const encrypted = cipher.seal('{"accessToken":"[REDACTED_ACCESS_TOKEN]"}', binding)
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('A') ? 'B' : 'A'}`

    expect(() => cipher.open(tampered, binding)).toThrow('Invalid encrypted OpenAI Codex OAuth session')
  })

  it('rejects a session sealed for a different credential binding', () => {
    const cipher = createAes256GcmSessionCipher(Buffer.alloc(32, 7))
    const encrypted = cipher.seal('{"accessToken":"[REDACTED_ACCESS_TOKEN]"}', '[REDACTED_CREDENTIAL_BINDING_A]')

    expect(() => cipher.open(encrypted, '[REDACTED_CREDENTIAL_BINDING_B]')).toThrow('Invalid encrypted OpenAI Codex OAuth session')
  })

  it('rejects an invalid encryption key before any session value is processed', () => {
    expect(() => createAes256GcmSessionCipher(Buffer.alloc(31))).toThrow('Invalid OpenAI Codex OAuth encryption key')
  })
})
