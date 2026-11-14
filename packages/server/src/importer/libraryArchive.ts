// The whole library as one zip in SillyTavern's data folder layout (ARCHITECTURE.md §13b), so
// the folder import (§13) or ST itself reads it back: cards as PNGs in `characters/`, personas'
// pictures in `User Avatars/` with their names and descriptions in `settings.json`, lorebooks
// in `worlds/`, presets in `OpenAI Settings/`, each chat's branches in `chats/<card>/` (a chat
// with several characters in `group chats/`, its group in `groups/`). Written as it's read:
// one file's bytes at a time, chats a window of messages at a time.
import type { Chat } from "@rp/shared/chat.ts"
import { chatCursor } from "@rp/shared/chatApi.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { EntityKind, LibraryRef, RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { fileStem } from "../formats/stChatExport.ts"
import type { ZipStreamEntry } from "../formats/zipStream.ts"
import { chatFiles, exportsAs, type ReaderService, type ExportAvatar, run } from "./chatExport.ts"

/** One library entry as a file, by an exporter (routes.ts `renderExport`); null when it can't be. */
export type RenderRef = (
  refId: RefId,
  format: string,
  worldNames?: Readonly<Record<string, string>>
) => Effect.Effect<Uint8Array | null>

/** Names unique in one folder, case aside, as file systems that ignore case need. */
const namer = () => {
  const taken = new Set<string>()
  return (name: string, fallback: string) => {
    const stem = fileStem(name, fallback)
    let unique = stem
    for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${stem} (${n})`
    taken.add(unique.toLowerCase())
    return unique
  }
}

async function* once(bytes: Uint8Array) {
  yield bytes
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2))

export const libraryArchive = (reader: ReaderService, userId: UserId, render: RenderRef) =>
  Effect.gen(function* () {
    const list = (kind: EntityKind, tag: string | null) =>
      Effect.map(
        Effect.all([
          reader.ListLibrary({ userId, kind, tag, archived: false }),
          reader.ListLibrary({ userId, kind, tag, archived: true })
        ]),
        ([live, archived]) => [...live, ...archived]
      )
    const personaIds = new Set((yield* list("card", "persona")).map((ref) => ref.entityId as string))
    const cards = (yield* list("card", null)).filter((ref) => !personaIds.has(ref.entityId))
    const personas = (yield* list("card", "persona")).filter((ref) => personaIds.has(ref.entityId))
    const lorebooks = yield* list("lorebook", null)
    const presets = yield* list("preset", null)

    // Cards reference external worlds by ST filename, so plan those names before writing
    // cards. Prefer imported source identities over labels (a fork can share its label).
    const worldName = namer()
    const worldStems = new Map(
      lorebooks.map((ref) => [ref.id, worldName((ref.lorebookSource ?? ref.label).replace(/\.json$/i, ""), "World")])
    )
    const worldAliases = new Map<string, string>()
    const ambiguousSources = new Set<string>()
    for (const source of [true, false]) {
      const matches = new Map<string, Array<string>>()
      for (const ref of lorebooks) {
        if (source && !ref.lorebookSource) continue
        const alias = source ? ref.lorebookSource!.replace(/\.json$/i, "") : ref.label
        const stems = matches.get(alias) ?? []
        stems.push(worldStems.get(ref.id)!)
        matches.set(alias, stems)
      }
      for (const [alias, stems] of matches) {
        if (source && stems.length !== 1) ambiguousSources.add(alias)
        if (stems.length === 1 && !ambiguousSources.has(alias) && !worldAliases.has(alias))
          worldAliases.set(alias, stems[0]!)
      }
    }
    const worldNames = Object.fromEntries(worldAliases)

    const cardName = namer()
    const cardStems = new Map(cards.map((ref) => [ref.entityId as string, cardName(ref.label, "Character")]))
    const personaName = namer()
    const personaStems = new Map(personas.map((ref) => [ref.entityId as string, personaName(ref.label, "Persona")]))
    const avatars = new Map<string, ExportAvatar>([
      ...[...cardStems].map(([id, stem]) => [id, { file: `${stem}.png`, type: "avatar" as const }] as const),
      ...[...personaStems].map(([id, stem]) => [id, { file: `${stem}.png`, type: "persona" as const }] as const)
    ])
    const skipped: Array<string> = []

    async function* files(
      refs: ReadonlyArray<LibraryRef>,
      format: string,
      path: (ref: LibraryRef) => string
    ): AsyncGenerator<ZipStreamEntry> {
      for (const ref of refs) {
        const bytes = await run(render(ref.id, format, format === "card-png" ? worldNames : undefined))
        if (bytes === null) skipped.push(`${ref.label} (${ref.kind})`)
        else yield { name: path(ref), chunks: once(bytes) }
      }
    }

    async function* chats(): AsyncGenerator<ZipStreamEntry> {
      const groups: Array<{
        id: string
        name: string
        members: Array<string>
        chats: Array<string>
        current: string | undefined
      }> = []
      // File names taken in each folder, case aside: a chat's branches take theirs too.
      const taken = new Map<string, Set<string>>()
      const place = (folder: string, family: { base: string; stems: (stem: string) => ReadonlyArray<string> }) => {
        const names = taken.get(folder) ?? new Set<string>()
        taken.set(folder, names)
        let stem = family.base
        for (let n = 2; family.stems(stem).some((name) => names.has(name.toLowerCase())); n++)
          stem = `${family.base} (${n})`
        for (const name of family.stems(stem)) names.add(name.toLowerCase())
        return stem
      }
      let before: ReturnType<typeof chatCursor> | null = null
      for (;;) {
        const page: ReadonlyArray<Chat> = await run(reader.ListChats({ userId, limit: 200, before }))
        for (const chat of page) {
          if (!exportsAs(chat, "jsonl")) continue
          const forks = await run(reader.ListForks({ userId, chatId: chat.id }))
          const lead = forks.find((fork) => fork.current) ?? forks[0] ?? null
          if (lead === null) continue
          const family = await run(chatFiles(reader, userId, chat, forks, lead, "jsonl", avatars))
          if (family.voices.length !== 1 || !cardStems.has(family.voices[0]!)) {
            const stem = place("group chats/", family)
            groups.push({
              id: chat.id,
              name: chat.title,
              members: family.voices.flatMap((id) => (cardStems.has(id) ? [`${cardStems.get(id)}.png`] : [])),
              chats: [...family.stems(stem)],
              current: family.currentStem(stem)
            })
            yield* family.entries("group chats/", stem)
            continue
          }
          const voice = family.voices[0]
          const folder = `chats/${(voice && cardStems.get(voice)) || cardName(family.base, "Chats")}/`
          yield* family.entries(folder, place(folder, family))
        }
        if (page.length < 200) break
        before = chatCursor(page.at(-1)!)
      }
      for (const group of groups)
        yield {
          name: `groups/${group.id}.json`,
          chunks: once(
            encode({
              id: group.id,
              name: group.name,
              members: group.members,
              chats: group.chats,
              chat_id: group.current ?? group.chats[0]
            })
          )
        }
    }

    async function* entries(): AsyncGenerator<ZipStreamEntry> {
      yield* files(cards, "card-png", (ref) => `characters/${cardStems.get(ref.entityId)}.png`)
      yield* files(personas, "card-png", (ref) => `User Avatars/${personaStems.get(ref.entityId)}.png`)
      yield* files(lorebooks, "st-world-info", (ref) => `worlds/${worldStems.get(ref.id)}.json`)
      const presetName = namer()
      yield* files(presets, "st-preset", (ref) => `OpenAI Settings/${presetName(ref.label, "Preset")}.json`)
      yield* chats()
      // Personas as ST's settings name and describe them; nothing else of ST's settings.
      const descriptions: Record<string, { description: string; position: number; depth: number; role: number }> = {}
      for (const persona of personas) {
        const source = await run(Effect.option(reader.ExportSource({ userId, refId: persona.id })))
        const doc = source._tag === "Some" ? (JSON.parse(source.value.docJson) as { description?: unknown }) : {}
        descriptions[`${personaStems.get(persona.entityId)}.png`] = {
          description: typeof doc.description === "string" ? doc.description : "",
          position: 0,
          depth: 2,
          role: 0
        }
      }
      yield {
        name: "settings.json",
        chunks: once(
          encode({
            power_user: {
              personas: Object.fromEntries(personas.map((ref) => [`${personaStems.get(ref.entityId)}.png`, ref.label])),
              persona_descriptions: descriptions
            }
          })
        )
      }
      if (skipped.length > 0)
        yield {
          name: "Not exported.txt",
          chunks: once(new TextEncoder().encode(`These couldn't be exported:\n${skipped.join("\n")}\n`))
        }
    }

    return {
      counts: {
        cards: cards.length,
        personas: personas.length,
        lorebooks: lorebooks.length,
        presets: presets.length
      },
      entries
    }
  })
