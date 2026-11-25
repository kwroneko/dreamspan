// Saved card media (spec/SAVED-MEDIA.md) in the workers. Reads list what queued revisions name
// (parsing their documents here, never on the main thread) and answer lookups; writes record
// addresses, results and approvals, each in one transaction with no network inside.
import type { UserId } from "@dreamspan/shared/domain.ts"
import { NotFound } from "@dreamspan/shared/errors.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import {
  DEFAULT_MEDIA_HOSTS,
  hostApproved,
  MediaHosts,
  mediaKey,
  normalizeHost,
  type MediaApprovalHost,
  type MediaKind,
  type SavedMediaStatus
} from "@dreamspan/shared/savedMedia.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { documentMedia } from "../savedMedia/extract.ts"
import { mediaPath } from "./media.ts"
import type { ReadOps, SavedMediaScan, WriteOps } from "./ops.ts"
import { putUserSetting, readSetting } from "./settings.ts"
import { query, transaction } from "./tx.ts"

const KEY = "media.saved.hosts"

const readMediaHosts = (sql: SqlClient.SqlClient, userId: string) =>
  readSetting(sql, "user", userId, KEY).pipe(
    Effect.map(({ value }) => {
      if (value === null) return DEFAULT_MEDIA_HOSTS
      const decoded = Schema.decodeUnknownOption(MediaHosts)(value)
      return decoded._tag === "Some" ? decoded.value : DEFAULT_MEDIA_HOSTS
    })
  )

/** The revisions an approval is about: these refs' heads, the user's only; null for all. */
const headsOf = (sql: SqlClient.SqlClient, userId: string, refIds: ReadonlyArray<RefId> | null) =>
  refIds === null
    ? Effect.succeed(null)
    : sql<{ id: string }>`SELECT er.head_revision_id AS id FROM entity_refs er
        JOIN entities e ON e.id = er.entity_id
        WHERE er.id IN (SELECT value FROM json_each(${JSON.stringify(refIds)})) AND e.owner_user_id = ${userId}`.pipe(
        Effect.map((rows) => rows.map((row) => row.id))
      )

/** The user's addresses `heads` name (all the user's when null), with this state. */
const scoped = (sql: SqlClient.SqlClient, userId: string, heads: ReadonlyArray<string> | null, state: string) =>
  heads === null
    ? sql<{ id: number; host: string; kind: MediaKind; url: string }>`SELECT id, host, kind, url FROM saved_media
        WHERE owner_user_id = ${userId} AND state = ${state}`
    : sql<{
        id: number
        host: string
        kind: MediaKind
        url: string
      }>`SELECT DISTINCT m.id, m.host, m.kind, m.url FROM saved_media m
        JOIN revision_media rm ON rm.media = m.id
        WHERE rm.revision_id IN (SELECT value FROM json_each(${JSON.stringify(heads)}))
          AND m.owner_user_id = ${userId} AND m.state = ${state}`

const ownedHead = (sql: SqlClient.SqlClient, userId: string, refId: RefId) =>
  Effect.gen(function* () {
    const [row] = yield* sql<{ head: string }>`SELECT er.head_revision_id AS head FROM entity_refs er
      JOIN entities e ON e.id = er.entity_id WHERE er.id = ${refId} AND e.owner_user_id = ${userId}`
    if (!row) return yield* new NotFound({ entity: "ref", id: refId })
    return row.head
  })

const statusOf = (sql: SqlClient.SqlClient, userId: string, head: string) =>
  sql<{ state: string; url: string; reason: string | null }>`SELECT m.state, m.url, m.reason FROM revision_media rm
    JOIN saved_media m ON m.id = rm.media
    WHERE rm.revision_id = ${head} AND m.owner_user_id = ${userId} ORDER BY m.id`.pipe(
    Effect.map((rows): SavedMediaStatus => {
      const count = (state: string) => rows.filter((row) => row.state === state).length
      return {
        saved: count("saved"),
        waiting: count("pending"),
        approval: count("approval"),
        declined: count("declined"),
        failed: rows
          .filter((row) => row.state === "failed")
          .map((row) => ({ url: row.url, reason: row.reason ?? "It couldn't be saved." }))
      }
    })
  )

/** Approval rows of hosts the list now covers become downloads. */
const releaseApproved = (sql: SqlClient.SqlClient, userId: string, hosts: MediaHosts, at: number) =>
  Effect.gen(function* () {
    const waiting = yield* sql<{ host: string }>`SELECT DISTINCT host FROM saved_media
      WHERE owner_user_id = ${userId} AND state = 'approval'`
    const approved = waiting.map((row) => row.host).filter((host) => hostApproved(hosts, host))
    if (approved.length)
      yield* sql`UPDATE saved_media SET state = 'pending', updated_at = ${at}
        WHERE owner_user_id = ${userId} AND state = 'approval'
          AND host IN (SELECT value FROM json_each(${JSON.stringify(approved)}))`
  })

