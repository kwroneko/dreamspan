// A workshop's branches and the story branch each goes with (spec/WORKSHOP-BRANCHES.md §8): the
// server's stored pairing (`ListWorkshopBranches`), so every device names the same. Read by the
// side panel (which shows the shown story branch's workshop branches only), the header link
// back to the story, and the branch list in the workshop's own pane, which names each branch's
// story branch.
import type { ChatId, ForkId } from "@dreamspan/shared/chat.ts"
import { forkLabel } from "@dreamspan/shared/branchNaming.ts"
import type { WorkshopBranch, WorkshopStory } from "@dreamspan/shared/workshopApi.ts"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/reactivity"
import { useEffect, useRef } from "react"
import { AppClient } from "../../rpc.ts"
import { Tooltip } from "../../ui/Tooltip.tsx"
import type { BranchRowNoteProps } from "../chat/branchParts.ts"
import { SIDE_CHATS_KEY } from "./sideChat.ts"

const branchesOf = Atom.family((chatId: ChatId) =>
  AppClient.query("ListWorkshopBranches", { chatId }, { reactivityKeys: [SIDE_CHATS_KEY, chatId] })
)
const storyOf = Atom.family((chatId: ChatId) =>
  AppClient.query("ListWorkshopStories", { chatIds: [chatId] }, { reactivityKeys: [SIDE_CHATS_KEY, "chats", chatId] })
)

/** The story a workshop is about: undefined while reading or for none, `title: null` once deleted. */
export const useWorkshopStory = (chatId: ChatId): WorkshopStory | undefined => {
  const result = useAtomValue(storyOf(chatId))
  return AsyncResult.isSuccess(result) ? result.value[0] : undefined
}

/** The name of the story branch a workshop branch goes with, as the story's own list names it. */
export const storyBranchName = (story: NonNullable<WorkshopBranch["story"]>) =>
  forkLabel({ name: story.name, original: story.original, createdAt: story.createdAt })

/**
 * The workshop's live branches, last chatted in first; null while first read. A fork the list
 * or story pairing it doesn't have yet has it read again, once per expected branch.
 */
export const useWorkshopBranches = (chatId: ChatId, expect: ForkId | null, kind: "workshop" | "story" = "workshop") => {
  const atom = branchesOf(chatId)
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  const list = AsyncResult.isSuccess(result) ? result.value : null
  const asked = useRef<string | null>(null)
  const missing =
    list !== null &&
    expect !== null &&
    !list.some((branch) => (kind === "story" ? branch.story?.forkId : branch.forkId) === expect)
  useEffect(() => {
    if (!missing) {
      asked.current = null
      return
    }
    if (asked.current === expect || result.waiting) return
    asked.current = expect
    refresh()
  }, [missing, expect, refresh, result.waiting])
  return list
}

/** The workshop's branches that go with story branch `storyFork`, last chatted in first. */
export const pairedWith = (branches: ReadonlyArray<WorkshopBranch>, storyFork: ForkId | null) =>
  branches.filter((branch) => branch.story !== null && branch.story.forkId === storyFork)

/** `branchControlParts` RowNote: under a workshop branch's name, the story branch it goes with. */
export function WorkshopBranchNote({ view, fork }: BranchRowNoteProps) {
  return view.chat?.kind === "workshop" ? <StoryBranchLine chatId={view.chat.id} forkId={fork.id} /> : null
}

function StoryBranchLine({ chatId, forkId }: { chatId: ChatId; forkId: ForkId }) {
  const attached = useWorkshopStory(chatId)
  const branches = useWorkshopBranches(chatId, forkId)
  const story = branches?.find((branch) => branch.forkId === forkId)?.story
  if (attached === undefined || story === undefined) return null
  return (
    <Tooltip label="Each branch of this workshop goes with one branch of the story.">
      <span
        data-workshop-story-branch
        data-layout-name
        tabIndex={0}
        className="block truncate rounded-sm text-xs text-muted outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {story === null ? "Its story branch was deleted" : `For the story’s “${storyBranchName(story)}”`}
      </span>
    </Tooltip>
  )
}
