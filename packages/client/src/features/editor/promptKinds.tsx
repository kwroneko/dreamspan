import { utilityMacros } from "@rp/shared/macros/builtins/utility.ts"
import { parse, type Node } from "@rp/shared/macros/parse.ts"
import type { PresetPrompt } from "@rp/shared/docs/preset.ts"
import { Icon, type IconName } from "../../ui/Icon.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { registry } from "../chat/macros.ts"

const slots: Record<string, readonly [string, string]> = {
  main: ["Main", "The main instruction for the chat. A card's own prompt can replace it."],
  jailbreak: ["Post-history", "Instructions sent after the chat history. A card's own prompt can replace it."],
  nsfw: ["Auxiliary", "Additional instructions alongside the main prompt."],
  enhanceDefinitions: ["Enhance definitions", "Instructions for expanding the character definitions."]
}
const markers: Record<string, readonly [string, IconName, string]> = {
  worldInfoBefore: ["World Info before", "insert-above", "Filled from lorebook entries placed before the definitions."],
  worldInfoAfter: ["World Info after", "insert-below", "Filled from lorebook entries placed after the definitions."],
  charDefinitions: ["Definitions", "people", "Filled from every cast card's definitions."],
  charDescription: ["Description", "preset", "Filled from the cast cards' descriptions."],
  charPersonality: ["Personality", "reasoning", "Filled from the cast cards' personalities."],
  scenario: ["Scenario", "guidance", "Filled from the cast cards' scenarios."],
  personaDescription: ["Persona", "model", "Filled from your cards' descriptions."],
  dialogueExamples: ["Examples", "type", "Filled from the cast cards' example dialogues."],
  newestMessage: ["Newest message", "continue", "Filled from the newest chat message."],
  summaries: ["Summaries", "summary", "Filled from the chat's summary layer."]
}

export function promptKind(prompt: PresetPrompt) {
  if (prompt.identifier === "chatHistory")
    return { label: "Chat history", icon: "chat" as const, hint: "Filled from the chat's messages, oldest first." }
  const marker = markers[prompt.identifier]
  if (prompt.marker)
    return {
      label: marker?.[0] ?? prompt.name,
      icon: marker?.[1] ?? "insert",
      hint: marker?.[2] ?? "Filled from the current chat."
    }
  const slot = slots[prompt.identifier]
  return slot || prompt.system_prompt
    ? { label: slot?.[0] ?? prompt.name, hint: slot?.[1] ?? "Built-in instructions for this preset slot." }
    : null
}

export function PromptKindTag({ prompt }: { prompt: PresetPrompt }) {
  const kind = promptKind(prompt)
  if (!kind) return null
  return (
    <Tooltip label={kind.hint}>
      <span
        tabIndex={0}
        data-prompt-kind-tag
        className="prompt-kind-tag shrink-0 rounded px-1.5 py-0.5 text-xs whitespace-nowrap"
      >
        {kind.label}
      </span>
    </Tooltip>
  )
}

const deterministicPick = utilityMacros.find((macro) => macro.name === "pick")!.handler

/** Registered random/clock macros rerun in preset text; built-in pick has a stable seed. */
export function volatileMacros(content: string): ReadonlyArray<string> {
  const names = new Set<string>()
  const pending: Array<Node> = [...parse(content)].reverse()
  while (pending.length) {
    const node = pending.pop()!
    if (node.kind === "macro") {
      const entry = registry.get(node.name.toLowerCase())
      // pick's volatile flag stores its draw for display, but its assembly seed is stable.
      if (!node.flags.includes("/") && entry?.volatile && entry.handler !== deterministicPick)
        names.add(`{{${node.name}}}`)
      pending.push(...node.args.flatMap((arg) => arg.nodes).reverse())
    } else if (node.value) pending.push(...[...node.value.nodes].reverse())
  }
  return [...names]
}

export function VolatileBadge({ names }: { names: ReadonlyArray<string> }) {
  if (names.length === 0) return null
  return (
    <Tooltip
      label={`Contains ${names.join(", ")}: the cache stops here, so everything below is sent in full each reply. Move it below the chat history to keep the cache.`}
    >
      <span tabIndex={0} data-volatile-warning className="rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning">
        Changes every reply
      </span>
    </Tooltip>
  )
}

export function SummariesPlaceholder() {
  return (
    <section
      data-prompt="summaries"
      data-prompt-type="placeholder"
      className="prompt-placeholder my-1 rounded-lg border border-border px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <Icon name="summary" />
        <span className="text-sm font-medium">Summaries</span>
        <PromptKindTag prompt={{ identifier: "summaries", name: "Summaries", marker: true } as PresetPrompt} />
      </div>
      <p className="mt-1 text-xs text-muted">Filled from the chat's summary layer.</p>
    </section>
  )
}
