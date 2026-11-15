// A bounded, disposable trie of exact messages written to new chats in this run.
// Never a source of truth: edits, reimports and other writer operations discard it.
import type { EntityId, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import type { StMessage } from "../formats/stChat.ts"

const MAX_MESSAGES = 100_000
const MAX_CHATS = 1000

export const makeStImportPrefix = () => {
  const chats = new Set<string>()
  const families = new Map<string, Map<string, SlotId>>()
  let size = 0
  const clear = () => {
    chats.clear()
    families.clear()
    size = 0
  }
  const key = (
    parent: string | null,
    hash: string,
    message: StMessage,
    speakers: Readonly<Record<string, EntityId | null>>
  ) => JSON.stringify([parent, hash, message.speaker === null ? null : (speakers[message.speaker] ?? null)])
  return {
    clear,
    fresh: (chat: string) => chats.has(chat),
    created: (chat: string) => {
      if (chats.size >= MAX_CHATS) clear()
      chats.add(chat)
    },
    forget: (chat: string) => {
      chats.delete(chat)
      size -= families.get(chat)?.size ?? 0
      families.delete(chat)
    },
    match: (
      chat: string,
      parent: string | null,
      messages: ReadonlyArray<StMessage>,
      hashes: ReadonlyArray<string> | undefined,
      speakers: Readonly<Record<string, EntityId | null>>
    ) => {
      const slots: Array<SlotId> = []
      if (!chats.has(chat) || hashes?.length !== messages.length) return slots
      const edges = families.get(chat)
      if (edges === undefined) return slots
      // Keep the current family's index while evicting older families first.
      families.delete(chat)
      families.set(chat, edges)
      for (const [i, message] of messages.entries()) {
        const slot = edges.get(key(parent, hashes[i]!, message, speakers))
        if (slot === undefined) break
        slots.push(slot)
        parent = slot
      }
      return slots
    },
    remember: (
      chat: string,
      parent: string | null,
      messages: ReadonlyArray<StMessage>,
      hashes: ReadonlyArray<string> | undefined,
      speakers: Readonly<Record<string, EntityId | null>>,
      slots: ReadonlyArray<SlotId>
    ) => {
      if (!chats.has(chat) || hashes?.length !== messages.length) return
      const edges = families.get(chat) ?? new Map<string, SlotId>()
      families.delete(chat)
      families.set(chat, edges)
      for (const [i, message] of messages.entries()) {
        const identity = key(parent, hashes[i]!, message, speakers)
        if (!edges.has(identity)) size++
        edges.set(identity, slots[i]!)
        parent = slots[i]!
      }
      while (size > MAX_MESSAGES) {
        const oldest = families.keys().next().value!
        size -= families.get(oldest)!.size
        families.delete(oldest)
      }
    }
  }
}

export type StImportPrefix = ReturnType<typeof makeStImportPrefix>

/** These operations preserve cached message identity and fork selections. New
 * suffixes are published by StImportMessages only after its transaction commits.
 */
const PRESERVES_PREFIX = new Set([
  "Ready",
  // Sidebar reads can store their summaries while an import is in progress.
  "StoreForkSummaries",
  // The summary pool keeps polling after its last job finishes; these touch jobs,
  // rollouts and backfill caps, never message identity or fork selections.
  "ReconcileSummaryJobs",
  "ClaimSummaryJob",
  "StImportStartChat",
  "StImportMessages",
  "StImportFinishChat",
  // Holds a confirmed re-import's batches; the chat isn't touched until StImportCommitChat,
  // which isn't here: it writes without the trie.
  "StImportStage",
  "StImportJobUpdate",
  "StImportJobReport",
  "StImportJobSeen"
])

export const stImportPrefixHandlers = <A extends object>(handlers: A, prefix: StImportPrefix): A => {
  type Call = (...args: Array<unknown>) => Effect.Effect<unknown, unknown>
  return Object.fromEntries(
    Object.entries(handlers).map(([tag, call]) => [
      tag,
      (...args: Array<unknown>) =>
        Effect.suspend(() => {
          if (!PRESERVES_PREFIX.has(tag)) prefix.clear()
          return (call as Call)(...args)
        })
    ])
  ) as A
}
