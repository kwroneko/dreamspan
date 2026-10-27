// What the history's cut state is valid for, read by lore activation and composition alike.
import { createHash } from "node:crypto"
import { type Assembly, need } from "./pipeline.ts"

/**
 * What the history's cut state holds for (ARCHITECTURE §15 "Stepped history"): the preset, the
 * model, the chat's settings, the cards, the notes and the lorebooks. Lore pins and admitted
 * examples are dropped when it changes.
 */
export const configurationOf = (assembly: Assembly) =>
  (assembly.configuration ??= createHash("sha256")
    .update(
      JSON.stringify([
        need(assembly, "preset").doc,
        assembly.model,
        need(assembly, "mode"),
        [...need(assembly, "cast").characters, ...need(assembly, "cast").personas].map((c) => [c.entity, c.doc]),
        [...(assembly.notes ?? []), ...(assembly.skippedNotes ?? [])].toSorted((a, b) =>
          a.entity.localeCompare(b.entity)
        ),
        assembly.lorebooks
      ])
    )
    .digest("hex"))

/** The previous context's cut state on this path, when it's from before this message. */
export const previousStart = (assembly: Assembly) =>
  assembly.previousHistoryStart && assembly.previousHistoryStart.depth <= need(assembly, "target").depth
    ? assembly.previousHistoryStart
    : null
