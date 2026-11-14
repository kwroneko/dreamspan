// "Export this chat" (ARCHITECTURE.md §13b): a chat's branch, or all of them, as SillyTavern
// chat files or plain text, read from the reader workers a window at a time and written to
// the response as it's read, so neither the server nor the browser holds a whole chat. The
// library archive (libraryArchive.ts) writes every chat the same way.
import type { CastCard, Chat, EntityId, Fork, PathEntry, Version } from "@rp/shared/chat.ts"
import type { ChatId, ForkId, SlotId } from "@rp/shared/chatPosition.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { NotFound } from "@rp/shared/errors.ts"
import { foldState } from "@rp/shared/state.ts"
import { chatKinds } from "@rp/shared/chatKinds.ts"
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
const SWIPED_BATCH = 200

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
  format: ChatExportFormat
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
        return { name: card?.name ?? (user ? userName : (voice ?? "Narrator")), user }
      }
      return { userName, characterName, voices, speaker }
    }

    const leadCast = lead === null ? null : yield* Effect.promise(() => castOf(lead))
    const base = fileStem(
      chat.title,
      fileStem(`${leadCast?.characterName ?? "Chat"} - ${stStamp(chat.createdAt)}`, "Chat")
    )

    /** One branch's path, root first: read backwards a window at a time, then given in order. */
    async function* pathOf(fork: Fork): AsyncGenerator<ReadonlyArray<PathEntry>> {
      const windows: Array<ReadonlyArray<PathEntry>> = []
      let window = await run(
        reader.ReadPath({ userId, chatId, forkId: fork.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: WINDOW })
      )
      windows.push(window.entries)
      while (window.older !== null) {
        window = await run(
          reader.ReadPath({
            userId,
            chatId,
            forkId: fork.id,
            leafSlotId: null,
            range: { _tag: "Older", from: window.older },
            limit: WINDOW
          })
        )
        windows.push(window.entries)
      }
      while (windows.length > 0) yield windows.pop()!
    }

    async function* lines(fork: Fork, mainChat: string | null): AsyncGenerator<string> {
      const cast = fork.id === lead?.id && leadCast ? leadCast : await castOf(fork)
      if (format === "jsonl")
        yield stHeader({
          userName: cast.userName,
          characterName: cast.characterName,
          createdAt: chat.createdAt,
          mainChat
        }) + "\n"
      let firstLine = true
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
          for (const entry of batch)
            yield stLine(entry, versions.get(entry.slotId) ?? [entry.version], cast.speaker(entry), cast.userName) +
              "\n"
        }
      }
      if (format === "txt" && !firstLine) yield "\n"
    }

    const extension = format === "jsonl" ? "jsonl" : "txt"
    const ordered = familyOrder(forks)
    /** Each branch's file name: the first's is the chat's, the others "<it> - Branch #n". */
    const stemsFor = (stem: string) =>
      new Map(ordered.map((fork, index) => [fork.id as string, index === 0 ? stem : `${stem} - Branch #${index}`]))
    return {
      base,
      extension,
      /** The chat's characters, as its lead branch has them; more than one is a group. */
      voices: leadCast?.voices ?? [],
      branches: ordered.length,
      /** The branches' file names when the chat's is `stem`, first to last. */
      stems: (stem: string) => [...stemsFor(stem).values()],
      /** One branch as a file on its own, without a main chat. */
      single: (fork: Fork) => textChunks(lines(fork, null)),
      /** Every branch in `folder`, each linked to the file of the branch it was made from. */
      entries: async function* (folder: string, stem = base): AsyncGenerator<ZipStreamEntry> {
        const stems = stemsFor(stem)
        for (const fork of ordered) {
          const parent = fork.parentForkId === null ? null : (stems.get(fork.parentForkId) ?? null)
          yield { name: `${folder}${stems.get(fork.id)!}.${extension}`, chunks: textChunks(lines(fork, parent)) }
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
    if (scope === "branch" || files.branches <= 1) {
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
