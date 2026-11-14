// The summary model (DESIGN §8, audit item 067): a summary request is written with the chat's own
// summary model, else the account's, else the chat's model; a reply always uses the chat's model.
// Synthetic cards and connection ids only.
import { assert, it } from "@effect/vitest"
import type { LcmDefaults } from "@rp/shared/lcmSettings.ts"
import { summaryModelBinding } from "@rp/shared/lcmSettings.ts"
import { Effect } from "effect"
import { importStPreset } from "../src/formats/preset.ts"
import { assembleFixture, type AssemblyFixture } from "./support/assemblySources.ts"
import { cardDoc } from "./support/docs.ts"

const chatModel = { connection: "conn-chat", model: "model-chat" }
const ownSummary = { connection: "conn-own", model: "model-own" }
const accountSummary = { connection: "conn-account", model: "model-account" }

const binding = (scope: "summarizer" | null, value: { connection: string; model: string }) => ({
  depth: null,
  event: { scope, data: { key: "model.binding" as const, value: value as never } }
})

const fixture = (
  extra: ReadonlyArray<ReturnType<typeof binding>>,
  lcmDefaults: LcmDefaults | null,
  asked: Array<{ readonly connection: string; readonly model: string } | null>
): AssemblyFixture => ({
  messages: [
    { side: "user", content: "FIRST" },
    { side: "assistant", content: "SECOND" }
  ],
  cards: [{ entity: "mira", doc: cardDoc("Mira") }],
  participants: ["mira"],
  preset: importStPreset(JSON.stringify({ frequency_penalty: 0 })).document!,
  events: [
    { depth: null, event: { scope: null, data: { key: "lcm.settings" as const, value: { enabled: true } as never } } },
    binding(null, chatModel),
    ...extra
  ],
  modelAsked: asked,
  lcmDefaults,
  model: {
    connectionId: "conn",
    modelId: "model",
    kind: "openai-chat",
    api: "openai-completions",
    key: "synthetic",
    prefill: "none",
    cacheBreakpoints: "none",
    context: 128000,
    presetOverride: null
  }
})

const asked = (extra: ReadonlyArray<ReturnType<typeof binding>>, defaults: LcmDefaults | null, summarizing: boolean) =>
  Effect.gen(function* () {
    const seen: Array<{ readonly connection: string; readonly model: string } | null> = []
    yield* assembleFixture(fixture(extra, defaults, seen), summarizing ? { summarizing: true } : {})
    return seen
  })

it.effect("a summary uses the chat's summary model, then the account's, then the chat's model", () =>
  Effect.gen(function* () {
    const own = [binding("summarizer", ownSummary)]
    const account = { summarizer: accountSummary } as LcmDefaults
    assert.deepStrictEqual(yield* asked(own, account, true), [ownSummary])
    assert.deepStrictEqual(yield* asked([], account, true), [accountSummary])
    assert.deepStrictEqual(yield* asked([], null, true), [chatModel])
    // A reply is written with the chat's model whatever the summary model is.
    assert.deepStrictEqual(yield* asked(own, account, false), [chatModel])
  })
)

it("the summary model's order of choice", () => {
  const account = { summarizer: accountSummary } as LcmDefaults
  assert.deepStrictEqual(summaryModelBinding({ "": chatModel, summarizer: ownSummary }, account), ownSummary)
  assert.deepStrictEqual(summaryModelBinding({ "": chatModel }, account), accountSummary)
  assert.deepStrictEqual(summaryModelBinding({ "": chatModel }, {} as LcmDefaults), chatModel)
  assert.strictEqual(summaryModelBinding({}, null), null)
})

it.effect("unavailable summary choices fall through only on a missing model, and report it", () =>
  Effect.gen(function* () {
    const { resolveSummaryModel } = yield* Effect.promise(() => import("../src/assembler/summaryModel.ts"))
    const { AssemblyFailed } = yield* Effect.promise(() => import("../src/assembler/types.ts"))
    const calls: unknown[] = []
    const model = fixture([], null, []).model!
    const sources = {
      lcmDefaults: () => Effect.succeed({ summarizer: accountSummary }),
      model: (binding: unknown) => {
        calls.push(binding)
        return binding === ownSummary
          ? Effect.fail(new AssemblyFailed({ reason: "no_model", message: "Gone" }))
          : Effect.succeed(model)
      }
    } as unknown as import("../src/assembler/pipeline.ts").AssemblySources["Service"]
    const resolved = yield* resolveSummaryModel(sources, { summarizer: ownSummary, "": chatModel })
    assert.deepStrictEqual(calls, [ownSummary, accountSummary])
    assert.isTrue(resolved.unavailable)
    assert.strictEqual(resolved.model, model)
    const failed = yield* resolveSummaryModel(
      { ...sources, model: () => Effect.fail(new AssemblyFailed({ reason: "budget", message: "Synthetic failure" })) },
      { summarizer: ownSummary }
    ).pipe(Effect.flip)
    assert.strictEqual(failed._tag, "AssemblyFailed")
  })
)

it.effect("summary choices leave the complete reply request bytes unchanged", () =>
  Effect.gen(function* () {
    const plain = yield* assembleFixture(fixture([], null, []))
    const chosen = yield* assembleFixture(
      fixture([binding("summarizer", ownSummary)], { summarizer: accountSummary } as LcmDefaults, [])
    )
    assert.strictEqual(JSON.stringify(chosen.request), JSON.stringify(plain.request))
  })
)
