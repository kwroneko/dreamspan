// What a panel's scripts may read (spec/HTML-MESSAGES.md §3.4 Tier B; shared/panelDataApi.ts):
// the path up to its own message, never after (memory: causal order), the chat's variables
// there and the names, as Tavern Helper's read calls give them. Reads only, composed from
// the reader's path, state and card reads: nothing here writes.
import { CurrentUser } from "@dreamspan/shared/api.ts"
import type { EntityId, PathEntry } from "@dreamspan/shared/chat.ts"
import { PANEL_TEXT, type PanelDataApi, type PanelMessage } from "@dreamspan/shared/panelDataApi.ts"
import { foldState } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import { Reader } from "../db/Database.ts"
import { internal } from "./internal.ts"

/** A template message's text as ST would have stored it: `{{char}}` and `{{user}}` resolved, as the chat export does. */
const storedText = (entry: PathEntry, speaker: string, user: string) =>
  entry.version.macroMode === "template"
    ? entry.version.content.replace(/\{\{char\}\}/gi, speaker).replace(/\{\{user\}\}/gi, user)
    : entry.version.content

/** The newest messages whose text fits `PANEL_TEXT` in all, ending with the last. */
export const fitText = (messages: ReadonlyArray<PanelMessage>): ReadonlyArray<PanelMessage> => {
  let total = 0
  let from = messages.length
  while (from > 0) {
    const length = messages[from - 1]!.message.length
    // The panel's own message always comes, whatever its length.
    if (from < messages.length && total + length > PANEL_TEXT) break
    total += length
    from--
  }
  return messages.slice(from)
}

export const makePanelDataHandlers = Effect.gen(function* () {
  const reader = yield* Reader
  return {
    GetPanelData: ({ chatId, forkId, slotId }) =>
      Effect.gen(function* () {
        const userId = (yield* CurrentUser).id
        const { entries, events } = yield* reader.PanelContext({ userId, chatId, forkId, slotId })
        const own = entries.at(-1)!
        const state = foldState(events)
        const speakerOf = (entry: PathEntry) => entry.version.speakerEntityId ?? entry.firstSpeakerEntityId
        const ids = new Set<EntityId>(state.playedByMe as Array<EntityId>)
        for (const entry of entries) {
          const id = speakerOf(entry)
          if (id !== null) ids.add(id)
        }
        for (const id of state.participants) ids.add(id as EntityId)
        const cards = new Map(
          (yield* reader.CastCards({ userId, entityIds: [...ids] })).map((card) => [card.entityId as string, card])
        )
        const persona = state.playedByMe.at(-1)
        const user = (persona === undefined ? undefined : cards.get(persona)?.name) || "User"
        const ownSpeaker = speakerOf(own)
        const character =
          (ownSpeaker !== null && !state.playedByMe.includes(ownSpeaker) && cards.get(ownSpeaker)?.persona !== true
            ? cards.get(ownSpeaker)?.name
            : undefined) ??
          state.participants
            .filter((id) => !state.playedByMe.includes(id))
            .map((id) => cards.get(id)?.name)
            .find((name) => name) ??
          ""
        const messages = entries.map((entry): PanelMessage => {
          const id = speakerOf(entry)
          const card = id === null ? undefined : cards.get(id)
          const isUser =
            id !== null ? state.playedByMe.includes(id) || card?.persona === true : entry.version.writer === "human"
          const name = card?.name ?? (isUser ? user : character)
          return {
            messageId: entry.position ?? entry.depth,
            name,
            role: isUser ? "user" : id === null && entry.version.writer !== "human" ? "system" : "assistant",
            hidden: entry.contextExcluded,
            message: storedText(entry, name, user)
          }
        })
        return {
          messageId: own.position ?? own.depth,
          messages: fitText(messages),
          chatVariables: { ...state.vars },
          names: { user, char: character }
        }
      }).pipe(internal("GetPanelData"))
  } satisfies Parameters<typeof PanelDataApi.of>[0]
})
