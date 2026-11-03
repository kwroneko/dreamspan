// Synthetic, serial prompt cache. No SDK, HTTP, credentials or provider calls.
export interface CacheRules {
  readonly name: string
  readonly mode: "lookback" | "exact" | "automatic" | "none"
  readonly lookback: number
  readonly maxMarkers: number
  readonly minTokens: number
  readonly ttlS: number
  readonly readPrice: number
  readonly writePrice: number
  readonly automaticFinal?: boolean
  readonly granularity?: number
}
export interface CacheBlock {
  readonly digest: string
  readonly tokens: number
}
export interface CacheResult {
  readonly input: number
  readonly read: number
  readonly write: number
  readonly cost: number
}
export class CacheSimulator {
  readonly rules: CacheRules
  private readonly entries = new Map<string, number>()
  constructor(rules: CacheRules) {
    this.rules = rules
  }
  request(
    blocks: ReadonlyArray<CacheBlock>,
    priority: ReadonlyArray<number>,
    nowS: number,
    automaticFinal = this.rules.automaticFinal
  ): CacheResult {
    const r = this.rules
    const cumulative: number[] = []
    let input = 0
    for (const block of blocks) {
      input += block.tokens
      cumulative.push(input)
    }
    if (r.mode === "none") return { input, read: 0, write: 0, cost: input }
    const eligible = (i: number) => i >= 0 && i < blocks.length && cumulative[i]! >= r.minTokens
    const markers = [...new Set(priority.filter(eligible))].slice(0, r.maxMarkers - (automaticFinal ? 1 : 0))
    if (automaticFinal && eligible(blocks.length - 1)) markers.push(blocks.length - 1)
    const endpoints = r.mode === "automatic" ? blocks.map((_, i) => i).filter(eligible) : markers
    let read = 0
    const refresh = new Set<string>()
    for (const end of endpoints) {
      const floor = r.mode === "lookback" ? Math.max(0, end - r.lookback + 1) : end
      for (let i = end; i >= floor; i--) {
        const key = blocks[i]!.digest
        if (eligible(i) && (this.entries.get(key) ?? -Infinity) > nowS) {
          read = Math.max(read, cumulative[i]!)
          refresh.add(key)
          break
        }
      }
    }
    if (r.granularity) read = Math.floor(read / r.granularity) * r.granularity
    const writtenEnd = Math.max(0, ...endpoints.map((i) => cumulative[i]!))
    const write = Math.max(0, writtenEnd - read)
    for (const end of endpoints) this.entries.set(blocks[end]!.digest, nowS + r.ttlS)
    for (const key of refresh) this.entries.set(key, nowS + r.ttlS)
    return { input, read, write, cost: read * r.readPrice + write * r.writePrice + (input - read - write) }
  }
}

// Scenario contracts, not model discovery. Unknown rules remain explicit assumptions in the report.
export const cacheClasses: ReadonlyArray<CacheRules> = [
  {
    name: "Anthropic direct",
    mode: "lookback",
    lookback: 20,
    maxMarkers: 4,
    minTokens: 1024,
    ttlS: 300,
    readPrice: 0.1,
    writePrice: 1.25,
    automaticFinal: true
  },
  {
    name: "Anthropic AWS (assumed exact)",
    mode: "exact",
    lookback: 0,
    maxMarkers: 4,
    minTokens: 1024,
    ttlS: 300,
    readPrice: 0.1,
    writePrice: 1.25,
    automaticFinal: true
  },
  {
    name: "Responses AWS",
    mode: "exact",
    lookback: 0,
    maxMarkers: 4,
    minTokens: 1024,
    ttlS: 1800,
    readPrice: 0.1,
    writePrice: 1.25,
    automaticFinal: true
  },
  {
    name: "Chat explicit-only (assumed limits)",
    mode: "exact",
    lookback: 0,
    maxMarkers: 4,
    minTokens: 1024,
    ttlS: 300,
    readPrice: 0.1,
    writePrice: 1.25,
    automaticFinal: true
  },
  {
    name: "OpenAI direct automatic",
    mode: "automatic",
    lookback: 0,
    maxMarkers: 0,
    minTokens: 1024,
    ttlS: 300,
    readPrice: 0.1,
    writePrice: 1,
    granularity: 128
  },
  { name: "No caching", mode: "none", lookback: 0, maxMarkers: 0, minTokens: 0, ttlS: 0, readPrice: 1, writePrice: 1 }
]
