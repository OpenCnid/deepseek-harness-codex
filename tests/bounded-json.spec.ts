import { describe, expect, it } from 'vitest'
import { BoundedJsonBodyError, readBoundedJson } from '../src/bounded-json.ts'

describe('bounded JSON reader', () => {
  it('cancels an oversized declared Content-Length before decoding or parsing it', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true },
    })
    const response = {
      headers: new Headers({ 'content-length': '6' }),
      body,
    } as unknown as Response

    await expect(readBoundedJson(response, 5)).rejects.toBeInstanceOf(BoundedJsonBodyError)
    expect(cancelled).toBe(true)
  })

  it('enforces a cumulative byte limit before decoding or parsing', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"a":'))
        stream.enqueue(new TextEncoder().encode('123}'))
        stream.close()
      },
    }))

    await expect(readBoundedJson(response, 8)).rejects.toBeInstanceOf(BoundedJsonBodyError)
  })

  it('cancels a response that exceeds its record bound with zero-length chunks', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        for (let index = 0; index <= 64; index += 1) stream.enqueue(new Uint8Array())
        stream.enqueue(new TextEncoder().encode('{"ok":true}'))
        stream.close()
      },
    }))

    await expect(readBoundedJson(response, 64)).rejects.toBeInstanceOf(BoundedJsonBodyError)
  })

  it('strictly decodes and parses an in-limit JSON body', async () => {
    await expect(readBoundedJson(new Response('{"ok":true}'), 64)).resolves.toEqual({ ok: true })
  })

  it('rejects malformed UTF-8 before JSON parsing', async () => {
    await expect(readBoundedJson(new Response(new Uint8Array([0xff])), 64)).rejects.toBeInstanceOf(BoundedJsonBodyError)
  })
})
