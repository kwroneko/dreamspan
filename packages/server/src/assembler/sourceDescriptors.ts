// Source descriptors are pure presentation over pinned provenance and owner-scoped lookups.
import type { ContextSource } from "@rp/shared/inspectorApi.ts"
import type { SlotId } from "@rp/shared/chat.ts"
import { CONDITION_LABELS } from "@rp/shared/presetConditions.ts"
import { endOfRequestText } from "@rp/shared/endOfRequest.ts"
import type { Source } from "./types.ts"

interface SourceLabels {
  readonly names: ReadonlyMap<string, string>
  readonly titles: ReadonlyMap<string, string>
  readonly promptNames: ReadonlyMap<string, string>
  readonly depthOf: ReadonlyMap<string, number>
  readonly ordinalOf: ReadonlyMap<string, number>
  readonly linkOf: (revision: string) => { readonly ref?: string }
}

export interface SourceDescriptor {
  /** Built-in kind or a plugin's <plugin-id>/<kind>. */
  readonly id: Source["kind"]
  readonly describe: (source: Source, labels: SourceLabels) => SourceDescription
}

export type SourceDescription = Omit<ContextSource, "id" | "kind" | "activation">

/** Missing/disabled plugins still leave a readable, identifiable provenance box. */
export const fallbackDescription = (source: Source): SourceDescription => ({ label: source.kind, slotId: null })

const builtinDescription = (source: Source, labels: SourceLabels): SourceDescription => {
  const { names, titles, promptNames, depthOf, ordinalOf, linkOf } = labels
  switch (source.kind) {
    case "preset": {
      // The end-of-request texts by the editor's labels, whatever the prompt's stored name.
      const end = endOfRequestText(source.identifier)
      if (end)
        return {
          label: `End of request: ${end.label.charAt(0).toLowerCase()}${end.label.slice(1)}`,
          slotId: null,
          ...(source.ref ? { ref: source.ref } : {})
        }
      const name = promptNames.get(`${source.revision}:${source.identifier}`)
      // Its other text (`utility.new_chat_prompt`, `prefill.assistant`) by what it is.
      const other = source.identifier.replace(/^utility\./, "").replaceAll("_", " ")
      const when = source.condition
        ? ` (sent ${CONDITION_LABELS[source.condition].toLowerCase()})`
        : source.triggers
          ? ` (sent only for ${source.triggers.join(", ")} generations)`
          : ""
      return {
        label: (name ? `Preset prompt “${name}”` : `Preset: ${other}`) + when,
        slotId: null,
        ...(source.ref ? { ref: source.ref } : {})
      }
    }
    case "card":
      return {
        label: `${source.persona ? "Persona" : "Card"} “${names.get(source.revision) ?? "unnamed"}”: ${source.field}`,
        slotId: null,
        ...linkOf(source.revision)
      }
    case "lorebook": {
      const title = titles.get(`${source.revision}:${source.uid}`)
      return {
        label: `Lorebook “${names.get(source.revision) ?? "unnamed"}”: entry ${source.uid}${title ? ` “${title}”` : ""}`,
        slotId: null,
        ...linkOf(source.revision)
      }
    }
    case "note":
      return { label: `Note “${names.get(source.revision) ?? "unnamed"}”`, slotId: null }
    case "summary":
      return {
        label: `Summary, level ${source.level}, messages ${source.from}–${source.to}, revision ${source.revisionNumber}`,
        slotId: null,
        summary: { id: source.id, revision: source.revision, stale: source.stale }
      }
    case "message": {
      const depth = depthOf.get(source.slot)
      const ordinal = ordinalOf.get(source.version)
      return {
        label: depth === undefined ? "A message" : `Message ${depth + 1}`,
        ...(source.number === undefined && ordinal === undefined ? {} : { version: source.number ?? ordinal! + 1 }),
        slotId: source.slot as SlotId
      }
    }
    case "direction":
      return { label: "One-turn direction", slotId: null }
    case "assembler":
      return {
        label: source.what.charAt(0).toUpperCase() + source.what.slice(1),
        slotId: null
      }
  }
  return fallbackDescription(source)
}
export const builtinSourceDescriptors: ReadonlyArray<SourceDescriptor> = (
  ["preset", "card", "lorebook", "note", "summary", "message", "direction", "assembler"] as const
).map((id) => ({
  id,
  describe: builtinDescription
}))