const withHost = (list: MediaHosts, host: string, subdomains: boolean): MediaHosts => {
  const name = normalizeHost(host)
  const existing = list.hosts.find((entry) => entry.host === name)
  return {
    hosts: existing
      ? list.hosts.map((entry) =>
          entry.host === name ? { host: name, subdomains: entry.subdomains || subdomains } : entry
        )
      : [...list.hosts, { host: name, subdomains }]
  }
}

const hostOf = (url: string) => normalizeHost(new URL(url).hostname)

export const makeSavedMediaReadHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    ReadSavedMediaScans: ({ userId, refIds, limit }) =>
      Effect.gen(function* () {
        const rows =
          refIds !== null && userId !== null
            ? yield* sql<{ revision_id: string; owner_user_id: string; doc_json: string }>`
                SELECT s.revision_id, s.owner_user_id, r.doc_json FROM saved_media_scans s
                JOIN entity_revisions r ON r.id = s.revision_id
                WHERE s.owner_user_id = ${userId} AND s.revision_id IN (
                  SELECT er.head_revision_id FROM entity_refs er
                  WHERE er.id IN (SELECT value FROM json_each(${JSON.stringify(refIds)})))
                LIMIT ${limit}`
            : userId !== null
              ? yield* sql<{ revision_id: string; owner_user_id: string; doc_json: string }>`
                  SELECT s.revision_id, s.owner_user_id, r.doc_json FROM saved_media_scans s
                  JOIN entity_revisions r ON r.id = s.revision_id
                  WHERE s.owner_user_id = ${userId} ORDER BY s.queued_at LIMIT ${limit}`
              : yield* sql<{ revision_id: string; owner_user_id: string; doc_json: string }>`
                  SELECT s.revision_id, s.owner_user_id, r.doc_json FROM saved_media_scans s
                  JOIN entity_revisions r ON r.id = s.revision_id
                  ORDER BY s.queued_at LIMIT ${limit}`
        return rows.map((row): SavedMediaScan => ({
          revisionId: row.revision_id,
          ownerUserId: row.owner_user_id as UserId,
          media: documentMedia(JSON.parse(row.doc_json)).media
        }))
      }).pipe(query("ReadSavedMediaScans")),
    NextSavedMediaDownloads: ({ limit, skip }) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: number
          owner_user_id: string
          url: string
          host: string
          kind: MediaKind
          once: number
          revision_id: string | null
        }>`SELECT m.id, m.owner_user_id, m.url, m.host, m.kind, m.once,
            (SELECT revision_id FROM revision_media WHERE media = m.id LIMIT 1) AS revision_id
          FROM saved_media m WHERE m.state = 'pending'
            AND m.id NOT IN (SELECT value FROM json_each(${JSON.stringify(skip)}))
          ORDER BY m.updated_at, m.id LIMIT ${limit}`
        const hosts = new Map<string, MediaHosts>()
        for (const row of rows)
          if (!hosts.has(row.owner_user_id)) hosts.set(row.owner_user_id, yield* readMediaHosts(sql, row.owner_user_id))
        return rows.map((row) => ({
          id: row.id,
          ownerUserId: row.owner_user_id as UserId,
          url: row.url,
          host: row.host,
          kind: row.kind,
          once: row.once === 1,
          revisionId: row.revision_id,
          hosts: hosts.get(row.owner_user_id)!
        }))
      }).pipe(query("NextSavedMediaDownloads")),
    LookupSavedMedia: ({ userId, urls }) =>
      Effect.gen(function* () {
        const keys = new Map<string, string>()
        for (const url of urls) {
          const key = mediaKey(url)
          if (key !== null) keys.set(url, key)
        }
        if (keys.size === 0) return []
        const rows = yield* sql<{ url: string; state: string; media_id: string | null }>`
          SELECT url, state, media_id FROM saved_media WHERE owner_user_id = ${userId}
            AND url IN (SELECT value FROM json_each(${JSON.stringify([...new Set(keys.values())])}))`
        const byKey = new Map(rows.map((row) => [row.url, row]))
        return [...keys].flatMap(([url, key]) => {
          const row = byKey.get(key)
          if (!row || (row.state !== "saved" && row.state !== "pending")) return []
          return [{ url, mediaId: row.media_id, waiting: row.state === "pending" }]
        })
      }).pipe(query("LookupSavedMedia")),
    GetSavedMediaStatus: ({ userId, refId }) =>
      Effect.gen(function* () {
        return yield* statusOf(sql, userId, yield* ownedHead(sql, userId, refId))
      }).pipe(query("GetSavedMediaStatus")),
    ListMediaApproval: ({ userId, refIds }) =>
      Effect.gen(function* () {
        const rows = yield* scoped(sql, userId, yield* headsOf(sql, userId, refIds), "approval")
        const hosts = new Map<string, { kinds: Map<MediaKind, number>; urls: string[] }>()
        for (const row of rows) {
          const group = hosts.get(row.host) ?? { kinds: new Map<MediaKind, number>(), urls: [] }
          const { kinds, urls } = group
          kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + 1)
          urls.push(row.url)
          hosts.set(row.host, group)
        }
        return [...hosts]
          .map(([host, { kinds, urls }]): MediaApprovalHost => ({
            host,
            files: urls.length,
            kinds: [...kinds].map(([kind, files]) => ({ kind, files })),
            urls
          }))
          .sort((a, b) => b.files - a.files || a.host.localeCompare(b.host))
      }).pipe(query("ListMediaApproval")),
    GetMediaHosts: ({ userId }) => readMediaHosts(sql, userId).pipe(query("GetMediaHosts")),
    GetSavedMediaFile: ({ userId, mediaId }) =>
      sql<{ path: string; mime: string; byte_size: number }>`SELECT a.path, a.mime, a.byte_size
        FROM saved_media m JOIN media_assets a ON a.id = m.media_id
        WHERE m.owner_user_id = ${userId} AND m.media_id = ${mediaId} AND m.state = 'saved' LIMIT 1`.pipe(
        Effect.map(([row]) => (row ? { path: row.path, mime: row.mime, byteSize: row.byte_size } : null)),
        query("GetSavedMediaFile")
      )
  } satisfies Partial<Parameters<typeof ReadOps.of>[0]>
})

