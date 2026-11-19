// What the preset in use does with a card's own prompts (DESIGN §5.0), read in the reader workers.
import { CardPromptUse, type LorebookPreset } from "@dreamspan/shared/chatSetupApi.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { BUILTIN_PRESET_LABEL } from "@dreamspan/shared/generation.ts"
import { LegacyPresetDoc } from "@dreamspan/shared/docs/preset.ts"
import { presetOrder } from "@dreamspan/shared/presetOrder.ts"
import { Effect, Exit, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { builtinPreset } from "./assemblySources.ts"
import { readDefaults } from "./generationSettings.ts"

const decode = Schema.decodeUnknownExit(LegacyPresetDoc)

/**
 * The preset chats use now (the account's, else the built-in Default) and, for `main` and
 * `jailbreak`, whether a card's prompt would replace it. Read without assembling anything.
 */
export const readCardPromptUse = (sql: SqlClient.SqlClient, userId: UserId) =>
  Effect.gen(function* () {
    const ref = (yield* readDefaults(sql, userId)).preset
    const [row] = ref
      ? yield* sql<{ label: string; doc_json: string }>`
          SELECT r.label, h.doc_json FROM entity_refs r JOIN entities e ON e.id = r.entity_id
          JOIN entity_revisions h ON h.id = r.head_revision_id
          WHERE r.id = ${ref} AND e.owner_user_id = ${userId} AND e.kind = 'preset' AND e.deleted_at IS NULL`
      : []
    const decoded = row ? decode({ ...builtinPreset, ...JSON.parse(row.doc_json) }) : undefined
    const doc = decoded && Exit.isSuccess(decoded) ? decoded.value : builtinPreset
    const order = presetOrder(doc.prompts, doc.order)
    const use = (identifier: "main" | "jailbreak", fallback: string) => {
      const prompt = doc.prompts.find((p) => p.identifier === identifier)
      const entry = order.find((e) => e.identifier === identifier)
      return {
        name: prompt?.name || fallback,
        state:
          !prompt || !entry
            ? ("missing" as const)
            : prompt.forbid_overrides
              ? ("forbidden" as const)
              : entry.enabled
                ? ("replaceable" as const)
                : ("disabled" as const)
      }
    }
    return new CardPromptUse({
      preset: row && decoded && Exit.isSuccess(decoded) ? row.label : BUILTIN_PRESET_LABEL,
      main: use("main", "Main Prompt"),
      jailbreak: use("jailbreak", "Post-History Instructions")
    })
  })

/**
 * The user's live presets whose HEAD lists the lorebook `ref`. Owner-scoped: another user's
 * presets never show.
 */
export const readLorebookPresets = (sql: SqlClient.SqlClient, userId: UserId, ref: RefId) =>
  Effect.map(
    sql<{ ref_id: string; label: string; enabled: number }>`
      SELECT r.id AS ref_id, r.label, json_extract(l.value, '$.enabled') AS enabled
      FROM entity_refs r JOIN entities e ON e.id = r.entity_id
      JOIN entity_revisions h ON h.id = r.head_revision_id
      JOIN json_each(h.doc_json, '$.lorebooks') l
      WHERE e.owner_user_id = ${userId} AND e.kind = 'preset' AND e.deleted_at IS NULL
        AND json_extract(l.value, '$.id') = ${ref}
      ORDER BY r.label, r.id`,
    (rows): ReadonlyArray<LorebookPreset> =>
      rows.map((row) => ({ refId: row.ref_id as RefId, label: row.label, enabled: row.enabled === 1 }))
  )
