// The way back from a workshop to the story it's about (owner, 2026-11-17: "there's no way to go
// from Workshop -> branch or chat it is connected to *at all*"): a link under the workshop's
// header title, wherever it's shown as a chat, and the story's name beside its rows in the lists.
import type { Chat, ChatId } from "@rp/shared/chat.ts"
import type { WorkshopStory } from "@rp/shared/workshopApi.ts"
import { useAtomValue } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import { AsyncResult, Atom } from "effect/reactivity"
import { useCallback, type MouseEvent } from "react"
import { AppClient } from "../../rpc.ts"
import { Tooltip } from "../../ui/Tooltip.tsx"
import type { ChatView } from "../chat/session.ts"
import { useCanOpenBeside } from "../workbench/OpenBeside.tsx"
import { useWorkbench, useWorkbenchTab } from "../workbench/tab.tsx"
import { SIDE_CHATS_KEY } from "./sideChat.ts"

const storyOf = Atom.family((chatId: ChatId) =>
  AppClient.query("ListWorkshopStories", { chatIds: [chatId] }, { reactivityKeys: [SIDE_CHATS_KEY, "chats", chatId] })
)

/** The story a workshop is about: undefined while reading or for none, `title: null` once deleted. */
const useWorkshopStory = (chatId: ChatId): WorkshopStory | undefined => {
  const result = useAtomValue(storyOf(chatId))
  return AsyncResult.isSuccess(result) ? result.value[0] : undefined
}

/**
 * Opens a chat beside this one: focused where it's open already, else in the neighbouring pane
 * (split when there's none). A phone has one pane, so it opens there; Back comes back.
 */
export function useOpenBesideThis() {
  const workbench = useWorkbench()
  const tab = useWorkbenchTab()
  const navigate = useNavigate()
  const wide = useCanOpenBeside()
  const open = useCallback(
    (href: string) => {
      const frame = tab && workbench ? workbench.frameOf(tab.tabId) : undefined
      if (workbench && wide) workbench.openBesideOf(frame, href)
      else if (workbench) workbench.openIn(frame, href)
      else void navigate({ href })
    },
    [workbench, tab, navigate, wide]
  )
  return { open, wide }
}

const plainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

/** `chatHeaderAbout`: "About “Ledger”" under a workshop's title, opening the story. */
export function WorkshopStoryLink({ view }: { view: ChatView }) {
  return view.chat?.kind === "workshop" ? <StoryLink chatId={view.chat.id} /> : null
}

function StoryLink({ chatId }: { chatId: ChatId }) {
  const story = useWorkshopStory(chatId)
  const { open, wide } = useOpenBesideThis()
  if (!story) return null
  if (story.title === null)
    return (
      <span data-workshop-story="deleted" className="min-w-0 truncate text-xs text-muted">
        About a story that was deleted (deleted)
      </span>
    )
  const href = `/chats/${story.storyId}`
  return (
    <span className="flex min-w-0 shrink text-xs text-muted">
      <Tooltip
        label={
          wide
            ? "Opens the story this workshop talks about, beside it, or shows it where it's open."
            : "Opens the story this workshop talks about. Back returns here."
        }
        side="bottom"
      >
        <a
          href={href}
          data-workshop-story={story.storyId}
          className="min-w-0 truncate rounded-sm text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          onClick={(event) => {
            if (!plainClick(event)) return
            event.preventDefault()
            open(href)
          }}
        >
          About “{story.title}”
        </a>
      </Tooltip>
    </span>
  )
}

/** `chatRowAbout`: the story's name beside a workshop's row. */
export function WorkshopStoryName({ chat }: { chat: Pick<Chat, "id" | "kind"> }) {
  return chat.kind === "workshop" ? <StoryName chatId={chat.id} /> : null
}

function StoryName({ chatId }: { chatId: ChatId }) {
  const story = useWorkshopStory(chatId)
  if (!story) return null
  return (
    <span data-workshop-story-name className="min-w-0 shrink truncate text-xs text-muted">
      {story.title === null ? "about a deleted story" : `about “${story.title}”`}
    </span>
  )
}
