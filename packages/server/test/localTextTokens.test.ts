import { execFile } from "node:child_process"
import { slowIt } from "./support/slow.ts"
import { createHash } from "node:crypto"
import { gunzipSync } from "node:zlib"
// Counts independently generated with Hugging Face tokenizers 0.22.1 from each model's
// revision-pinned tokenizer.json (sources.json). No model weights or network needed.
import { assert, describe, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { countTokens, type LocalEncoding } from "../src/importer/tokenizer.ts"
import { localTextEncoding } from "../src/providers/localTextModels.ts"
import { payloadText } from "../src/providers/textPayload.ts"
import { calibrateText } from "../src/providers/textCalibration.ts"
import { TokenizerInfo } from "@dreamspan/shared/generation.ts"

const references = JSON.parse(
  readFileSync(new URL("./support/textTokenReferences.json", import.meta.url), "utf8")
) as Record<string, Array<{ text: string; ids: Array<number> }>>

describe("published local text tokenizers", () => {
  it("vendored files match their published revision's SHA-256", () => {
    const base = new URL("../src/importer/tokenizers/", import.meta.url)
    const sources = JSON.parse(readFileSync(new URL("sources.json", base), "utf8")) as Record<
      string,
      { sha256: string }
    >
    for (const [name, source] of Object.entries(sources)) {
      const bytes = gunzipSync(readFileSync(new URL(`${name}.json.gz`, base)))
      assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256, name)
    }
  })
  for (const [encoding, cases] of Object.entries(references))
    it(`${encoding} matches the model repository's reference implementation`, async () => {
      assert.deepStrictEqual(
        await countTokens(
          encoding as LocalEncoding,
          cases.map((c) => c.text)
        ),
        cases.map((c) => c.ids.length)
      )
    })

  it("counts a long unbroken word without the old pure-JS tokenizer's quadratic stall", async () => {
    assert.deepStrictEqual(await countTokens("o200k_base", ["x".repeat(20_000)]), [2500])
  })

  it("counts a quarter-million-space run in pieces, without a quadratic stall", async () => {
    const huge = `x${" ".repeat(262_145)}x`
    for (const encoding of ["o200k_base", "llama3", "qwen3"] as const) {
      const started = performance.now()
      const [count] = await countTokens(encoding, [huge, `x${" ".repeat(4_000)}x`])
      assert.isBelow(performance.now() - started, 10_000)
      // Boundary merges make this approximate; the request's text is never rewritten.
      assert.approximately(count!, 2_052, 65)
    }
    // Shorter runs count whole: the same run counts the same in a short text and a long one.
    const [short, long] = await countTokens("o200k_base", [
      `a${" ".repeat(4_095)}b`,
      `a${" ".repeat(4_095)}b ${"word ".repeat(1_000)}`
    ])
    const [words] = await countTokens("o200k_base", [` ${"word ".repeat(1_000)}`])
    assert.strictEqual(long, short! + words!)
  })

  it("Llama 3 matches Meta's llama/test_tokenizer.py encode and dialog examples, without BOS/EOS", async () => {
    // https://github.com/meta-llama/llama3/blob/main/llama/test_tokenizer.py
    assert.deepStrictEqual(
      await countTokens("llama3", ["This is a test sentence.", "This is a response.", ""]),
      [6, 5, 0]
    )
  })

  it("maps router ids, local paths and GGUF names, keeping different vocabularies separate", () => {
    const models: Record<string, LocalEncoding | null> = {
      "meta-llama/llama-3.1-70b-instruct": "llama3",
      "/models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf": "llama3",
      "deepseek-ai/DeepSeek-R1-Distill-Llama-70B": null,
      "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B": null,
      "qwen/qwen2.5-72b-instruct": "qwen2",
      "Qwen/Qwen3-8B": "qwen3",
      "mistralai/Mistral-7B-Instruct-v0.3": "mistral-v3",
      "google/gemma-2-27b-it": "gemma2",
      "deepseek/deepseek-r1-0528": "deepseek-v3",
      "deepseek-v4-pro": "deepseek-v4",
      "deepseek-flash": "deepseek-api",
      "deepseek-chat": null,
      "mistralai/mistral-nemo": null,
      "mistralai/mistral-7b-instruct-v0.1": null,
      "google/gemma-3-27b-it": null,
      "qwen/qwen2.5-vl-72b-instruct": null,
      "qwen/qwen2.6-7b": null,
      "deepseek/deepseek-v3.2": null,
      "meta-llama/llama-3.4-8b": null,
      "gemini-2.5-pro": null,
      "claude-sonnet-4-5": null
    }
    for (const [model, expected] of Object.entries(models)) assert.equal(localTextEncoding(model), expected, model)
  })
})

it("extracts final payload text and framing without treating tools or images as text", () => {
  assert.deepStrictEqual(payloadText({ messages: [{ role: "user", content: "Hello" }] }), {
    texts: ["Hello"],
    framing: 3
  })
  assert.deepStrictEqual(
    payloadText({ system: "Instruction", messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] }),
    { texts: ["Hello", "Instruction"], framing: 3 }
  )
  assert.isNull(payloadText({ tools: [], messages: [{ content: "Hello" }] }))
  assert.isNull(payloadText({ input: [{ type: "function_call", arguments: "{}" }] }))
})

it("applies a calibration once to raw counts, preserves empty fields and marks it approximate", () => {
  const raw = {
    counts: [0, 2, 10],
    tokenizer: new TokenizerInfo({ id: "approximate", label: "o200k_base", exact: false })
  }
  const result = calibrateText(raw, { ratio: 1.25, samples: 3 })
  assert.deepStrictEqual(result.counts, [0, 3, 13])
  assert.deepStrictEqual(raw.counts, [0, 2, 10])
  assert.isFalse(result.tokenizer.exact)
  assert.include(result.tokenizer.note ?? "", "Calibrated from 3")
})

slowIt("bounds degenerate non-space and combining-mark runs in an isolated tokenizer process", async () => {
  const script = `
    const { countTokens } = await import('./packages/server/src/importer/tokenizer.ts');
    for (const encoding of ['o200k_base', 'llama3', 'qwen3']) {
      const counts = await countTokens(encoding, ['x'.repeat(262145), '\u0301'.repeat(262145), 'abcdef'.repeat(50000), ('x'.repeat(4095)+' ').repeat(64), '😀'.repeat(131073)]);
      if (!counts.every(n => Number.isFinite(n) && n > 0)) process.exit(1);
    }
  `
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--no-wasm-code-gc", "--input-type=module", "-e", script],
      { cwd: new URL("../../../", import.meta.url), timeout: 20_000 },
      (error) => (error ? reject(error) : resolve())
    )
  })
})
