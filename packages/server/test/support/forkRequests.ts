// The request each fork of each chat would send next: a model turn appended at the fork's tip
// and assembled at a fixed clock, as a generation would. Keyed by chat title and the fork's
// place among the chat's forks by creation, so two databases of the same import compare.
import { NewVersion, type ChatId, type ForkId, type SlotId } from "@dreamspan/shared/chat.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../../src/db/Database.ts"
import { client } from "./config.ts"

export interface RequestMessage {
  readonly role: string
  readonly content: unknown
}

export const forkRequests = Effect.gen(function* () {
  const api = yield* client()
  const reader = yield* Reader
  const writer = yield* Writer
  const userId = (yield* api.Whoami()).id
  const chats = yield* api.ListChats({ limit: 50, before: null })
  const out: Record<string, ReadonlyArray<RequestMessage>> = {}
  for (const chat of chats.toSorted((a, b) => a.title.localeCompare(b.title))) {
    const forks = (yield* api.ListForks({ chatId: chat.id })).toSorted(
      (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)
    )
    for (const [index, fork] of forks.entries()) {
      if (fork.tipSlotId === null) continue
      const target = yield* writer.AppendMessage({
        userId,
        chatId: chat.id as ChatId,
        forkId: fork.id as ForkId,
        parentSlotId: fork.tipSlotId as SlotId,
        branch: true,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "model",
          content: "",
          status: "generating",
          macroMode: "verbatim",
          origin: "generated"
        }),
        commitDraft: null
      })
      const { snapshot } = yield* reader.AssembleContext({
        userId,
        chatId: chat.id as ChatId,
        slotId: target.slotId,
        versionId: target.version.id,
        forkId: fork.id as ForkId,
        now: 0,
        timeZone: "UTC",
        frozen: null
      })
      out[`${chat.title} #${index}`] = (
        JSON.parse(snapshot) as { request: { messages: ReadonlyArray<RequestMessage> } }
      ).request.messages.map(({ role, content }) => ({ role, content }))
    }
  }
  return out
})

/** Turns lore "only below the history" off in every fork of each chat but those `except` names. */
export const loreWherePlaced = (except: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const api = yield* client()
    for (const chat of yield* api.ListChats({ limit: 50, before: null })) {
      if (except.some((part) => chat.title.includes(part))) continue
      for (const fork of yield* api.ListForks({ chatId: chat.id }))
        yield* api.ChangeCast({
          chatId: chat.id,
          forkId: fork.id,
          slotId: null,
          change: { _tag: "LoreBelowHistory", on: false }
        })
    }
  })
