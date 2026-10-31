// Regex scripts on text as it's written (ARCHITECTURE §12 "Rewrites"), compared with ST's own
// engine: the `rewrite` fixture preset's scripts, allowed, on synthetic replies, messages,
// edits and reasoning. ST stores what getRegexedString returns; ours is what RewriteText returns.
import { readFileSync } from "node:fs"
import { Effect } from "effect"
import type { Browser } from "@playwright/test"
import { importStPreset } from "../../src/formats/preset.ts"
import { rewriteFixture } from "../support/assemblySources.ts"
import { cardDoc } from "../support/docs.ts"
import type { FixtureSet } from "./fixtures.ts"
import type { Section } from "./report.ts"
import { evaluateRegex } from "./st.ts"

const PLACEMENTS = { user: 1, reply: 2, reasoning: 6 } as const

const CASES: ReadonlyArray<{ readonly text: string; readonly as: keyof typeof PLACEMENTS; readonly edit: boolean }> = [
  { text: "<think>The ledger is short.</think>\nHello there... Tobin.", as: "reply", edit: false },
  { text: "<think>one</think> <think>two</think>Hello, twice.", as: "reply", edit: false },
  { text: "<think>An edit keeps this.</think>Hello again...", as: "reply", edit: true },
  { text: "Plain words, nothing to change.", as: "reply", edit: false },
  { text: "Wait... the causeway... <think>not a script's</think>", as: "user", edit: false },
  { text: "Edited... twice...", as: "user", edit: true },
  { text: "Thinking about the tide. Thinking again.", as: "reasoning", edit: false },
  { text: "Thinking on an edit.", as: "reasoning", edit: true }
]

export const compareRewrites = async (browser: Browser, url: string, fixtures: FixtureSet): Promise<Section> => {
  const character = fixtures.chats[0]!.card
  const st = await evaluateRegex(browser, url, {
    character,
    preset: "rewrite",
    cases: CASES.map((c) => ({ text: c.text, placement: PLACEMENTS[c.as], edit: c.edit }))
  })
  const doc = importStPreset(
    readFileSync(new URL("../fixtures/presets/rewrite.json", import.meta.url), "utf8")
  ).document!
  const fixture = {
    preset: { ...doc, regex_approved: true },
    cards: [
      { entity: "mira", doc: cardDoc(character) },
      { entity: "tobin", doc: cardDoc(fixtures.persona.name) }
    ],
    participants: ["mira", "tobin"],
    persona: "tobin",
    messages: [{ side: "user" as const, content: "The causeway was already under water." }]
  }
  const differences: Array<string> = []
  for (const [i, c] of CASES.entries()) {
    const [ours] = await Effect.runPromise(
      rewriteFixture(
        fixture,
        c.as === "user"
          ? { edit: c.edit, speaker: "tobin", writer: "human" }
          : { edit: c.edit, speaker: "mira", writer: "model" },
        [{ text: c.text, kind: c.as === "reasoning" ? "reasoning" : "message" }]
      )
    )
    if (ours!.text !== st[i]) {
      differences.push(
        `${c.as}${c.edit ? " (edit)" : ""} ${JSON.stringify(c.text)}: ST ${JSON.stringify(st[i])}, ours ${JSON.stringify(ours!.text)}`
      )
    }
  }
  return {
    title: "Regex scripts on text as it's written",
    notes: [
      `${CASES.length} texts through the "rewrite" preset's scripts, allowed: replies, messages, edits, reasoning`
    ],
    differences
  }
}
