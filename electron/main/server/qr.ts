/**
 * A QR encoder.
 *
 * Typing `https://192.168.1.251:8787` into a phone keyboard, correctly, is the
 * kind of small friction that stops a feature being used. Pointing a camera at
 * the screen is not.
 *
 * Written here rather than pulled in: this project has no runtime dependencies
 * and a QR code is a well-specified thing. Byte mode, error correction level M,
 * versions 1 to 10 — which carries 213 bytes, far more than any address this
 * ever encodes.
 */

// ── GF(256), the field Reed–Solomon works in ────────────────────────────────
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    // x * 2 in GF(256) with the QR primitive polynomial 0x11d.
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}

const mul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]

/** The generator polynomial for `degree` error-correction codewords. */
function generator(degree: number): Uint8Array {
  let poly = new Uint8Array([1])
  for (let d = 0; d < degree; d++) {
    const next = new Uint8Array(poly.length + 1)
    for (let i = 0; i < poly.length; i++) {
      next[i] ^= poly[i]
      next[i + 1] ^= mul(poly[i], EXP[d])
    }
    poly = next
  }
  return poly
}

function ecCodewords(data: Uint8Array, count: number): Uint8Array {
  const gen = generator(count)
  const rem = new Uint8Array(count)
  for (const byte of data) {
    const factor = byte ^ rem[0]
    rem.copyWithin(0, 1)
    rem[count - 1] = 0
    for (let i = 0; i < count; i++) rem[i] ^= mul(gen[i + 1], factor)
  }
  return rem
}

// ── version tables, error-correction level M ────────────────────────────────
interface Spec {
  /** Error-correction codewords per block. */
  ec: number
  /** [blockCount, dataCodewordsPerBlock] for each of the one or two groups. */
  groups: [number, number][]
}

const SPECS: Record<number, Spec> = {
  1: { ec: 10, groups: [[1, 16]] },
  2: { ec: 16, groups: [[1, 28]] },
  3: { ec: 26, groups: [[1, 44]] },
  4: { ec: 18, groups: [[2, 32]] },
  5: { ec: 24, groups: [[2, 43]] },
  6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] },
  8: { ec: 22, groups: [[2, 38], [2, 39]] },
  9: { ec: 22, groups: [[3, 36], [2, 37]] },
  10: { ec: 26, groups: [[4, 43], [1, 44]] }
}

const ALIGNMENT: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
}

/** Pre-computed 18-bit version information, for versions 7 and above. */
const VERSION_INFO: Record<number, number> = {
  7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3
}

/** Pre-computed 15-bit format information for level M, indexed by mask. */
const FORMAT_INFO = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0
]

function dataCapacity(version: number): number {
  return SPECS[version].groups.reduce((n, [blocks, size]) => n + blocks * size, 0)
}

function chooseVersion(byteLength: number): number {
  for (let v = 1; v <= 10; v++) {
    // Mode indicator (4 bits) + character count + payload, in bytes.
    const countBits = v < 10 ? 8 : 16
    const needed = Math.ceil((4 + countBits) / 8) + byteLength
    if (needed <= dataCapacity(v)) return v
  }
  throw new Error('too much data for a version-10 QR code')
}

// ── bit assembly ────────────────────────────────────────────────────────────
class Bits {
  private bits: number[] = []
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1)
  }
  get length(): number {
    return this.bits.length
  }
  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8))
    this.bits.forEach((b, i) => {
      if (b) out[i >> 3] |= 0x80 >> (i & 7)
    })
    return out
  }
}

function encodeData(text: string, version: number): Uint8Array {
  const payload = new TextEncoder().encode(text)
  const capacity = dataCapacity(version)
  const bits = new Bits()
  bits.push(0b0100, 4)                       // byte mode
  bits.push(payload.length, version < 10 ? 8 : 16)
  for (const b of payload) bits.push(b, 8)

  // Terminator, then pad to a byte boundary.
  const remaining = capacity * 8 - bits.length
  bits.push(0, Math.min(4, remaining))
  if (bits.length % 8 !== 0) bits.push(0, 8 - (bits.length % 8))

  const bytes = bits.toBytes()
  const out = new Uint8Array(capacity)
  out.set(bytes)
  // The specified alternating pad, for whatever space is left.
  for (let i = bytes.length; i < capacity; i++) out[i] = (i - bytes.length) % 2 === 0 ? 0xec : 0x11
  return out
}

