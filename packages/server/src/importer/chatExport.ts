// "Export this chat" (ARCHITECTURE.md §13b): a chat's branch, or all of them, as SillyTavern
// chat files or plain text, read from the reader workers a window at a time and written to
// the response as it's read, so neither the server nor the browser holds a whole chat. The
// library archive (libraryArchive.ts) writes every chat the same way.
import type { CastCard, Chat, EntityId, Fork, PathEntry, RecordedGeneration, Version } from "@dreamspan/shared/chat.ts"
import type { ChatId, ForkId, SlotId } from "@dreamspan/shared/chatPosition.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { NotFound } from "@dreamspan/shared/errors.ts"
import { foldState } from "@dreamspan/shared/state.ts"
import { chatKinds } from "@dreamspan/shared/chatKinds.ts"
import { Effect, Schema } from "effect"
import type { Reader } from "../db/Database.ts"
import { fileStem, stHeader, stLine, type StSpeaker, stStamp, textLine } from "../formats/stChatExport.ts"
import { textChunks, zipStream, type ZipStreamEntry } from "../formats/zipStream.ts"

/** The chat's kind doesn't export as this format. */
class ExportNotOffered extends Schema.TaggedError<ExportNotOffered>()("ExportNotOffered", {
  format: Schema.String
}) {}

export type ChatExportFormat = "jsonl" | "txt"
export type ChatExportScope = "branch" | "all"

/** Messages read per request; the readers' window cap (db/ops.ts MAX_PATH_WINDOW). */
const WINDOW = 1000
/** Messages whose versions are read in one request. */
const SWIPED_BATCH = 20

interface ChatExport {
  /** The download's name, with its extension. */
  readonly fileName: string
  readonly contentType: string
  /** How many files: 1, or the branches in an "all" zip. */
  readonly files: number
  readonly body: AsyncIterable<Uint8Array>
}

export type ReaderService = Reader["Service"]
export type Run = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
export const run: Run = (effect) => Effect.runPromise(effect)

/** Forks with each parent before the forks made from it, the chat's first leading. */
const familyOrder = (forks: ReadonlyArray<Fork>) => {
  const children = new Map<string | null, Array<Fork>>()
  const ids = new Set(forks.map((fork) => fork.id as string))
  for (const fork of forks) {
    const parent = fork.parentForkId !== null && ids.has(fork.parentForkId) ? fork.parentForkId : null
    children.set(parent, [...(children.get(parent) ?? []), fork])
  }
  const ordered: Array<Fork> = []
  const queue = [...(children.get(null) ?? [])].sort((a, b) => a.createdAt - b.createdAt)
  while (queue.length > 0) {
    const fork = queue.shift()!
    ordered.push(fork)
    queue.push(...(children.get(fork.id) ?? []).sort((a, b) => a.createdAt - b.createdAt))
  }
  return ordered
}

/** The filename and actual ST avatar folder captured when the library was listed. */
export interface ExportAvatar {
  readonly file: string
  readonly type: "avatar" | "persona"
}

/**
 * A chat's files: its name, who's in it, and each branch's lines. `lead` is the branch whose
 * cast names the chat (the one it opens on, or the one asked for).
 */