export const makeSavedMediaWriteHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    RecordSavedMediaScans: ({ scans, at }) =>
      Effect.gen(function* () {
        let recorded = 0
        const lists = new Map<string, MediaHosts>()
        for (const scan of scans) {
          // Gone already: recorded by another pass, or the revision was deleted.
          const taken =
            yield* sql`DELETE FROM saved_media_scans WHERE revision_id = ${scan.revisionId} RETURNING revision_id`
          if (taken.length === 0) continue
          recorded++
          let hosts = lists.get(scan.ownerUserId)
          if (!hosts) lists.set(scan.ownerUserId, (hosts = yield* readMediaHosts(sql, scan.ownerUserId)))
          for (const media of scan.media) {
            const url = mediaKey(media.url)
            if (url === null) continue
            const host = hostOf(url)
            const state = hostApproved(hosts, host) ? "pending" : "approval"
            const [row] = yield* sql<{ id: number }>`INSERT INTO saved_media
              (owner_user_id, url, host, kind, state, updated_at)
              VALUES (${scan.ownerUserId}, ${url}, ${host}, ${media.kind}, ${state}, ${at})
              ON CONFLICT (owner_user_id, url) DO UPDATE SET
                state = CASE WHEN saved_media.state = 'approval' AND excluded.state = 'pending'
                  THEN 'pending' ELSE saved_media.state END,
                updated_at = CASE WHEN saved_media.state = 'approval' AND excluded.state = 'pending'
                  THEN excluded.updated_at ELSE saved_media.updated_at END
              RETURNING id`
            yield* sql`INSERT INTO revision_media (revision_id, media) VALUES (${scan.revisionId}, ${row!.id})
              ON CONFLICT DO NOTHING`
          }
        }
        return recorded
      }).pipe(transaction(sql, "RecordSavedMediaScans")),
    RecordSavedMediaResult: ({ id, ownerUserId, url, at, saved, failure }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ id: number }>`SELECT id FROM saved_media WHERE id = ${id}
          AND owner_user_id = ${ownerUserId} AND url = ${url} AND state = 'pending'`
        if (!row) return false
        if (saved) {
          yield* sql`INSERT INTO media_assets ${sql.insert({
            id: uuidv7(),
            sha256: saved.sha256,
            mime: saved.mime,
            width: null,
            height: null,
            byte_size: saved.byteSize,
            path: mediaPath(saved.sha256),
            created_at: at
          })} ON CONFLICT (sha256) DO NOTHING`
          const [asset] = yield* sql<{ id: string }>`SELECT id FROM media_assets WHERE sha256 = ${saved.sha256}`
          yield* sql`UPDATE saved_media SET state = 'saved', media_id = ${asset!.id}, reason = NULL,
            updated_at = ${at} WHERE id = ${id}`
        } else
          yield* sql`UPDATE saved_media SET state = 'failed', reason = ${failure ?? "It couldn't be saved."},
            updated_at = ${at} WHERE id = ${id}`
        return true
      }).pipe(transaction(sql, "RecordSavedMediaResult")),
    RetrySavedMedia: ({ userId, refId, at }) =>
      Effect.gen(function* () {
        const head = yield* ownedHead(sql, userId, refId)
        const hosts = yield* readMediaHosts(sql, userId)
        const failed = yield* sql<{ id: number; host: string; once: number }>`SELECT m.id, m.host, m.once
          FROM revision_media rm JOIN saved_media m ON m.id = rm.media
          WHERE rm.revision_id = ${head} AND m.owner_user_id = ${userId} AND m.state = 'failed'`
        const retry = failed.filter((row) => row.once === 1 || hostApproved(hosts, row.host)).map((row) => row.id)
        if (retry.length)
          yield* sql`UPDATE saved_media SET state = 'pending', reason = NULL, updated_at = ${at}
            WHERE id IN (SELECT value FROM json_each(${JSON.stringify(retry)}))`
        return yield* statusOf(sql, userId, head)
      }).pipe(transaction(sql, "RetrySavedMedia")),
    DecideMediaApproval: ({ userId, decisions, at }) =>
      Effect.gen(function* () {
        let hosts = yield* readMediaHosts(sql, userId)
        for (const { host: rawHost, choice, urls } of decisions) {
          const host = normalizeHost(rawHost)
          if (choice === "approve" || choice === "approve-subdomains")
            hosts = withHost(hosts, host, choice === "approve-subdomains")
          else if (urls.length)
            yield* sql`UPDATE saved_media SET state = ${choice === "decline" ? "declined" : "pending"},
              once = ${choice === "once" ? 1 : 0}, updated_at = ${at}
              WHERE owner_user_id = ${userId} AND host = ${host} AND state = 'approval'
                AND url IN (SELECT value FROM json_each(${JSON.stringify(urls)}))`
        }
        if (decisions.some((decision) => decision.choice.startsWith("approve"))) {
          yield* putUserSetting(sql, userId, KEY, hosts)
          yield* releaseApproved(sql, userId, hosts, at)
        }
        return hosts
      }).pipe(transaction(sql, "DecideMediaApproval")),
    ChangeMediaHosts: ({ userId, add, remove, at }) =>
      Effect.gen(function* () {
        let hosts = yield* readMediaHosts(sql, userId)
        if (remove !== undefined) {
          const name = normalizeHost(remove)
          hosts = { hosts: hosts.hosts.filter((entry) => entry.host !== name) }
        }
        if (add !== undefined) hosts = withHost(hosts, add.host, add.subdomains)
        yield* putUserSetting(sql, userId, KEY, hosts)
        if (remove !== undefined) {
          const pending = yield* scoped(sql, userId, null, "pending")
          const revoked = pending.filter((row) => !hostApproved(hosts, row.host)).map((row) => row.id)
          if (revoked.length)
            yield* sql`UPDATE saved_media SET state = 'approval', once = 0, updated_at = ${at}
              WHERE once = 0 AND id IN (SELECT value FROM json_each(${JSON.stringify(revoked)}))`
        }
        if (add !== undefined) yield* releaseApproved(sql, userId, hosts, at)
        return hosts
      }).pipe(transaction(sql, "ChangeMediaHosts")),
    PruneSavedMedia: () =>
      Effect.gen(function* () {
        const gone = yield* sql<{ media_id: string | null }>`DELETE FROM saved_media
          WHERE NOT EXISTS (SELECT 1 FROM revision_media WHERE media = saved_media.id)
            AND NOT EXISTS (SELECT 1 FROM saved_media_scans WHERE owner_user_id = saved_media.owner_user_id)
          RETURNING media_id`
        const files = [...new Set(gone.flatMap((row) => (row.media_id === null ? [] : [row.media_id])))]
        if (files.length)
          // A file goes only when nothing names it: no account's reference, no saved address,
          // no chat cover, attachment or composer image.
          yield* sql`DELETE FROM media_assets WHERE id IN (SELECT value FROM json_each(${JSON.stringify(files)}))
            AND NOT EXISTS (SELECT 1 FROM media_refs WHERE media_id = media_assets.id)
            AND NOT EXISTS (SELECT 1 FROM saved_media WHERE media_id = media_assets.id)
            AND NOT EXISTS (SELECT 1 FROM chats WHERE cover_media_id = media_assets.id) /* chat:includes-pending: kept until swept */
            AND NOT EXISTS (SELECT 1 FROM forks WHERE cover_media_id = media_assets.id)
            AND NOT EXISTS (SELECT 1 FROM version_attachments WHERE media_id = media_assets.id)
            AND NOT EXISTS (SELECT 1 FROM composer_images WHERE media_id = media_assets.id)
            AND NOT EXISTS (SELECT 1 FROM swept_composer_files WHERE media_id = media_assets.id)`
        return gone.length
      }).pipe(transaction(sql, "PruneSavedMedia"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
})
