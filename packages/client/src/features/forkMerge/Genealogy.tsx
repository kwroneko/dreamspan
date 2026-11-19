// A preset's or lorebook's family (owner, 2026-11-01: "every parent and child would have a way
// to see the full genealogy tree with links to each of them you'd be able to click or open in
// new tabs"). Cards have theirs in the card's Forks (cardForks). Every member is a real link;
// one only for a chat, binned or gone isn't. Members with forks fold, for long trees on a phone.
import type { LibraryGenealogy } from "@dreamspan/shared/forkMerge.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { Link } from "@tanstack/react-router"
import { useContext, useMemo, useState } from "react"
import { AsyncView } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Dialog } from "../../ui/Dialog.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { PanelVariantNavigation } from "../editor/panelActions.tsx"

type Family = typeof LibraryGenealogy.Type
type Member = Family["members"][number]

const day = (at: number) => new Date(at).toLocaleDateString()

function MemberName({ member, onOpen }: { member: Member; onOpen: () => void }) {
  const select = useContext(PanelVariantNavigation)
  const name = `${member.label || "Deleted entry"}${member.subtitle ? ` · ${member.subtitle}` : ""}`
  const linked = member.refId !== null && (member.state === "live" || member.state === "archived")
  if (!linked) return <span className="text-sm [overflow-wrap:anywhere]">{name}</span>
  return (
    <Tooltip label="Opens this one for editing.">
      <Link
        to="/library/$refId"
        params={{ refId: member.refId! }}
        className="text-sm text-accent underline-offset-4 hover:underline [overflow-wrap:anywhere]"
        onClick={(event) => {
          // A plain click; a new tab or window keeps this open.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
          if (select) {
            event.preventDefault()
            select(member.refId!)
          }
          onOpen()
        }}
      >
        {name}
      </Link>
    </Tooltip>
  )
}

function Branch({
  family,
  member,
  current,
  onOpen,
  depth = 0
}: {
  family: Family
  member: Member
  current: RefId
  onOpen: () => void
  depth?: number
}) {
  const children = family.members.filter((m) => m.parentNodeId === member.nodeId && m.nodeId !== member.nodeId)
  const [open, setOpen] = useState(true)
  const line = [
    member.parentNodeId === null
      ? "Original"
      : member.forkedFromRevisionId === null
        ? "Marked as a fork by hand"
        : member.forkedAt !== null
          ? `Forked ${day(member.forkedAt)}`
          : "Fork",
    member.lastMergeAt !== null ? `last merged ${day(member.lastMergeAt)}` : null
  ]
    .filter((part) => part !== null)
    .join(" · ")
  const name = member.label || "this entry"
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1">
        {children.length > 0 ? (
          <IconButton
            label={open ? `Hide forks of ${name}` : `Show forks of ${name}`}
            hint={open ? `Click to hide the forks of ${name}` : `Click to show the forks of ${name}`}
            icon={open ? "down" : "right"}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          />
        ) : (
          <span aria-hidden className="size-8 shrink-0" />
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <MemberName member={member} onOpen={onOpen} />
            {member.refId === current && <Badge tone="accent">this one</Badge>}
            {member.state !== "live" && (
              <Badge>
                {member.state === "binned" ? "in the bin" : member.state === "purged" ? "deleted" : member.state}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted">{line}</p>
        </div>
      </div>
      {open && children.length > 0 && (
        <ul className={`flex min-w-0 flex-col gap-1 ${depth < 6 ? "ml-4 border-l border-border pl-2" : ""}`}>
          {children.map((child) => (
            <Branch
              key={child.nodeId}
              family={family}
              member={child}
              current={current}
              onOpen={onOpen}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export function GenealogyDialog({ refId, onClose }: { refId: RefId; onClose: () => void }) {
  const atom = useMemo(() => AppClient.query("LibraryGenealogy", { refId }, { reactivityKeys: ["library"] }), [refId])
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Family"
      description="Where this one was forked from and the forks made from it. Each is edited on its own."
    >
      <AsyncView atom={atom} loading="Reading the family…">
        {(family) => {
          const root = family.members.find((m) => m.nodeId === family.rootNodeId)
          return root ? (
            <ul aria-label="Family tree" className="flex min-w-0 flex-col gap-1">
              <Branch family={family} member={root} current={refId} onOpen={onClose} />
            </ul>
          ) : (
            <p className="text-sm text-muted">This family's original is gone.</p>
          )
        }}
      </AsyncView>
    </Dialog>
  )
}
