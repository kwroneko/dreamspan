// The editors' token counts (tokenCounts.ts): the texts every field wants go in one request,
// each text is counted once per model, and the explanation says which tokenizer counted.
import { TokenizerInfo } from "@dreamspan/shared/generation.ts"
import { describe, expect, it, vi } from "vitest"
import type { Caller } from "../src/features/editor/caller.ts"
import { refreshTokenCounts, requestCounts, tokenizerText, tokensText } from "../src/features/editor/tokenCounts.ts"

// The hook's connections to the app, which a test without a page has none of.
vi.mock("../src/features/pickers/defaults.ts", () => ({ defaultsAtom: null }))
vi.mock("../src/features/editor/caller.ts", () => ({ useCaller: () => null }))
vi.mock("../src/rpc.ts", () => ({ AppClient: { query: () => null } }))

const exact = new TokenizerInfo({ id: "openai-encodings", label: "gpt-4o's own tokenizer (o200k_base)", exact: true })

const fakeCaller = () => {
  const sent: Array<ReadonlyArray<string>> = []
  const call = (async (run: (client: unknown) => unknown) => {
    let texts: ReadonlyArray<string> = []
    run((_tag: string, payload: { texts: ReadonlyArray<string> }) => {
      texts = payload.texts
      return null
    })
    sent.push(texts)
    return { ok: true, value: { counts: texts.map((t) => t.split(" ").length), tokenizer: exact } }
  }) as unknown as Caller
  return { call, sent }
}

describe("token counts", () => {
  it("gathers the texts fields want into one request, and counts a text once per model", async () => {
    vi.useFakeTimers()
    const { call, sent } = fakeCaller()
    requestCounts(call, "m1", ["one two", ""])
    requestCounts(call, "m1", ["three", "one two"])
    await vi.advanceTimersByTimeAsync(50)
    expect(sent).toEqual([["one two", "three"]])
    requestCounts(call, "m1", ["one two", "three"])
    await vi.advanceTimersByTimeAsync(50)
    expect(sent).toHaveLength(1)
    // Another model counts again.
    requestCounts(call, "m2", ["one two"])
    await vi.advanceTimersByTimeAsync(50)
    expect(sent).toEqual([["one two", "three"], ["one two"]])
    vi.useRealTimers()
  })

  it("refreshes cached fields after reported usage changes the model's calibration", async () => {
    vi.useFakeTimers()
    const { call, sent } = fakeCaller()
    requestCounts(call, "calibration-model", ["one two"])
    await vi.advanceTimersByTimeAsync(50)
    refreshTokenCounts()
    requestCounts(call, "calibration-model", ["one two"])
    await vi.advanceTimersByTimeAsync(50)
    expect(sent).toEqual([["one two"], ["one two"]])
    vi.useRealTimers()
  })

  it("says how it counted: exact without a tilde, an approximation with one and why", () => {
    expect(tokensText(1234, exact)).toBe("1,234 tokens")
    expect(tokensText(1234, exact, true)).toBe("~1,234 tokens")
    expect(tokensText(null, exact)).toBe("… tokens")
    expect(tokenizerText(exact)).toBe("Counted with gpt-4o's own tokenizer (o200k_base), the model chats use.")
    const approximate = new TokenizerInfo({
      id: "approximate",
      label: "o200k_base, as an approximation",
      exact: false,
      note: "There's no tokenizer for deepseek-chat here."
    })
    expect(tokensText(12, approximate)).toBe("~12 tokens")
    expect(tokenizerText(approximate)).toBe(
      "Approximate: counted with o200k_base, as an approximation. There's no tokenizer for deepseek-chat here."
    )
  })
})
