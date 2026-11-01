// The branches a "delete for good" affects (`BinItemBranches`, owner 2026-11-01): every one,
// named as the chat's branch list names it, marked as still showing the text or holding it only
// in the bin, each a link to that branch at that message, highlighted as a message link opens
// it. Links open in a new tab, so a plain click never loses the confirmation; the list scrolls
// inside the dialog, which never outgrows the screen, however many branches there are.
import type { BinBranch } from "@rp/shared/bin.ts"
import { Icon } from "../../ui/Icon.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { readableChatTitle } from "../chat/chatTitle.ts"
import { forkLabel } from "../chat/forks.ts"

/** The chat at that branch and message, as Copy link makes it, always naming the branch. */
const branchHref = (branch: BinBranch, slotId: string) => {
  const search = new URLSearchParams({ slot: slotId, fork: branch.forkId })
  return `/chats/${encodeURIComponent(branch.chatId)}?${search}`
}

const messageNumber = (position: number) => `message ${position + 1}`

/** What the entry says about where the text is in that branch, under its name. */
const where = (branch: BinBranch, withChat: boolean) => {
  const at = branch.position === null ? null : messageNumber(branch.position)
  const chat = withChat ? ` in “${readableChatTitle(branch.chatTitle)}”` : ""
  const ends = branch.tipExcerpt === "" ? null : `ends “${branch.tipExcerpt}”`
  const capital = (text: string) => text[0]!.toUpperCase() + text.slice(1)
  const parts = (() => {
    switch (branch.state) {
      case "shown":
        return [at === null ? null : `${capital(at)}${chat}`, ends]
      case "deletedHere": {
        const link = branch.link
        const opens =
          link === null || branch.position === null
            ? null
            : `opens at ${messageNumber(link.position)}, ${link.position < branch.position ? "above" : "below"} it`
        return [at === null ? `Deleted in this branch${chat}` : `${capital(at)}${chat}, deleted in this branch`, opens]
      }
      case "branchInBin":
        return [`The branch is in the bin${chat}`, ends]
      case "chatInBin":
        return [`The chat is in the bin${chat}`, ends]
    }
  })()
  return parts.filter((part) => part !== null).join(" · ")
}

function Entry({ branch, withChat }: { branch: BinBranch; withChat: boolean }) {
  const live = branch.state === "shown"
  const name = forkLabel(branch)
  const body = (
    <>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{name}</span>
        {branch.current && <span className="text-xs text-muted">current</span>}
        <Badge tone={live ? "warning" : "neutral"}>{live ? "Shows it" : "In the bin"}</Badge>
      </span>
      <span className="line-clamp-2 text-xs text-muted [overflow-wrap:anywhere]">{where(branch, withChat)}</span>
    </>
  )
  return (
    <li data-state={branch.state}>
      {branch.link === null ? (
        <div className="flex flex-col gap-0.5 px-2 py-1.5">{body}</div>
      ) : (
        <a
          href={branchHref(branch, branch.link.slotId)}
          target="_blank"
          rel="noopener"
          className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">{body}</span>
          <Icon name="external" size={14} className="mt-1 text-muted group-hover:text-accent" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      )}
    </li>
  )
}

export function AffectedBranches({ branches }: { branches: ReadonlyArray<BinBranch> }) {
  if (branches.length === 0) return null
  const forks = new Set(branches.map((branch) => branch.forkId)).size
  const showing = new Set(branches.filter((branch) => branch.state === "shown").map((branch) => branch.forkId))
  const held = forks - showing.size
  // Several items (emptying the bin): each entry says which chat.
  const withChat = new Set(branches.map((branch) => branch.itemId)).size > 1
  const linked = branches.some((branch) => branch.link !== null)
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  return (
    <section
      aria-label="Affected branches"
      className={`flex min-h-0 flex-col gap-2 rounded-md border p-3 text-sm ${showing.size > 0 ? "border-warning/60 bg-warning/10" : "border-border bg-surface-raised"}`}
    >
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">{plural(forks, "branch affected", "branches affected")}</p>
        <p className="text-muted">
          {[
            showing.size > 0 &&
              `${plural(showing.size, "still shows", "still show")} the text and ${showing.size === 1 ? "loses" : "lose"} it too.`,
            held > 0 && `${plural(held, "holds", "hold")} it only in the bin.`,
            linked && "Links open in a new tab."
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      </div>
      {/* Its own scroll: hundreds of branches (an ST import's) keep the buttons on screen. */}
      <ul
        aria-label={`Affected branches (${branches.length})`}
        tabIndex={0}
        className="-mx-2 flex max-h-[min(22rem,40dvh)] min-h-0 flex-col overflow-y-auto overscroll-contain"
      >
        {branches.map((branch) => (
          <Entry key={`${branch.itemId}/${branch.forkId}`} branch={branch} withChat={withChat} />
        ))}
      </ul>
    </section>
  )
}
