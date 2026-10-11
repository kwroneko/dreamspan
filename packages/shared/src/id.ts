// UUIDv7: time-ordered, so `ORDER BY id` approximates creation order (DATA-MODEL §1).

/**
 * The annotation every id schema carries, naming the table its values point into. A brand
 * leaves no trace in a schema's AST, so this is how code finds the ids in one (state.ts).
 */
export const ID_TABLE = "rp/idTable"

let lastMs = 0
let sequence = 0

export const uuidv7 = (now: number = Date.now()): string => {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  // Keep ids monotonic within one millisecond by bumping a 12-bit counter.
  if (now === lastMs) {
    sequence = (sequence + 1) & 0xfff
  } else {
    lastMs = now
    sequence = ((bytes[6]! << 8) | bytes[7]!) & 0x7ff
  }
  bytes[0] = (now / 2 ** 40) & 0xff
  bytes[1] = (now / 2 ** 32) & 0xff
  bytes[2] = (now >>> 24) & 0xff
  bytes[3] = (now >>> 16) & 0xff
  bytes[4] = (now >>> 8) & 0xff
  bytes[5] = now & 0xff
  bytes[6] = 0x70 | (sequence >>> 8)
  bytes[7] = sequence & 0xff
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
