// A workshop beside a story not made yet (its Workshop tab with none, or New workshop): a pending
// chat like every new chat (DraftChatPage.tsx, `OpenDraftChat` with `side:<story>:<fork>`), shown
// in the tab as a saved one is, so its first send starts it in place and nothing moves. The tab's
// URL keeps its id (`side.draft`), so a reload reopens the same one; leaving the tab leaves it,
// and the server sweeps it (its typing to recovered texts).
import type { Chat, ChatId, ForkId } from "@dreamspan/shared/chat.ts"
import { type ComponentType, type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { type ActionResult, ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { useCaller } from "../editor/caller.ts"
import { chatPlaceKey } from "../chat/chatPlace.ts"
import { forgetSideDraft, rememberDraftFor, reopenSweptDraft } from "../chat/chatStarted.ts"
import { carryLeftover, fileLeftover } from "../chat/composerDraft.ts"
import { SkeletonMessages } from "../chat/SkeletonMessages.tsx"
import { sideDraftFor, SIDE_CHAT_SCOPE } from "./sideChat.ts"

/** What the side chat's surface tells its pending chat's host. */
export interface SideDraftHost {
  /** Its first turn started it. */
  readonly onStarted: (chat: Chat) => void
  /** Swept while shown: another opens in its place. */
  readonly onDeleted: () => void
}

/** One open per tab and attempt, even when React runs the effect twice. */
const opening = new Map<string, Promise<ActionResult<Chat>>>()

export function PendingSideDraft({
  story,
  storyFork,
  header,
  onCreated,
  onGone,
  Surface
}: {
  story: ChatId
  /** The story branch shown: the workshop's first branch goes with it. */
  storyFork: ForkId | null
  /** The tab's header, for the workshop once it's open (null before). */
  header: (chat: Chat | null) => ReactNode
  onCreated: (chat: Chat) => void
  onGone: () => void
  /** The tab's chat surface for a chat, as for a saved one. */
  Surface: ComponentType<{
    chat: Chat
    draft: SideDraftHost
    storyFork: ForkId | null
    header: ReactNode
    onGone: () => void
  }>
}) {
  const draftFor = sideDraftFor(story, storyFork)
  const [named, setNamed] = usePlaceParam(chatPlaceKey(SIDE_CHAT_SCOPE, "draft"), "")
  const action = useAction()
  const call = useCaller()
  const [chat, setChat] = useState<Chat | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [reopen, setReopen] = useState(() => reopenSweptDraft(draftFor, named === "" ? null : (named as ChatId)))
  const started = useRef(false)
  const replacing = useRef(false)
  const shownId = useRef<ChatId | null>(null)
  useEffect(() => {
    shownId.current = chat?.id ?? null
  }, [chat])
  useEffect(() => {
    let live = true
    const key = `${draftFor}:${reopen ?? ""}:${attempt}`
    const run =
      opening.get(key) ??
      action.run((client) => client("OpenDraftChat", { draftFor, ...(reopen === null ? {} : { reopen }) }))
    opening.set(key, run)
    void run.then((opened) => {
      opening.delete(key)
      if (!live) return
      if (!opened.ok) {
        if (replacing.current) setChat(null)
        return
      }
      const value = opened.value
      if (replacing.current && shownId.current !== null) carryLeftover(shownId.current, value.id)
      replacing.current = false
      // Started meanwhile (in another browser tab): the tab shows it as any other.
      if (value.status !== "pending") {
        started.current = true
        if (reopen !== null) forgetSideDraft(draftFor, reopen)
        onCreated(value)
        return
      }
      rememberDraftFor(value.id, draftFor)
      setChat(value)
      if (value.id !== named) setNamed(value.id, true)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per entry and attempt
  }, [draftFor, reopen, attempt])
  // Leaving the tab leaves its chat: the server sweeps it unless another tab has it open.
  const chatId = chat?.id ?? null
  useEffect(() => {
    if (chatId === null) return
    return () => {
      if (!started.current) void call((client) => client("LeaveDraftChat", { chatId }))
      fileLeftover(chatId, (save) => call((client) => client("SaveComposer", save)))
    }
  }, [chatId, call])
  const host = useMemo<SideDraftHost>(
    () => ({
      onStarted: (made) => {
        if (started.current) return
        started.current = true
        forgetSideDraft(draftFor, made.id)
        onCreated(made)
      },
      onDeleted: () => {
        if (started.current) return
        replacing.current = true
        setReopen(reopenSweptDraft(draftFor, shownId.current))
        setAttempt((n) => n + 1)
      }
    }),
    [draftFor, onCreated]
  )
  if (chat !== null)
    return (
      <Surface key={chat.id} chat={chat} draft={host} storyFork={storyFork} header={header(chat)} onGone={onGone} />
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header(null)}
      {action.error ? (
        <div className="px-3 pt-2">
          <ErrorAlert
            error={action.error}
            actions={
              <Button
                hint="Retries opening the new workshop."
                variant="ghost"
                onClick={() => {
                  action.clearError()
                  setAttempt((n) => n + 1)
                }}
              >
                Try again
              </Button>
            }
          />
        </div>
      ) : (
        <SkeletonMessages onRetry={() => setAttempt((n) => n + 1)} />
      )}
    </div>
  )
}
