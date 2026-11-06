// The open chat, as notes that replace prompts need it (DESIGN §4.2; spec/NOTE-OVERRIDES.md §2):
// registered as a chat surface provider inside the editor workspace, so the card and preset
// editors over the chat, its side panel and its notes know which chat they're in. Outside a
// chat (the library's editors) there's none, and nothing here shows.
import { useAtomValue } from "@effect/atom-react"
import type { ChatId } from "@rp/shared/chat.ts"
import type { ChatNotePosition } from "@rp/shared/editorApi.ts"
import type { ChatNote } from "@rp/shared/chatSetupApi.ts"
import type { NoteReplacementView } from "@rp/shared/inspectorApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { PresetPrompt, PromptOrderEntry } from "@rp/shared/docs/preset.ts"
import { AsyncResult } from "effect/reactivity"
import { createContext, type ReactNode, useContext, useEffect, useMemo, useSyncExternalStore } from "react"
import { AppClient } from "../../rpc.ts"
import type { CastView } from "../chat/cast.ts"
import { useChatPreset } from "../chat/chatPreset.ts"
import type { ChatSurfaceProps } from "../chat/presentation.tsx"
import type { ChatSession, ChatView } from "../chat/session.ts"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import {
  type FieldTarget,
  NoteTargetsContext,
  noteTarget,
  replaceablePrompts,
  targetKey
} from "../editor/noteTargets.ts"
import { type EditorStore, STRUCTURE } from "../editor/store.ts"
import { libraryListAtom } from "../library/queries.ts"

export interface ReplaceChat {
  readonly session: ChatSession
  readonly view: ChatView
  readonly cast: CastView
  /** Where a note of the chat's own is edited: the branch shown, at its latest message. */
  readonly position: ChatNotePosition
  /** The preset the next reply is built with; undefined for the built-in one. */
  readonly presetRef: RefId | undefined
  /** The preset's store in the editor workspace, loaded on first need. */
  readonly presetStore: () => EditorStore | null
}

const Context = createContext<ReplaceChat | null>(null)
export const useReplaceChat = () => useContext(Context)

/** Whether a replacement is sent this chat (or would be, on the turns its condition holds). */
const shown = (r: NoteReplacementView) =>
  r.status === "replaced" || r.status === "own_position" || r.status === "not_due"

const sameTarget = (a: FieldTarget, b: FieldTarget) => targetKey(a) === targetKey(b)

/** The note that replaces `target` in the open chat, as the next reply's assembly found it. */
export const useReplacement = (target: FieldTarget | null) => {
  const workspace = usePresetWorkspace()
  const found = workspace?.context?.replacements?.find(
    (r) => target !== null && sameTarget(r.target, target) && shown(r)
  )
  return found ?? null
}

/** A store's value, read again whenever it changes; `null` store reads nothing. */
const useStoreValue = (store: EditorStore | null, path: ReadonlyArray<string>) =>
  useSyncExternalStore(
    (listener) => (store ? store.subscribe(STRUCTURE)(listener) : () => {}),
    () => (store?.snapshot ? store.value(path) : undefined)
  )

/** The preset's prompts a note can replace, loading its store once something asks. */
export const usePresetPrompts = (chat: ReplaceChat | null, load: boolean) => {
  const store = chat?.presetStore() ?? null
  useEffect(() => {
    if (load && store && store.snapshot === null) void store.load()
  }, [load, store])
  const prompts = useStoreValue(store, ["prompts"]) as ReadonlyArray<PresetPrompt> | undefined
  const order = useStoreValue(store, ["order"]) as ReadonlyArray<PromptOrderEntry> | undefined
  return useMemo(() => (prompts && order ? replaceablePrompts(prompts, order) : null), [prompts, order])
}

/** The chat's notes at the latest message of the branch shown, as the Notes tab lists them. */
export const useChatNotes = (chat: ReplaceChat | null): ReadonlyArray<ChatNote> | null => {
  const chatId = chat?.session.id ?? ("" as ChatId)
  const forkId = chat?.view.forkId ?? null
  const slotId = chat?.view.leafSlotId ?? null
  const atom = useMemo(
    () =>
      AppClient.query(
        "ListChatNotes",
        { chatId, forkId, slotId },
        { reactivityKeys: ["library", `chat-notes:${chatId}`] }
      ),
    [chatId, forkId, slotId]
  )
  const result = useAtomValue(atom)
  return chat && AsyncResult.isSuccess(result) ? result.value : null
}

const cardRefs = libraryListAtom("card")

/** A card's library entry by its entity. */
export const useCardRef = () => {
  const refs = useAtomValue(cardRefs)
  return (entity: string) =>
    AsyncResult.isSuccess(refs)
      ? (refs.value.find((ref) => ref.entityId === entity)?.id as RefId | undefined)
      : undefined
}

/** The other notes of this chat that replace `target` (one note per target, DESIGN §4.2). */
export const otherReplacing = (notes: ReadonlyArray<ChatNote> | null, target: FieldTarget, except?: string) =>
  (notes ?? []).filter((note) => {
    if (note.ref.id === except) return false
    const theirs = noteTarget(note.doc)
    return theirs !== null && sameTarget(theirs, target)
  })

/** The provider, registered in the chat's surface providers inside its editor workspace. */
export function ReplaceChatProvider({ session, view, cast, children }: ChatSurfaceProps & { children: ReactNode }) {
  const workspace = usePresetWorkspace()
  const { ref: presetRef } = useChatPreset(session, view)
  const value = useMemo<ReplaceChat>(
    () => ({
      session,
      view,
      cast,
      position: { chatId: session.id, forkId: view.forkId, slotId: view.leafSlotId },
      presetRef,
      presetStore: () => (presetRef && workspace ? workspace.store(presetRef) : null)
    }),
    [session, view, cast, presetRef, workspace]
  )
  return (
    <Context value={value}>
      <TargetNames chat={value}>{children}</TargetNames>
    </Context>
  )
}

/** The names the notes' headers say targets with: the cast's cards, the preset's prompts once read. */
function TargetNames({ chat, children }: { chat: ReplaceChat; children: ReactNode }) {
  const prompts = usePresetPrompts(chat, false)
  const names = useMemo(
    () => ({
      card: (entity: string) => chat.cast.cards.get(entity)?.name,
      prompt: (identifier: string) => prompts?.find((p) => p.identifier === identifier)?.name
    }),
    [chat.cast, prompts]
  )
  return <NoteTargetsContext value={names}>{children}</NoteTargetsContext>
}
