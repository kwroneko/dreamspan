import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { takeSummaryPrefix } from "../src/lcm/prefix.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { assembleFixture, type AssemblyFixture } from "./support/assemblySources.ts"
import { cardDoc } from "./support/docs.ts"

it.effect("a private summary never borrows a different viewer's message-derived prefix", () =>
  Effect.gen(function* () {
    const fixture: AssemblyFixture = {
      cards: [
        { entity: "wren", doc: cardDoc("Wren") },
        { entity: "mira", doc: cardDoc("Mira") }
      ],
      participants: ["wren", "mira"],
      target: { speaker: "mira" },
      events: [{ depth: null, event: { scope: null, data: { key: "context.per_speaker", value: "separate" } } }],
      messages: [
        { side: "user", content: "COMMON", knowers: ["wren", "mira"] },
        { side: "assistant", speaker: "mira", content: "SECRET-FROM-WREN", knowers: ["mira"] }
      ],
      preset: importStPreset(
        JSON.stringify({
          frequency_penalty: 0,
          prompts: [{ identifier: "main", role: "system", content: "Last seen: {{lastMessage}}", system_prompt: true }]
        })
      ).document!
    }
    const trigger = yield* assembleFixture(fixture)
    const prefix = takeSummaryPrefix(trigger)
    assert.include(JSON.stringify(prefix.request.messages), "SECRET-FROM-WREN")
    const built = yield* assembleFixture(
      { ...fixture, target: { speaker: "wren" } },
      {
        summarizing: true,
        summaryJob: {
          id: "own",
          clipTokens: 6000,
          inputs: [],
          tail: "Summarize.",
          style: "direct",
          audience: ["wren"],
          prefix
        }
      }
    )
    assert.notInclude(JSON.stringify(built.request.messages), "SECRET-FROM-WREN")
    const oldView = yield* assembleFixture({
      ...fixture,
      target: { speaker: "wren" },
      messages: fixture.messages.map((m) => ({ ...m, knowers: ["wren", "mira"] }))
    })
    const corrected = yield* assembleFixture(
      { ...fixture, target: { speaker: "wren" } },
      {
        summarizing: true,
        summaryJob: {
          id: "corrected",
          clipTokens: 6000,
          inputs: [],
          tail: "Summarize.",
          style: "direct",
          audience: ["wren"],
          prefix: takeSummaryPrefix(oldView)
        }
      }
    )
    assert.notInclude(JSON.stringify(corrected.request.messages), "SECRET-FROM-WREN")
  })
)

it.effect("a private summary cannot restore a note omitted from its current request", () =>
  Effect.gen(function* () {
    const fixture: AssemblyFixture = {
      cards: [{ entity: "wren", doc: cardDoc("Wren") }],
      participants: ["wren"],
      target: { speaker: "wren" },
      events: [
        { depth: null, event: { scope: null, data: { key: "context.per_speaker", value: "separate" } } },
        { depth: null, event: { scope: null, data: { key: "note.activate", value: { note: "private" as never } } } }
      ],
      messages: [{ side: "user", content: "COMMON", knowers: ["wren"] }],
      notes: [
        {
          entity: "private",
          revision: "private-revision",
          doc: {
            schema_version: 1,
            title: "Private",
            content: "PRIVATE-NOTE",
            placement: { mode: "section", section: "context_start", role: "system" },
            owner: { chat: "chat-1" as never },
            exportable: true
          }
        }
      ],
      preset: importStPreset(JSON.stringify({ frequency_penalty: 0 })).document!
    }
    const prefix = takeSummaryPrefix(yield* assembleFixture(fixture))
    assert.include(JSON.stringify(prefix.request.messages), "PRIVATE-NOTE")
    const summary = yield* assembleFixture(fixture, {
      summarizing: true,
      summaryJob: {
        id: "own",
        clipTokens: 6000,
        inputs: [],
        tail: "Summarize.",
        style: "direct",
        audience: ["wren"],
        prefix
      }
    })
    assert.notInclude(JSON.stringify(summary.request.messages), "PRIVATE-NOTE")
  })
)