export const chatFiles = (
  reader: ReaderService,
  userId: UserId,
  chat: Chat,
  forks: ReadonlyArray<Fork>,
  lead: Fork | null,
  format: ChatExportFormat,
  avatars: ReadonlyMap<string, ExportAvatar> = new Map()
) =>
  Effect.gen(function* () {
    const chatId = chat.id
    const cards = new Map<string, CastCard>()
    const known = async (ids: Iterable<string>) => {
      const missing = [...new Set(ids)].filter((id) => !cards.has(id))
      if (missing.length === 0) return
      for (const card of await run(reader.CastCards({ userId, entityIds: missing as Array<EntityId> })))
        cards.set(card.entityId, card)
    }

    /** Who's who on a branch: the persona the user plays at its tip, and its other voices. */
    const castOf = async (fork: Fork) => {
      const state = foldState(
        await run(reader.StateEventsAt({ userId, chatId, slotId: fork.tipSlotId, forkId: fork.id }))
      )
      const persona = state.playedByMe.at(-1) ?? null
      const voices = state.participants.filter((id) => !state.playedByMe.includes(id))
      await known([...(persona ? [persona] : []), ...voices])
      const userName = (persona && cards.get(persona)?.name) || "User"
      const characterName = voices.map((id) => cards.get(id)?.name).find((name) => name) ?? chat.title
      const voice = voices.length === 1 ? (cards.get(voices[0]!)?.name ?? null) : null
      const speaker = (entry: PathEntry): StSpeaker => {
        const id = entry.version.speakerEntityId ?? entry.firstSpeakerEntityId
        const card = id === null ? undefined : cards.get(id)
        const user =
          id !== null ? state.playedByMe.includes(id) || card?.persona === true : entry.version.writer === "human"
        return {
          name: card?.name ?? (user ? userName : (voice ?? "Narrator")),
          user,
          ...(id && avatars.has(id) ? { avatar: avatars.get(id)!.file, avatarType: avatars.get(id)!.type } : {})
        }
      }
      return { userName, characterName, voices, speaker }
    }

    const leadCast = lead === null ? null : yield* Effect.promise(() => castOf(lead))
    const base = fileStem(
      chat.title,
      fileStem(`${leadCast?.characterName ?? "Chat"} - ${stStamp(chat.createdAt)}`, "Chat")
    )

    /** Keep only page cursors on the backwards pass; re-read each page root first. */
    async function* pathOf(fork: Fork): AsyncGenerator<ReadonlyArray<PathEntry>> {
      const read = (leafSlotId: SlotId | null, end: SlotId | null) =>
        run(
          reader.ReadPath({
            userId,
            chatId,
            forkId: fork.id,
            leafSlotId,
            displayLeaf: true,
            range: end === null ? { _tag: "Bottom" } : { _tag: "Older", from: end },
            limit: WINDOW
          })
        )
      const cursors: Array<SlotId | null> = []
      let leaf: SlotId | null = null
      let cursor: SlotId | null = null
      do {
        cursors.push(cursor)
        const page = await read(leaf, cursor)
        leaf ??= page.leafSlotId
        if (leaf === null) return
        cursor = page.older
      } while (cursor !== null)
      while (cursors.length > 0) {
        const page = await read(leaf, cursors.pop()!)
        yield page.entries
      }
    }

    async function* lines(
      fork: Fork,
      mainChat: string | null,
      branchLinks: ReadonlyMap<SlotId, ReadonlyArray<string>> = new Map(),
      branchOffsets: ReadonlyMap<number, ReadonlyArray<string>> = new Map()
    ): AsyncGenerator<string> {
      const cast = fork.id === lead?.id && leadCast ? leadCast : await castOf(fork)
      if (format === "jsonl")
        yield stHeader({
          userName: cast.userName,
          characterName: cast.characterName,
          createdAt: chat.createdAt,
          mainChat
        }) + "\n"
      let firstLine = true
      let messageIndex = 0
      for await (const entries of pathOf(fork)) {
        await known(
          entries.flatMap((entry) => {
            const id = entry.version.speakerEntityId ?? entry.firstSpeakerEntityId
            return id === null ? [] : [id]
          })
        )
        if (format === "txt") {
          for (const entry of entries) {
            yield (firstLine ? "" : "\n\n") + textLine(entry, cast.speaker(entry), cast.userName)
            firstLine = false
          }
          continue
        }
        // Swiped messages' versions a batch at a time: 50 swipes of a long reply each make a
        // window's worth tens of megabytes.
        for (let start = 0; start < entries.length; start += SWIPED_BATCH) {
          const batch = entries.slice(start, start + SWIPED_BATCH)
          const swiped = batch.filter((entry) => entry.versionCount > 1).map((entry) => entry.slotId)
          const versions = new Map<SlotId, ReadonlyArray<Version>>()
          if (swiped.length > 0)
            for (const { slotId, versions: list } of await run(
              reader.ExportVersions({ userId, chatId, forkId: fork.id, slotIds: swiped })
            ))
              versions.set(slotId, list)
          // Imported figures live on the version; native figures live in the ledger.
          // VersionMetrics caps a request at 200 ids and follows continuation ancestry.
          const native = [
            ...new Map(
              batch
                .flatMap((entry) => versions.get(entry.slotId) ?? [entry.version])
                .map((version) => [version.id, version])
            ).values()
          ].filter(
            (version) =>
              version.writer === "model" &&
              version.recorded === undefined &&
              version.origin !== "imported" &&
              version.origin !== "greeting"
          )
          const figures = new Map<string, RecordedGeneration>()
          for (let at = 0; at < native.length; at += 200) {
            for (const metrics of await run(
              reader.VersionMetrics({ userId, versionIds: native.slice(at, at + 200).map((version) => version.id) })
            )) {
              const last = metrics.last
              figures.set(metrics.versionId, {
                startedAt: last.startedAt,
                ...(last.endedAt !== null ? { finishedAt: last.endedAt } : {}),
                ...(!metrics.running && metrics.outputUnknown === 0 ? { tokens: metrics.output } : {}),
                ...(last.firstTokenAt !== null ? { firstTokenMs: last.firstTokenAt - last.startedAt } : {})
              })
            }
          }
          const withFigures = (version: Version): Version => {
            const recorded = figures.get(version.id)
            return recorded ? { ...version, recorded } : version
          }
          for (const entry of batch) {
            messageIndex++
            yield stLine(
              { ...entry, version: withFigures(entry.version) },
              (versions.get(entry.slotId) ?? [entry.version]).map(withFigures),
              cast.speaker(entry),
              cast.userName,
              branchLinks.get(entry.slotId) ?? branchOffsets.get(messageIndex)
            ) + "\n"
          }
        }
      }
      if (format === "txt" && !firstLine) yield "\n"
    }

    const extension = format === "jsonl" ? "jsonl" : "txt"
    const ordered = familyOrder(forks)
    /** Names are portable and unique, including user-named root branches. */
    const stemsFor = (stem: string) => {
      const taken = new Set<string>()
      return new Map(
        ordered.map((fork, index) => {
          const base = fork.name?.trim()
            ? `${stem} - ${fileStem(fork.name, "Branch", 230 - Buffer.byteLength(stem) - 3)}`
            : index === 0
              ? stem
              : `${stem} - Branch #${index}`
          let name = base
          for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})`
          taken.add(name.toLowerCase())
          return [fork.id as string, name]
        })
      )
    }

    return {
      base,
      extension,
      /** The chat's characters, as its lead branch has them; more than one is a group. */
      voices: leadCast?.voices ?? [],
      branches: ordered.length,
      /** The branches' file names when the chat's is `stem`, first to last. */
      stems: (stem: string) => [...stemsFor(stem).values()],
      currentStem: (stem: string) => (lead ? stemsFor(stem).get(lead.id) : undefined),
      /** One branch as a file on its own, without a main chat. */
      single: (fork: Fork) => textChunks(lines(fork, null)),
      /** Every branch in `folder`, each linked to the file of the branch it was made from. */
      entries: async function* (folder: string, stem = base): AsyncGenerator<ZipStreamEntry> {
        const stems = stemsFor(stem)
        for (const fork of ordered) {
          const parent = fork.parentForkId === null ? null : (stems.get(fork.parentForkId) ?? null)
          const links = new Map<SlotId, Array<string>>()
          const offsets = new Map<number, Array<string>>()
          for (const child of ordered) {
            if (child.parentForkId !== fork.id) continue
            if (child.baseSlotId !== null)
              links.set(child.baseSlotId, [...(links.get(child.baseSlotId) ?? []), stems.get(child.id)!])
            else if (child.split && child.split.after > 0)
              offsets.set(child.split.after, [...(offsets.get(child.split.after) ?? []), stems.get(child.id)!])
          }
          yield {
            name: `${folder}${stems.get(fork.id)!}.${extension}`,
            chunks: textChunks(lines(fork, parent, links, offsets))
          }
        }
      }
    }
  })

/** Whether a chat's kind makes this format. */
export const exportsAs = (chat: Chat, format: ChatExportFormat) =>
  (chatKinds.get(chat.kind)?.exportFormats ?? []).includes(format)

/**
 * The export's files, checked before the first byte is sent: NotFound for a chat or branch
 * that isn't the user's. The body reads on as the response is sent; it stops when the
 * browser goes away.
 */
export const chatExport = (
  reader: ReaderService,
  userId: UserId,
  request: {
    readonly chatId: ChatId
    readonly forkId: ForkId | null
    readonly scope: ChatExportScope
    readonly format: ChatExportFormat
  }
) =>
  Effect.gen(function* () {
    const { chatId, scope, format } = request
    const chat = yield* reader.GetChat({ userId, chatId })
    // A pending chat (DESIGN §2.1) has no files until it is committed.
    if (chat.status === "pending") return yield* new NotFound({ entity: "chat", id: chatId })
    // A kind's profile says which files it makes (a workshop's has no ST counterpart).
    if (!exportsAs(chat, format)) return yield* new ExportNotOffered({ format })
    const forks = yield* reader.ListForks({ userId, chatId })
    const wanted = request.forkId ?? chat.currentForkId
    const chosen = forks.find((fork) => fork.id === wanted) ?? forks.find((fork) => fork.current) ?? forks[0] ?? null
    if (request.forkId !== null && chosen?.id !== request.forkId) {
      return yield* new NotFound({ entity: "fork", id: request.forkId })
    }
    if (chosen === null) return yield* new NotFound({ entity: "chat", id: chatId })
    const files = yield* chatFiles(reader, userId, chat, forks, chosen, format)
    if (scope === "branch") {
      return {
        fileName: `${files.base}.${files.extension}`,
        contentType: format === "jsonl" ? "application/x-ndjson; charset=utf-8" : "text/plain; charset=utf-8",
        files: 1,
        body: files.single(chosen)
      } satisfies ChatExport
    }
    return {
      fileName: `${files.base}.zip`,
      contentType: "application/zip",
      files: files.branches,
      body: zipStream(files.entries(""))
    } satisfies ChatExport
  })
