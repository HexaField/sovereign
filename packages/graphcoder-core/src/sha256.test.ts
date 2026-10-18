import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './sha256.js'

const reference = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    )
  })

  it('agrees with node:crypto at every padding boundary and over many blocks', () => {
    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70_000]) {
      const text = 'x'.repeat(length)
      expect(sha256Hex(text), `length ${length}`).toBe(reference(text))
    }
  })

  it('hashes the UTF-8 bytes of non-ASCII text', () => {
    for (const text of ['é', 'naïve café', '日本語', '🙂 emoji', 'function\0add\0(a: number)']) {
      expect(sha256Hex(text), text).toBe(reference(text))
    }
  })
})
