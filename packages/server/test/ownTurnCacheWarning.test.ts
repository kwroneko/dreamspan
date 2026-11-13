import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { newCardDoc, newCardNote } from "@rp/shared/editing.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { speakerPrefixChange } from "../src/assembler/warmth.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { assembleFixture, type AssemblyFixture } from "./support/assemblySources.ts"

const fixture = (speaker: string, prefix: boolean): AssemblyFixture => {
  const preset = importStPreset(
    JSON.stringify({ main_prompt: "Shared instructions.", group_nudge_prompt: "" })
  ).document!
  const marker = preset.order.find((e) => e.identifier === "ownTurnNotes")!
  return {
    cards: ["Mira", "Tobin"].map((name) => ({ entity: name, doc: newCardDoc(name) })),
    participants: ["Mira", "Tobin"],
    target: { speaker },
    messages: [{ side: "user", content: "A shared past. ".repeat(800) }],
    preset: prefix ? { ...preset, order: [marker, ...preset.order.filter((e) => e !== marker)] } : preset,
    notes: ["Mira", "Tobin"].map((name) => ({
      entity: `note-${name}`,
      revision: "r",
      doc: {
        ...newCardNote(name as never, "Inner life"),
        content: `${name} keeps a secret.`,
        condition: { when: "own_turn" },
        placement: { mode: "section", section: "own_turn" },
        on_by_default: true
      }
    }))
  }
}
const assemble = (speaker: string, prefix: boolean) => Effect.runPromise(assembleFixture(fixture(speaker, prefix)))
const count = (text: string) => Math.ceil(text.length / 4)

describe("speaker-dependent own-turn prefix warning", () => {
  it("counts the real suffix that differs, using the selected counter", async () => {
    const last = await assemble("Tobin", true),
      next = await assemble("Mira", true)
    const changed = speakerPrefixChange(last, next, count)!
    expect(changed).not.toBeNull()
    expect(changed.tokens).toBeGreaterThan(3000)
    const at = next.request.messages.findIndex((m, i) => m.content !== last.request.messages[i]?.content)
    expect(changed.tokens).toBe(
      next.request.messages.slice(at).reduce((sum, m) => sum + count(m.content) + 3 + (m.name ? count(m.name) : 0), 0)
    )
  })
  it("says nothing when the speakers send the same prefix and only history grows", async () => {
    const samePrefix = (speaker: string, more: boolean): AssemblyFixture => {
      const f = fixture(speaker, true)
      return {
        ...f,
        messages: [...f.messages!, ...(more ? [{ side: "assistant" as const, content: "Another turn." }] : [])],
        notes: f.notes!.map((n) => ({
          ...n,
          doc: { ...n.doc, content: "The same background.", placement: { mode: "section", section: "context_start" } }
        }))
      }
    }
    const last = await Effect.runPromise(assembleFixture(samePrefix("Tobin", false)))
    const next = await Effect.runPromise(assembleFixture(samePrefix("Mira", true)))
    expect(speakerPrefixChange(last, next, count)).toBeNull()
  })
  it("says nothing for the default tail, the same speaker, or a different model", async () => {
    expect(speakerPrefixChange(await assemble("Tobin", false), await assemble("Mira", false), count)).toBeNull()
    const next = await assemble("Mira", true)
    expect(speakerPrefixChange(next, next, count)).toBeNull()
    const other: ContextSnapshot = {
      ...next,
      inputs: { ...next.inputs, speaker: "Tobin", model: { ...next.inputs.model!, modelId: "different" } }
    }
    expect(speakerPrefixChange(other, next, count)).toBeNull()
  })
})
