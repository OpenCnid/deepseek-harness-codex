import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { Buffer } from 'node:buffer'

const CIPHER_VERSION = 'v2'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const MAX_PLAINTEXT_BYTES = 32 * 1024
const MAX_CREDENTIAL_BINDING_BYTES = 4 * 1024
const MAX_ENCRYPTED_BYTES = 64 * 1024
const BASE64URL = /^[A-Za-z0-9_-]+$/

export interface OAuthSessionCipher {
  seal(plaintext: string, credentialBinding: string): string
  open(ciphertext: string, credentialBinding: string): string
}

function invalidKey(): never {
  throw new Error('Invalid OpenAI Codex OAuth encryption key')
}

function invalidSession(): never {
  throw new Error('Invalid encrypted OpenAI Codex OAuth session')
}

function decoded(value: string, expectedBytes?: number): Buffer {
  if (!BASE64URL.test(value)) return invalidSession()
  let result: Buffer
  try {
    result = Buffer.from(value, 'base64url')
  } catch {
    return invalidSession()
  }
  if (result.length === 0 || result.toString('base64url') !== value || (expectedBytes !== undefined && result.length !== expectedBytes)) {
    return invalidSession()
  }
  return result
}

function validPlaintext(value: string): Buffer {
  if (typeof value !== 'string') return invalidSession()
  const result = Buffer.from(value, 'utf8')
  if (result.length === 0 || result.length > MAX_PLAINTEXT_BYTES || result.toString('utf8') !== value) return invalidSession()
  return result
}

function validCredentialBinding(value: string): Buffer {
  if (typeof value !== 'string') return invalidSession()
  const result = Buffer.from(value, 'utf8')
  if (result.length === 0 || result.length > MAX_CREDENTIAL_BINDING_BYTES || result.toString('utf8') !== value) return invalidSession()
  return result
}

/**
 * Encrypts opaque OAuth-session serializations before they are passed to the
 * configured credential provider. The caller supplies a stable, plugin-owned
 * 256-bit key from a secure operating-system or deployment secret provider;
 * this module never persists or logs that key.
 */
export function createAes256GcmSessionCipher(key: Uint8Array): OAuthSessionCipher {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) return invalidKey()
  const encryptionKey = Buffer.from(key)

  return {
    seal(plaintext: string, credentialBinding: string): string {
      const input = validPlaintext(plaintext)
      const associatedData = validCredentialBinding(credentialBinding)
      const iv = randomBytes(IV_BYTES)
      try {
        const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv, { authTagLength: TAG_BYTES })
        cipher.setAAD(associatedData)
        const encrypted = Buffer.concat([cipher.update(input), cipher.final()])
        const tag = cipher.getAuthTag()
        return [CIPHER_VERSION, iv.toString('base64url'), encrypted.toString('base64url'), tag.toString('base64url')].join('.')
      } catch {
        return invalidSession()
      }
    },

    open(ciphertext: string, credentialBinding: string): string {
      const associatedData = validCredentialBinding(credentialBinding)
      if (typeof ciphertext !== 'string' || Buffer.byteLength(ciphertext, 'utf8') > MAX_ENCRYPTED_BYTES) return invalidSession()
      const parts = ciphertext.split('.')
      if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) return invalidSession()
      const iv = decoded(parts[1] ?? '', IV_BYTES)
      const encrypted = decoded(parts[2] ?? '')
      const tag = decoded(parts[3] ?? '', TAG_BYTES)
      try {
        const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv, { authTagLength: TAG_BYTES })
        decipher.setAAD(associatedData)
        decipher.setAuthTag(tag)
        const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()])
        if (plaintext.length === 0 || plaintext.length > MAX_PLAINTEXT_BYTES) return invalidSession()
        const result = plaintext.toString('utf8')
        if (Buffer.from(result, 'utf8').compare(plaintext) !== 0) return invalidSession()
        return result
      } catch {
        return invalidSession()
      }
    },
  }
}
