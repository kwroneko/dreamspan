// A made-up 30-prompt preset for layout checks: the default preset with twenty extra prompts
// (emoji names, three unnamed, some long, one at a depth), fourteen above Chat History and six
// after it. The same shape as presetTab.spec.ts's.
import { readFileSync } from "node:fs"

const base = JSON.parse(
  readFileSync(new URL("../../../server/test/fixtures/presets/default.json", import.meta.url), "utf8")
) as Record<string, unknown> & {
  prompts: Array<Record<string, unknown>>
  prompt_order: Array<{ character_id: number; order: Array<{ identifier: string; enabled: boolean }> }>
}

const paragraph = (topic: string, lines: number) =>
  Array.from(
    { length: lines },
    (_, i) => `${topic}: keep the scene grounded in what {{char}} can see and hear, line ${i + 1}.`
  ).join("\n")

const extra = [
  ["🎭 Narrator voice", paragraph("Voice", 6)],
  ["🔥 Pacing", paragraph("Pacing", 3)],
  ["", "Write in close third person, past tense, and never summarize a scene the user is still playing."],
  ["📜 Lore rules", paragraph("Lore", 12)],
  ["Formatting", "Dialogue in quotes, actions in plain prose, thoughts in *asterisks*."],
  ["🌧️ Weather & mood", paragraph("Weather", 4)],
  ["", "Keep replies under four paragraphs unless the user asks for more."],
  ["Banned phrases", "Avoid: shivers down the spine, a mix of, testament to, palpable."],
  ["🗺️ Locations", paragraph("Places", 8)],
  ["Side characters", paragraph("Cast", 5)],
  ["⚔️ Combat", paragraph("Combat", 6)],
  ["", ""],
  ["Inner monologue", "Show {{char}}'s thoughts sparingly, at most once per reply."],
  ["🧭 Agency", "Never decide what {{user}} does, says or feels."],
  ["Time skips", "Only skip time when the user asks."],
  ["Sensory detail", paragraph("Senses", 3)],
  ["💬 Dialogue tags", "Prefer 'said'; vary only when it adds information."],
  ["Continuity", paragraph("Continuity", 4)],
  ["Depth reminder", "Remember the current goal of the scene."],
  ["🎲 Randomness", "Introduce one small surprise every few replies."]
] as const

export const syntheticPreset = () => {
  const prompts = [
    ...base.prompts,
    ...extra.map(([name, content], i) => ({
      identifier: `synthetic-${i}`,
      name,
      role: "system",
      content,
      system_prompt: false,
      marker: false,
      injection_position: name === "Depth reminder" ? 1 : 0,
      injection_depth: 2
    }))
  ]
  const order = base.prompt_order.find((o) => o.character_id === 100001)!.order
  const at = order.findIndex((e) => e.identifier === "chatHistory")
  const mine = extra.map((_, i) => ({ identifier: `synthetic-${i}`, enabled: i % 5 !== 3 }))
  const merged = [
    ...order.slice(0, 2),
    ...mine.slice(0, 14),
    ...order.slice(2, at + 1),
    ...mine.slice(14),
    ...order.slice(at + 1)
  ]
  return { ...base, prompts, prompt_order: [{ character_id: 100001, order: merged }] }
}
