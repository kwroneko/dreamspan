// The library items the first workshop seeds (spec/WORKSHOP-CONTEXT.md §4.3): a registered,
// extendable set. Each is created once per user as an ordinary editable library entry; the
// entry marked `default` of each kind is what new workshops start with. More assistant cards
// can be registered (the owner: "We will likely supply some default ones of our own").
import { newCardDoc } from "@rp/shared/editing.ts"
import { promptPreset, type PresetDoc } from "@rp/shared/docs/preset.ts"
import { charDefinitions, mainPrompt, newestMessage } from "@rp/shared/presetOrder.ts"
import { makeRegistry } from "@rp/shared/registry.ts"
import { workshopPieces } from "@rp/shared/workshopPreset.ts"
import { builtinPreset } from "./assemblySources.ts"

export interface WorkshopSeed {
  readonly id: string
  readonly kind: "card" | "preset"
  readonly order: number
  readonly label: string
  /** `entity_revisions.origin_ref` of its first revision: `builtin:<id>@<version>`. */
  readonly originRef: string
  /** What new workshops start with, of its kind (the first by order when several say so). */
  readonly default?: boolean
  readonly doc: () => object
}

const assistant = {
  ...newCardDoc("Assistant"),
  description:
    "Practical and brief. You say what you're about to change, change it, then say what you changed. You don't describe changes you haven't made.",
  first_mes: "What would you like to work on, {{user}}?"
}

const preset = (): PresetDoc => {
  const base = promptPreset(builtinPreset)
  const pieces = workshopPieces()
  return {
    ...base,
    prompts: [
      {
        ...mainPrompt,
        content:
          "You are the workshop assistant in a roleplay app. You help {{user}} with the app itself: characters, chats, prompt presets, lorebooks, settings, and plugins that change how the app works. You don't roleplay here."
      },
      charDefinitions,
      { ...newestMessage, identifier: "chatHistory", name: "Chat history" },
      newestMessage,
      ...pieces.map((p) => p.prompt)
    ],
    // The added pieces stay off until something fills them (§4.2): the seeded order sends what
    // it sent before they existed.
    order: [
      ...["main", "charDefinitions", "summaries", "chatHistory", "newestMessage"].map((identifier) => ({
        identifier,
        enabled: true
      })),
      ...pieces
        .filter((p) => p.prompt.identifier !== "summaries")
        .map((p) => ({ identifier: p.prompt.identifier, enabled: false }))
    ],
    utility_prompts: { ...builtinPreset.utility_prompts, new_chat_prompt: "", new_group_chat_prompt: "" },
    prefill: { assistant: "", impersonation: "", continue: false, continue_postfix: "" }
  }
}

/**
 * The seeds, read in the writer worker by `CreateWorkshop`. A registration made on the main
 * thread doesn't reach that worker yet: shipping more default cards means adding entries here.
 * @public
 */
export const workshopSeeds = makeRegistry<WorkshopSeed>([
  {
    id: "workshop-assistant",
    kind: "card",
    order: 10,
    label: "Assistant",
    originRef: "builtin:workshop-assistant@1",
    default: true,
    doc: () => assistant
  },
  {
    id: "workshop-preset",
    kind: "preset",
    order: 10,
    label: "Workshop",
    originRef: "builtin:workshop-preset@3",
    default: true,
    doc: preset
  }
])

/** The default seed of a kind: the first by order marked default, else the first. */
export const defaultSeed = (kind: WorkshopSeed["kind"]) => {
  const seeds = workshopSeeds
    .list()
    .filter((s) => s.kind === kind)
    .toSorted((a, b) => a.order - b.order)
  return seeds.find((s) => s.default) ?? seeds[0]
}
