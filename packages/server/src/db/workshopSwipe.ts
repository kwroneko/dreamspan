import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { User, type UserId } from "@dreamspan/shared/domain.ts"
import type { RolloutEffect } from "@dreamspan/shared/workshopApi.ts"
import { EffectUndoRefused } from "@dreamspan/shared/workshopApi.ts"
import { groupCreationUndos, standingForSwipe, type makeWorkshopEffectHandlers } from "./workshopEffects.ts"
import { makeWorkshopGrantReadHandlers } from "./workshopGrants.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { displayEndOf } from "./displayPath.ts"
import { transaction } from "./tx.ts"
import { NotFound, type SwipeFile, type WriteOps } from "./ops.ts"
import type { VersionId } from "@dreamspan/shared/chat.ts"
import type { makeWriteHandlers } from "./writes.ts"
import type { makeChangeReversalWriteHandlers } from "./changeReversals.ts"
import type { makeBinWriteHandlers } from "./binWrites.ts"

type Handlers = Parameters<typeof WriteOps.of>[0]
type LibraryRecipe =
  { bin: string } | { reversal: string; head: string; rowVersion: number; refId: string; drafts: string }

interface Recipes {
  readonly library: ReadonlyArray<LibraryRecipe>
  readonly files: ReadonlyArray<SwipeFile>
}

const keyOf = ({ rolloutId, toolCallId, seq }: RolloutEffect) => ({ rolloutId, toolCallId, seq })

