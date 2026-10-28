// Minimal MD5 (RFC 1321) for environments without Node's crypto module, e.g. the Android
// WebView. Web Crypto does not offer MD5, but Moodle signs its app login tokens with it.
// Not for security purposes beyond checking that signature.

const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

const CONSTANTS = Array.from(
  { length: 64 },
  (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0,
)

/** Pads the message as MD5 requires: a 1 bit, zeros, then the bit length (little endian) */
function pad(message: Uint8Array): Uint8Array {
  const length = (((message.length + 8) >> 6) + 1) << 6
  const padded = new Uint8Array(length)
  padded.set(message)
  padded[message.length] = 0x80
  const view = new DataView(padded.buffer)
  const bitLength = message.length * 8
  view.setUint32(length - 8, bitLength >>> 0, true)
  view.setUint32(length - 4, Math.floor(bitLength / 2 ** 32), true)
  return padded
}

const rotateLeft = (value: number, bits: number) => (value << bits) | (value >>> (32 - bits))

export function md5Hex(input: string): string {
  const data = pad(new TextEncoder().encode(input))
  const view = new DataView(data.buffer)
  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  for (let block = 0; block < data.length; block += 64) {
    const words = Array.from({ length: 16 }, (_, i) => view.getUint32(block + i * 4, true))
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let wordIndex: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        wordIndex = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        wordIndex = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        wordIndex = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        wordIndex = (7 * i) % 16
      }
      const next = d
      d = c
      c = b
      b = (b + rotateLeft((a + f + CONSTANTS[i] + words[wordIndex]) | 0, SHIFTS[i])) | 0
      a = next
    }
    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
  }

  const digest = new DataView(new ArrayBuffer(16))
  ;[a0, b0, c0, d0].forEach((value, i) => digest.setUint32(i * 4, value, true))
  return Array.from(new Uint8Array(digest.buffer), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}