/**
 * Splits into blocks, computes error correction, and interleaves.
 *
 * Interleaving is what makes a QR code survive a thumb over one corner: it
 * spreads each block across the symbol so damage is shared rather than
 * destroying any single block outright.
 */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const spec = SPECS[version]
  const dataBlocks: Uint8Array[] = []
  const ecBlocks: Uint8Array[] = []
  let offset = 0
  for (const [count, size] of spec.groups) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(offset, offset + size)
      offset += size
      dataBlocks.push(block)
      ecBlocks.push(ecCodewords(block, spec.ec))
    }
  }

  const out: number[] = []
  const maxData = Math.max(...dataBlocks.map((b) => b.length))
  for (let i = 0; i < maxData; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i])
  }
  for (let i = 0; i < spec.ec; i++) {
    for (const b of ecBlocks) out.push(b[i])
  }
  return new Uint8Array(out)
}

// ── the matrix ──────────────────────────────────────────────────────────────
type Grid = { size: number; modules: Int8Array }

const at = (g: Grid, x: number, y: number): number => g.modules[y * g.size + x]
const set = (g: Grid, x: number, y: number, v: number): void => {
  g.modules[y * g.size + x] = v
}

/** Lays down everything whose position is fixed by the version, not the data. */
function functionPatterns(version: number): { grid: Grid; reserved: Uint8Array } {
  const size = version * 4 + 17
  const grid: Grid = { size, modules: new Int8Array(size * size).fill(-1) }
  const reserved = new Uint8Array(size * size)

  const reserve = (x: number, y: number): void => {
    reserved[y * size + x] = 1
  }

  // Finder patterns and their separators, at three corners.
  const finder = (cx: number, cy: number): void => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= size || y >= size) continue
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3))
        set(grid, x, y, ring === 2 || ring > 3 ? 0 : 1)
        reserve(x, y)
      }
    }
  }
  finder(0, 0)
  finder(size - 7, 0)
  finder(0, size - 7)

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0
    set(grid, i, 6, v)
    set(grid, 6, i, v)
    reserve(i, 6)
    reserve(6, i)
  }

  // Alignment patterns, everywhere they do not collide with a finder.
  const centres = ALIGNMENT[version]
  for (const cy of centres) {
    for (const cx of centres) {
      const nearFinder =
        (cx <= 8 && cy <= 8) || (cx <= 8 && cy >= size - 9) || (cx >= size - 9 && cy <= 8)
      if (nearFinder) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ring = Math.max(Math.abs(dx), Math.abs(dy))
          set(grid, cx + dx, cy + dy, ring === 1 ? 0 : 1)
          reserve(cx + dx, cy + dy)
        }
      }
    }
  }

  // The dark module, which is always set.
  set(grid, 8, size - 8, 1)
  reserve(8, size - 8)

  // Format information areas, filled in after masking.
  for (let i = 0; i < 9; i++) {
    if (at(grid, i, 8) === -1) reserve(i, 8)
    if (at(grid, 8, i) === -1) reserve(8, i)
  }
  for (let i = 0; i < 8; i++) {
    reserve(size - 1 - i, 8)
    reserve(8, size - 1 - i)
  }

  // Version information, for versions 7 and above.
  if (version >= 7) {
    const info = VERSION_INFO[version]
    for (let i = 0; i < 18; i++) {
      const bit = (info >> i) & 1
      const a = Math.floor(i / 3)
      const b = (i % 3) + size - 11
      set(grid, a, b, bit)
      set(grid, b, a, bit)
      reserve(a, b)
      reserve(b, a)
    }
  }

  return { grid, reserved }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
]

/** Walks the zig-zag path the specification defines and drops the bits in. */
function placeData(grid: Grid, reserved: Uint8Array, codewords: Uint8Array): void {
  const size = grid.size
  let bit = 0
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern and is skipped entirely.
    if (right === 6) right = 5
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step
      for (const x of [right, right - 1]) {
        if (reserved[y * size + x]) continue
        const byte = codewords[bit >> 3] ?? 0
        set(grid, x, y, (byte >> (7 - (bit & 7))) & 1)
        bit++
      }
    }
    upward = !upward
  }
}

