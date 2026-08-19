const DEFAULT_MAX_JSON_BYTES = 1024 * 1024
const MAX_JSON_CHUNKS = 4 * 1024

export class BoundedJsonBodyError extends Error {
  constructor() {
    super('JSON response body is invalid or exceeds its configured limit')
    this.name = 'BoundedJsonBodyError'
  }
}

function invalidJson(): never {
  throw new BoundedJsonBodyError()
}

function declaredLength(response: Response): number | undefined {
  const header = response.headers.get('content-length')
  if (header === null || !/^(?:0|[1-9][0-9]*)$/.test(header)) return undefined
  const value = Number(header)
  return Number.isSafeInteger(value) ? value : undefined
}

export async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Preserve the caller's value-free error if the peer refuses cancellation.
  }
}

async function cancel(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // The caller receives the bounded, value-free error regardless of cleanup.
  }
}

/**
 * Reads a JSON response with a cumulative byte limit before constructing a
 * string or JSON value. It deliberately never calls Response.json(), whose
 * buffering policy is controlled by the upstream implementation.
 */
export async function readBoundedJson(response: Response, maximumBytes: number = DEFAULT_MAX_JSON_BYTES): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) return invalidJson()
  const advertised = declaredLength(response)
  if (advertised !== undefined && advertised > maximumBytes) {
    await discardResponseBody(response)
    return invalidJson()
  }
  if (response.body === null) return invalidJson()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  const maximumChunks = Math.min(maximumBytes, MAX_JSON_CHUNKS)
  let chunkCount = 0
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      const chunk = result.value
      chunkCount += 1
      if (chunkCount > maximumChunks || !(chunk instanceof Uint8Array) || chunk.byteLength > maximumBytes - total) {
        await cancel(reader)
        return invalidJson()
      }
      if (chunk.byteLength === 0) continue
      total += chunk.byteLength
      chunks.push(chunk)
    }
  } catch {
    await cancel(reader)
    return invalidJson()
  } finally {
    reader.releaseLock()
  }

  if (total === 0) return invalidJson()
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    return JSON.parse(text)
  } catch {
    return invalidJson()
  }
}
