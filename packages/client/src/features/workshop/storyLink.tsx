// The way back from a workshop to the story it's about (owner, 2026-11-17: "there's no way to go
// from Workshop -> branch or chat it is connected to *at all*"): a link under the workshop's
// header title, wherever it's shown as a chat, and the story's name beside its rows in the lists.
import type { Chat, ChatId, ForkId } from "@rp/shared/chat.ts"
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
import { storyBranchName, useWorkshopBranches } from "./workshopBranches.tsx"

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

/**
 * `chatHeaderAbout`: "About “Ledger” · branch Tavern fight" under a workshop's title, opening the
 * story at the branch the shown workshop branch goes with (spec/WORKSHOP-BRANCHES.md §8.2).
 */
export function WorkshopStoryLink({ view }: { view: ChatView }) {
  return view.chat?.kind === "workshop" ? (
    <StoryLink chatId={view.chat.id} forkId={view.forkId ?? view.chat.currentForkId ?? null} />
  ) : null
}

function StoryLink({ chatId, forkId }: { chatId: ChatId; forkId: ForkId | null }) {
  const story = useWorkshopStory(chatId)
  const branches = useWorkshopBranches(chatId, forkId)
  const paired = branches?.find((branch) => branch.forkId === forkId)?.story ?? null
  const { open, wide } = useOpenBesideThis()
  if (!story) return null
  if (story.title === null)
    return (
      <span data-workshop-story="deleted" className="min-w-0 truncate text-xs text-muted">
        About a story that was deleted (deleted)
      </span>
    )
  const href = paired ? `/chats/${story.storyId}?fork=${paired.forkId}` : `/chats/${story.storyId}`
  return (
    <span className="flex min-w-0 shrink text-xs text-muted">
      <Tooltip
        label={
          wide
            ? "Opens the story this workshop talks about, at the branch this workshop branch goes with, beside it."
            : "Opens the story this workshop talks about, at the branch this workshop branch goes with. Back returns here."
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
          About “{story.title}”{paired ? ` · branch ${storyBranchName(paired)}` : ""}
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
