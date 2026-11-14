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
  lcmDefaults
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