export const makeWorkshopSwipeHandlers = (
  drafts: Parameters<typeof makeGraphWrites>[1],
  ops: Pick<Effect.Success<ReturnType<typeof makeWriteHandlers>>, "AddSelectedVersion"> &
    Pick<Effect.Success<ReturnType<typeof makeWorkshopEffectHandlers>>, "binForSwipe"> &
    Pick<
      Effect.Success<ReturnType<typeof makeChangeReversalWriteHandlers>>,
      "RevertLibraryChange" | "RedoLibraryChange"
    > &
    Pick<Effect.Success<ReturnType<typeof makeBinWriteHandlers>>, "RestoreBinItem">
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const graph = makeGraphWrites(sql, drafts)
    const { VersionEffects } = yield* makeWorkshopGrantReadHandlers
    const draftStamp = (refId: string) =>
      sql<{ stamp: string }>`SELECT json_group_array(json_array(id,row_version) ORDER BY id) AS stamp
      FROM drafts WHERE target_kind='entity_field' AND target_id=${refId}`.pipe(Effect.map(([row]) => row!.stamp))
    return {
      RegenerateWorkshop: ({ sourceVersionId, fileKeys = [], ...input }) =>
        Effect.gen(function* () {
          const { userId, slotId, forkId } = input
          const { slot, fork, shown } = yield* graph.slotInFork(userId, slotId, forkId)
          if (shown !== sourceVersionId || (yield* displayEndOf(sql, slot.chat_id, fork)) !== slotId)
            return yield* new EffectUndoRefused({
              message: "The reply's position changed. Review its changes before retrying."
            })
          const standing = (yield* VersionEffects({ userId, versionId: sourceVersionId })).filter(standingForSwipe)
          const files = standing.filter((effect) => effect.kind.startsWith("file."))
          const effects = standing.filter((effect) => !effect.kind.startsWith("file."))
          if (
            effects.some((effect) => !effect.swipe?.clean) ||
            files.length !== fileKeys.length ||
            files.some(
              (file) =>
                !fileKeys.some(
                  (key) =>
                    key.rolloutId === file.rolloutId && key.toolCallId === file.toolCallId && key.seq === file.seq
                )
            )
          )
            return yield* new EffectUndoRefused({ message: "The reply's changes need review. Try the swipe again." })
          const added = yield* ops.AddSelectedVersion(input)
          const seen = new Set<string>()
          const recipes: Array<LibraryRecipe> = []
          for (const { effect } of groupCreationUndos(effects, (effect) => effect.targetId)) {
            if (seen.has(effect.targetId)) continue
            seen.add(effect.targetId)
            if (effect.kind === "library.create") {
              recipes.push({ bin: yield* ops.binForSwipe(userId, effect) })
            } else {
              const group = effects.filter((e) => e.targetId === effect.targetId)
              const next = yield* ops.RevertLibraryChange({
                userId,
                effects: group.map(keyOf),
                expectedHead: effect.swipe!.head!
              })
              if (next.conflicts.length > 0)
                return yield* new EffectUndoRefused({ message: "An item changed since. Try the swipe again." })
              if (next.reversalId) {
                const refId = String(effect.undo!.refId)
                const [row] = yield* sql<{
                  row_version: number
                  head_revision_id: string
                }>`SELECT row_version,head_revision_id FROM entity_refs WHERE id=${refId}`
                recipes.push({
                  reversal: next.reversalId,
                  head: row!.head_revision_id,
                  rowVersion: row!.row_version,
                  refId,
                  drafts: yield* draftStamp(refId)
                })
              }
            }
          }
          if (recipes.length || files.length) {
            const now = Date.now()
            yield* sql`INSERT INTO jobs (id,owner_user_id,kind,payload_json,created_at,updated_at)
          VALUES (${added.version.id},${userId},'workshop-swipe',${JSON.stringify({ library: recipes, files: [] } satisfies Recipes)},${now},${now})`
          }
          return { ...added, reverted: recipes.length + files.length }
        }).pipe(transaction(sql, "RegenerateWorkshop")),

      SettleWorkshopSwipe: ({ versionId }) =>
        Effect.gen(function* () {
          const idFilter = versionId === undefined ? sql.literal("1") : sql`j.id=${versionId}`
          const pending = yield* sql<{
            id: VersionId
            owner: UserId
            handle: string
            display_name: string
            role: User["role"]
            payload_json: string
            restore: number
          }>`
        SELECT j.id,j.owner_user_id AS owner,j.payload_json,u.handle,u.display_name,u.role,
          coalesce(v.status IN ('stopped','failed','interrupted'),1) AND NOT EXISTS (
            WITH RECURSIVE runs(id) AS (
              SELECT v.rollout_id WHERE v.rollout_id IS NOT NULL
              UNION SELECT r.id FROM rollouts r JOIN runs p ON r.spawned_by_rollout_id=p.id
            ) SELECT 1 FROM rollout_effects own JOIN runs ON runs.id=own.rollout_id
          ) AS restore
        FROM jobs j JOIN users u ON u.id=j.owner_user_id LEFT JOIN versions v ON v.id=j.id
        WHERE j.kind='workshop-swipe' AND v.status IS NOT 'generating' AND ${idFilter}`
          let restored = 0
          const files: Array<{ versionId: VersionId; actor: User; files: ReadonlyArray<SwipeFile> }> = []
          for (const row of pending) {
            const recipes = JSON.parse(row.payload_json) as Recipes
            for (const recipe of row.restore ? recipes.library : []) {
              if ("bin" in recipe) {
                const result = yield* ops
                  .RestoreBinItem({ userId: row.owner, itemId: recipe.bin })
                  .pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)))
                if (result) restored++
              } else {
                const [found] = yield* sql`SELECT 1 FROM entity_refs r JOIN entities e ON e.id=r.entity_id
              WHERE r.id=${recipe.refId} AND r.head_revision_id=${recipe.head} AND r.row_version=${recipe.rowVersion}
                AND e.deleted_at IS NULL AND e.owner_user_id=${row.owner}`
                if (!found || (yield* draftStamp(recipe.refId)) !== recipe.drafts) continue
                const result = yield* ops
                  .RedoLibraryChange({ userId: row.owner, reversalId: recipe.reversal, expectedHead: recipe.head })
                  .pipe(Effect.catchTag(["NotFound", "EffectUndoRefused"], () => Effect.succeed(null)))
                if (result?.reversalId) restored++
              }
            }
            if (row.restore && recipes.files.length > 0) {
              files.push({
                versionId: row.id,
                actor: new User({
                  id: row.owner,
                  role: row.role,
                  handle: row.handle,
                  displayName: row.display_name
                }),
                files: recipes.files
              })
              yield* sql`UPDATE jobs SET payload_json=json_set(payload_json,'$.library',json('[]')) WHERE id=${row.id}`
            } else yield* sql`DELETE FROM jobs WHERE id=${row.id} AND kind='workshop-swipe'`
          }
          return { restored, files }
        }).pipe(transaction(sql, "SettleWorkshopSwipe")),

      RecordWorkshopSwipeFile: ({ userId, versionId, file }) =>
        Effect.gen(function* () {
          const [row] = yield* sql<{ payload_json: string }>`SELECT payload_json FROM jobs
        WHERE id=${versionId} AND owner_user_id=${userId} AND kind='workshop-swipe'`
          if (!row) return yield* new NotFound({ entity: "workshop swipe", id: versionId })
          const recipes = JSON.parse(row.payload_json) as Recipes
          yield* sql`UPDATE jobs SET payload_json=${JSON.stringify({
            ...recipes,
            files: [...recipes.files.filter((other) => other.path !== file.path || other.host !== file.host), file]
          })} WHERE id=${versionId}`
        }).pipe(transaction(sql, "RecordWorkshopSwipeFile")),

      ForgetWorkshopSwipeFiles: ({ userId, versionId }) =>
        sql`DELETE FROM jobs
      WHERE id=${versionId} AND owner_user_id=${userId} AND kind='workshop-swipe'`.pipe(
          Effect.asVoid,
          transaction(sql, "ForgetWorkshopSwipeFiles")
        )
    } satisfies Pick<
      Handlers,
      "RegenerateWorkshop" | "SettleWorkshopSwipe" | "RecordWorkshopSwipeFile" | "ForgetWorkshopSwipeFiles"
    >
  })
