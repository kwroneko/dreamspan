// The images a level-1 summary was written with, and whether a fork would send the same ones
// (ARCHITECTURE §16 "Images"). An image the fork took out of the context must not reach it
// through a summary written where it was sent, so image choices are part of freshness.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { ContextSnapshot } from "../assembler/types.ts"
import { DEFAULT_MAX_IMAGES, newestImages } from "../assembler/images.ts"
import { imageExcludedIn, originalSql, type ForkRef } from "./forkState.ts"

/**
 * What `summaries.images_json` holds: the media ids sent, in order, the image limit they were
 * cut to, and the inputs' images the fork took out (`withheld`: none of their places sent).
 */
interface SummaryImages {
  readonly limit: number | null
  readonly sent: ReadonlyArray<string>
  readonly withheld: ReadonlyArray<string>
}

/**
 * The column value. `withheld` are the images taken out (`excluded`) none of whose places among
 * the inputs was kept, and `sent` keeps only the inputs' own images (`attachedIds`) not withheld:
 * an image a plugin adds to the request is no input's, so it is neither recorded nor compared.
 */
const record = (
  limit: number | null,
  sent: ReadonlyArray<string>,
  attachedIds: ReadonlySet<string>,
  kept: ReadonlyArray<string>,
  excluded: ReadonlyArray<string>
) => {
  const shown = new Set(kept)
  const withheld = [...new Set(excluded)].filter((id) => !shown.has(id))
  const out = new Set(withheld)
  return JSON.stringify({
    limit,
    sent: sent.filter((id) => attachedIds.has(id) && !out.has(id)),
    withheld
  } satisfies SummaryImages)
}

/** The images of `sent` a request to a model taking at most `limit` carries: its last ones. */
const cut = (images: ReadonlyArray<string>, limit: number | null) =>
  limit === null ? images : images.slice(Math.max(0, images.length - Math.max(0, Math.floor(limit))))

/** The media attached to these versions; with none a summary records nothing. */
const attached = (sql: SqlClient.SqlClient, versionIds: ReadonlyArray<string | null>) => {
  const ids = versionIds.filter((id): id is string => id !== null)
  return ids.length
    ? sql<{ media_id: string }>`SELECT media_id FROM version_attachments WHERE version_id IN ${sql.in(ids)}`.pipe(
        Effect.map((rows) => new Set(rows.map((r) => r.media_id)))
      )
    : Effect.succeed(new Set<string>())
}

/**
 * The column value for a summary over `versionIds` written with the images of `snapshot`'s
 * request, as the summarizer sends them (the newest the model takes, `hydrateMessageImages`),
 * and the images its history read had taken out (`HistoryImage.excluded`, pinned with it).
 */
export const requestImages = (
  sql: SqlClient.SqlClient,
  versionIds: ReadonlyArray<string | null>,
  snapshot: Pick<ContextSnapshot, "request" | "inputs" | "sources">
) =>
  Effect.gen(function* () {
    const attachedIds = yield* attached(sql, versionIds)
    if (!attachedIds.size) return null
    const limit = snapshot.inputs.model?.maxImages ?? DEFAULT_MAX_IMAGES
    const messages = snapshot.request.messages
    const newest = newestImages(messages, limit)
    const sent = messages.flatMap((m, i) =>
      (m.images ?? []).flatMap((image, j) => (newest.has(`${i}:${j}`) ? [image.mediaId] : []))
    )
    const pinned = new Map(
      (snapshot.sources?.history ?? []).flatMap((read) => read.entries.map((e) => [e.versionId, e.images ?? []]))
    )
    const read = versionIds.flatMap((id) => (id === null ? [] : (pinned.get(id) ?? [])))
    return record(
      limit,
      sent,
      attachedIds,
      read.filter((image) => !image.excluded).map((image) => image.mediaId),
      read.filter((image) => image.excluded).map((image) => image.mediaId)
    )
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
    const attachedIds = yield* attached(sql, versionIds)
    if (!attachedIds.size) return null
    const images = yield* sent
    return record(null, images, attachedIds, images, [...attachedIds])
  })

/** `shownImages` gathered in steps: the record so far, with a step's sent and taken-out images before it. */
export const gatheredImages = (
  recorded: string | null,
  sent: ReadonlyArray<string>,
  excluded: ReadonlyArray<string>
) => {
  const later = recorded ? (JSON.parse(recorded) as SummaryImages) : { sent: [], withheld: [] }
  const all = [...sent, ...later.sent]
  return record(null, all, new Set(all), all, [...excluded, ...later.withheld])
}

/**
 * Whether the fork `fork` would send the images summary `summaryId` was written with, for
 * inputs already known to match (same versions and amendments): it sends every image the
 * summary carried, and of the ones it sends under the recorded limit, none is one the summary
 * was written without because it was taken out. Without a plugin's own image rule this is
 * exactly "it sends the same images"; with one, a summary stays fresh where it was written, so
 * no rule can make it be planned again on every reply. With none recorded its inputs had none,
 * and with no image taken out anywhere in the chat every fork sends what it was written with,
 * so neither reads anything more than one indexed probe.
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
    const rows = yield* sql<{ media_id: string; excluded: number }>`SELECT a.media_id,
        ${imageExcludedIn(sql, fork, `(${originalSql("v")})`, "a.media_id")} AS excluded
      FROM summary_inputs i JOIN versions v ON v.id = i.version_id JOIN version_attachments a ON a.version_id = v.id
      WHERE i.summary_id = ${summaryId}
      ORDER BY i.ordinal, a.ordinal`
    const sends = rows.filter((r) => !r.excluded).map((r) => r.media_id)
    const shown = new Set(sends),
      withheld = new Set(written.withheld)
    return written.sent.every((id) => shown.has(id)) && !cut(sends, written.limit).some((id) => withheld.has(id))
  })