/** The penalty rules, which pick the mask that scans most reliably. */
function penalty(grid: Grid): number {
  const size = grid.size
  let score = 0

  // Rule 1: runs of five or more identical modules.
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1
      for (let j = 1; j < size; j++) {
        const a = horizontal ? at(grid, j - 1, i) : at(grid, i, j - 1)
        const b = horizontal ? at(grid, j, i) : at(grid, i, j)
        if (a === b) {
          run++
        } else {
          if (run >= 5) score += run - 2
          run = 1
        }
      }
      if (run >= 5) score += run - 2
    }
  }

  // Rule 2: two-by-two blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = at(grid, x, y)
      if (v === at(grid, x + 1, y) && v === at(grid, x, y + 1) && v === at(grid, x + 1, y + 1)) {
        score += 3
      }
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 sequence appearing in the data.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
  const matches = (get: (i: number) => number, start: number, pat: number[]): boolean =>
    pat.every((p, i) => get(start + i) === p)
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      const row = (k: number): number => at(grid, k, i)
      const col = (k: number): number => at(grid, i, k)
      if (matches(row, j, A) || matches(row, j, B)) score += 40
      if (matches(col, j, A) || matches(col, j, B)) score += 40
    }
  }

  // Rule 4: deviation from an even balance of dark and light.
  let dark = 0
  for (let i = 0; i < size * size; i++) if (grid.modules[i] === 1) dark++
  const percent = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(percent - 50) / 5) * 10

  return score
}

function applyFormat(grid: Grid, mask: number): void {
  const size = grid.size
  const info = FORMAT_INFO[mask]
  for (let i = 0; i < 15; i++) {
    const bit = (info >> i) & 1
    // The copy beside the top-left finder.
    if (i < 6) set(grid, 8, i, bit)
    else if (i === 6) set(grid, 8, 7, bit)
    else if (i === 7) set(grid, 8, 8, bit)
    else if (i === 8) set(grid, 7, 8, bit)
    else set(grid, 14 - i, 8, bit)

    // The duplicate, split across the other two finders.
    if (i < 8) set(grid, size - 1 - i, 8, bit)
    else set(grid, 8, size - 15 + i, bit)
  }
}

/** Encodes `text` and returns the module matrix — true is a dark module. */
export function encode(text: string): boolean[][] {
  const payload = new TextEncoder().encode(text)
  const version = chooseVersion(payload.length)
  const codewords = interleave(encodeData(text, version), version)

  let best: { grid: Grid; score: number } | null = null
  for (let mask = 0; mask < 8; mask++) {
    const { grid, reserved } = functionPatterns(version)
    placeData(grid, reserved, codewords)
    for (let y = 0; y < grid.size; y++) {
      for (let x = 0; x < grid.size; x++) {
        if (reserved[y * grid.size + x]) continue
        if (MASKS[mask](x, y)) set(grid, x, y, at(grid, x, y) ^ 1)
      }
    }
    applyFormat(grid, mask)
    const score = penalty(grid)
    if (!best || score < best.score) best = { grid, score }
  }

  const grid = (best as { grid: Grid }).grid
  const out: boolean[][] = []
  for (let y = 0; y < grid.size; y++) {
    const row: boolean[] = []
    for (let x = 0; x < grid.size; x++) row.push(at(grid, x, y) === 1)
    out.push(row)
  }
  return out
}

/**
 * Renders as an SVG data URI.
 *
 * One path of rectangles rather than one element per module: a version-10
 * symbol is over three thousand modules, and as elements that is a
 * measurably slow thing to put in a React tree.
 */
export function toDataUri(text: string, quietZone = 4): string {
  const m = encode(text)
  const size = m.length + quietZone * 2
  let path = ''
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m.length; x++) {
      if (m[y][x]) path += `M${x + quietZone} ${y + quietZone}h1v1h-1z`
    }
  }
  // The quiet zone is part of the symbol: without a light margin many scanners
  // will not see it at all.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}
