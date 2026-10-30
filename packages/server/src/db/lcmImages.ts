// The images a level-1 summary was written with, and whether a fork would send the same ones
// (ARCHITECTURE §16 "Images"). An image the fork took out of the context must not reach it
// through a summary written where it was sent, so image choices are part of freshness.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { ContextSnapshot } from "../assembler/types.ts"
import { DEFAULT_MAX_IMAGES, newestImages } from "../assembler/images.ts"
import { imageExcludedIn, originalSql, type ForkRef } from "./forkState.ts"

/** What `summaries.images_json` holds: the media ids sent, in order, and the image limit they were cut to. */
export interface SummaryImages {
  readonly limit: number | null
  readonly sent: ReadonlyArray<string>
}

/** The images of `sent` a request to a model taking at most `limit` carries: its last ones. */
const cut = (images: ReadonlyArray<string>, limit: number | null) =>
  limit === null ? images : images.slice(Math.max(0, images.length - Math.max(0, Math.floor(limit))))

/** Whether any of these versions has an image attached; without one a summary records nothing. */
const attached = (sql: SqlClient.SqlClient, versionIds: ReadonlyArray<string | null>) => {
  const ids = versionIds.filter((id): id is string => id !== null)
  return ids.length
    ? sql<{
        id: string
      }>`SELECT version_id AS id FROM version_attachments WHERE version_id IN ${sql.in(ids)} LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0)
      )
    : Effect.succeed(false)
}

/**
 * The column value for a summary over `versionIds` written with the images of `snapshot`'s
 * request, as the summarizer sends them (the newest the model takes, `hydrateMessageImages`).
 */
export const requestImages = (
  sql: SqlClient.SqlClient,
  versionIds: ReadonlyArray<string | null>,
  snapshot: Pick<ContextSnapshot, "request" | "inputs">
) =>
  Effect.gen(function* () {
    if (!(yield* attached(sql, versionIds))) return null
    const limit = snapshot.inputs.model?.maxImages ?? DEFAULT_MAX_IMAGES
    const messages = snapshot.request.messages
    const newest = newestImages(messages, limit)
    const sent = messages.flatMap((m, i) =>
      (m.images ?? []).flatMap((image, j) => (newest.has(`${i}:${j}`) ? [image.mediaId] : []))
    )
    return JSON.stringify({ limit, sent } satisfies SummaryImages)
  })

/**
 * The column value for a summary over `versionIds` taken as covering what a fork shows, with
 * no request (an imported summary, a failed range, a completion without a frozen request):
 * every image the fork sends for them, uncut. `sent` is read only when one is attached.
 */
export const shownImages = <E, R>(
  sql: SqlClient.SqlClient,
  versionIds: ReadonlyArray<string | null>,
  sent: Effect.Effect<ReadonlyArray<string>, E, R>
) =>
  Effect.gen(function* () {
    if (!(yield* attached(sql, versionIds))) return null
    return JSON.stringify({ limit: null, sent: yield* sent } satisfies SummaryImages)
  })

/**
 * Whether the fork `fork` would send the images summary `summaryId` was written with, for
 * inputs already known to match (same versions and amendments). With none recorded its inputs
 * had none, and with no image taken out anywhere in the chat every fork sends what it was
 * written with, so neither reads anything more than one indexed probe.
 */
export const imagesMatch = (
  sql: SqlClient.SqlClient,
  chatId: string,
  summaryId: string,
  recorded: string | null,
  fork: ForkRef
) =>
  Effect.gen(function* () {
    if (recorded === null) return true
    const [excluding] =
      yield* sql`SELECT 1 FROM fork_overrides WHERE chat_id = ${chatId} AND kind = 'image_exclude' LIMIT 1`
    if (!excluding) return true
    const written = JSON.parse(recorded) as SummaryImages
    const rows = yield* sql<{ media_id: string }>`SELECT a.media_id
      FROM summary_inputs i JOIN versions v ON v.id = i.version_id JOIN version_attachments a ON a.version_id = v.id
      WHERE i.summary_id = ${summaryId} AND NOT ${imageExcludedIn(sql, fork, `(${originalSql("v")})`, "a.media_id")}
      ORDER BY i.ordinal, a.ordinal`
    const now = cut(
      rows.map((r) => r.media_id),
      written.limit
    )
    return now.length === written.sent.length && now.every((id, n) => id === written.sent[n])
  })
