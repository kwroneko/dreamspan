// Valid documents for tests: every revision is checked against its kind's schema, so a
// test's card or preset is a real one, with only what the test cares about changed.
import { readFileSync } from "node:fs"
import type { CardDoc } from "@dreamspan/shared/docs/card.ts"
import type { LegacyPresetDoc as PresetDoc } from "@dreamspan/shared/docs/preset.ts"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { LOREBOOK_SCHEMA_VERSION } from "@dreamspan/shared/docs/lorebook.ts"
import { newCardDoc, newCardNote } from "@dreamspan/shared/editing.ts"
import type { Doc, EntityKind } from "@dreamspan/shared/library.ts"
import { importStPreset } from "../../src/formats/preset.ts"

/** A card with these fields, the others empty. */
export const cardDoc = (name: string, fields: Partial<CardDoc> = {}): CardDoc => ({ ...newCardDoc(name), ...fields })

const stDefault = importStPreset(readFileSync(new URL("../fixtures/presets/default.json", import.meta.url))).document!

/** A preset of these prompts, in this order and all enabled, with ST's defaults for the rest. */
export const presetDoc = (
  prompts: ReadonlyArray<{ readonly identifier: string; readonly content: string }> = [
    { identifier: "main", content: "Write vivid prose." }
  ],
  samplers: Partial<PresetDoc["samplers"]> = {}
): PresetDoc => {
  const template = stDefault.prompts.find((prompt) => prompt.identifier === "main")!
  return {
    ...stDefault,
    prompts: prompts.map((prompt) => ({ ...template, name: prompt.identifier, system_prompt: false, ...prompt })),
    order: prompts.map((prompt) => ({ identifier: prompt.identifier, enabled: true })),
    samplers: { ...stDefault.samplers, ...samplers }
  }
}

/** A valid document of each kind, named where the kind has a name. */
export const docFor = (kind: EntityKind, name: string): Doc => {
  switch (kind) {
    case "card":
      return cardDoc(name)
    case "preset":
      return presetDoc()
    case "lorebook":
      return {
        schema_version: LOREBOOK_SCHEMA_VERSION,
        name,
        description: "",
        scan_depth: null,
        token_budget: null,
        recursive_scanning: null,
        extensions: {},
        entries: []
      }
    case "note":
      return newCardNote("0190a000-0000-7000-8000-000000000000" as EntityId, name)
    case "preset_overlay":
      return {}
  }
}
