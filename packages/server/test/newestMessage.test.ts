import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { importStPreset } from "../src/formats/preset.ts"
import { assembleFixture } from "./support/assemblySources.ts"
import { cardDoc } from "./support/docs.ts"
import { compose, injectInChat, type StPrompt } from "../src/assembler/st.ts"

const p = (identifier: string, content = ""): StPrompt => ({
  identifier,
  content,
  role: "system",
  piece: null,
  system_prompt: false,
  injection_position: "relative",
  injection_depth: 0,
  injection_order: 100,
  forbid_overrides: true
})
/** A chat's note switched on at the chat's start. */
const activate = (note: string) =>
  ({ depth: null, event: { scope: null, data: { key: "note.activate", value: { note } } } }) as never

const run = (ids: string[], withControl = false) =>
  compose({
    collection: ids.map((id) => p(id, id === "tail" ? "TAIL" : "")),
    disabled: () => false,
    chat: injectInChat(
      [
        { role: "assistant", content: "EARLIER", pieces: [0], kind: "history" },
        { role: "user", content: "LATEST", pieces: [1], kind: "history" }
      ],
      [],
      [{ depth: 0, role: "system", text: { text: "D0", piece: 2 } }]
    ),
    examples: [],
    newChat: null,
    newExampleChat: null,
    sendIfEmpty: null,
    control: withControl ? [{ role: "system", content: "CONTROL", pieces: [], kind: "volatile" }] : [],
    beside: [],
    budget: 1000
  })
describe("Newest message", () => {
  it("normalizes an older stored revision without changing its assembled request", async () => {
    const preset = importStPreset(JSON.stringify({ frequency_penalty: 0 })).document!
    const legacy = {
      ...preset,
      prompts: preset.prompts.filter((p) => p.identifier !== "newestMessage"),
      order: preset.order.filter((p) => p.identifier !== "newestMessage")
    }
    const fixture = { participants: [], cards: [], messages: [{ side: "user" as const, content: "LATEST" }], preset }
    const current = await Effect.runPromise(assembleFixture(fixture))
    const older = await Effect.runPromise(assembleFixture({ ...fixture, preset: legacy }))
    expect(older.request).toEqual(current.request)
  })
  it("preserves ST order and depth-zero injections when adjacent to history", () => {
    expect(run(["chatHistory", "newestMessage", "tail"]).messages.map((m) => m.content)).toEqual([
      "EARLIER",
      "LATEST",
      "D0",
      "TAIL"
    ])
    expect(run(["chatHistory", "tail"]).messages).toEqual(run(["chatHistory", "newestMessage", "tail"]).messages)
  })
  it("puts control directives before newest only when the marker was moved after the tail", () => {
    expect(run(["chatHistory", "newestMessage", "tail"], true).messages.map((m) => m.content)).toEqual([
      "EARLIER",
      "LATEST",
      "D0",
      "TAIL",
      "CONTROL"
    ])
    expect(run(["chatHistory", "tail", "newestMessage"], true).messages.map((m) => m.content)).toEqual([
      "EARLIER",
      "TAIL",
      "CONTROL",
      "LATEST",
      "D0"
    ])
  })
  it("can place the newest message and its depth-zero injections after the tail", () => {
    const built = run(["chatHistory", "tail", "newestMessage"])
    expect(built.messages.map((m) => m.content)).toEqual(["EARLIER", "TAIL", "LATEST", "D0"])
    expect(built.historySent).toBe(2)
  })
  it("still sends the markers an imported ST order leaves out, after the other prompts, as ST does", async () => {
    const preset = importStPreset(
      JSON.stringify({
        frequency_penalty: 0,
        prompts: [{ identifier: "main", role: "system", content: "MAIN", system_prompt: true }],
        prompt_order: [
          {
            character_id: 100001,
            order: [
              { identifier: "main", enabled: true },
              { identifier: "chatHistory", enabled: true }
            ]
          }
        ]
      })
    ).document!
    const result = await Effect.runPromise(
      assembleFixture({
        preset,
        participants: ["mira"],
        cards: [{ entity: "mira", doc: cardDoc("Mira", { description: "DESCRIPTION", scenario: "SCENARIO" }) }],
        messages: [{ content: "LATEST", side: "user" }]
      })
    )
    // The imported group nudge stays right after the history, as ST sends it, before the appended
    // markers, each character's part in the preset's join wrapper (DESIGN §5.0), here the default.
    expect(result.request.messages.map((m) => m.content).slice(-4)).toEqual([
      "LATEST",
      "[Write the next reply only as Mira.]",
      "<Mira>\nDESCRIPTION\n</Mira>",
      "<Mira>\nSCENARIO\n</Mira>"
    ])
  })
  for (const position of ["context_start", "tail_start", "tail_end"] as const) {
    it(`keeps several notes at ${position} in their order`, async () => {
      const note = (entity: string) => ({
        entity,
        revision: `revision-${entity}`,
        first: true,
        doc: {
          schema_version: 1 as const,
          title: entity,
          content: `NOTE-${entity}`,
          owner: { chat: "chat" as never },
          placement: { mode: "section" as const, section: position },
          exportable: true
        }
      })
      const result = await Effect.runPromise(
        assembleFixture({
          preset: importStPreset(JSON.stringify({ frequency_penalty: 0 })).document!,
          participants: [],
          cards: [],
          messages: [{ content: "LATEST", side: "user" }],
          notes: [note("a"), note("b"), note("c")],
          events: ["a", "b", "c"].map(activate)
        })
      )
      const sent = result.request.messages.map((m) => m.content)
      const at = ["a", "b", "c"].map((id) => sent.findIndex((content) => content.includes(`NOTE-${id}`)))
      expect(at.every((i) => i >= 0)).toBe(true)
      expect(at).toEqual([...at].sort((x, y) => x - y))
    })
  }
  for (const position of ["context_start", "tail_start", "tail_end"] as const) {
    it(`assembles notes at ${position}`, async () => {
      const preset = importStPreset(
        JSON.stringify({
          frequency_penalty: 0,
          prompts: [{ identifier: "tail", role: "system", content: "TAIL", system_prompt: false }],
          prompt_order: [
            {
              character_id: 100001,
              order: [
                { identifier: "chatHistory", enabled: true },
                { identifier: "tail", enabled: true }
              ]
            }
          ]
        })
      ).document!
      const result = await Effect.runPromise(
        assembleFixture({
          preset,
          participants: [],
          cards: [],
          messages: [
            { content: "EARLIER", side: "assistant" },
            { content: "LATEST", side: "user" }
          ],
          notes: [
            {
              entity: "note",
              revision: "revision",
              first: true,
              doc: {
                schema_version: 1,
                title: "Note",
                content: "NOTE",
                owner: { chat: "chat" as never },
                placement: { mode: "section", section: position },
                exportable: true
              }
            }
          ],
          events: [activate("note")]
        })
      )
      const messages = result.request.messages.map((m) => m.content)
      const note = messages.indexOf("NOTE"),
        tail = messages.indexOf("TAIL"),
        latest = messages.indexOf("LATEST")
      expect(note).toBeGreaterThanOrEqual(0)
      if (position === "context_start") expect(note).toBeLessThan(latest)
      else if (position === "tail_start") {
        expect(note).toBeGreaterThan(latest)
        expect(note).toBeLessThan(tail)
      } else expect(note).toBeGreaterThan(tail)
    })
  }
})
