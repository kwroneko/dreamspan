import { describe, expect, it } from "vitest"
import { toVersion, type VersionRow } from "../src/db/rows.ts"

const row = (issues: ReadonlyArray<{ kind: string; message: string }>): VersionRow => ({
  id: "v",
  slot_id: "s",
  ordinal: 0,
  status: "complete",
  speaker_entity_id: null,
  writer: "model",
  content: "Reply.",
  macro_mode: "verbatim",
  origin: "generated",
  source_version_id: null,
  direction: null,
  hidden: 0,
  starred: 0,
  created_at: 1,
  error_json: null,
  frozen_macros: null,
  rollout_id: "r",
  context_issues: JSON.stringify(issues),
  has_context: 1
})

describe("a version's context issues", () => {
  it("never show the added closing user turn, which only the inspector shows (owner 2026-10-28)", () => {
    const prefill = { kind: "prefill_dropped", message: "The preset's prefill wasn't sent." }
    const version = toVersion(
      row([{ kind: "last_turn_filled", message: "A user turn asking for the next message was added." }, prefill])
    )
    expect(version.context?.issues).toEqual([prefill])
  })

  it("leave out routine truncation, history and examples cut by the budget, which only the inspector lists", () => {
    const version = toVersion(
      row([
        { kind: "history_truncated", message: "The context holds the last 40 messages: older ones don't fit." },
        { kind: "examples_truncated", message: "11 example dialogues didn't fit the preset's context size." }
      ])
    )
    expect(version.context).toEqual({ issues: [] })
  })
})
