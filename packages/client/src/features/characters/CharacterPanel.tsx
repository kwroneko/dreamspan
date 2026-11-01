import { useAtomValue } from "@effect/atom-react"
import type { EntityId } from "@rp/shared/chat.ts"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useMemo, type ReactNode } from "react"
import { AsyncView } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { Definition } from "./CardPage.tsx"
import { shellAtom, sidebarCleared } from "./shellData.tsx"

const refsAtom = AppClient.query("ListLibrary", { kind: "card" }, { reactivityKeys: ["library"] })

/** "Notes (N)": the card's notes, opening the chat's Notes tab at the card's group. */
function NotesLine({ refId, onOpen }: { refId: string; onOpen: () => void }) {
  const atom = useMemo(
    () => AppClient.query("ListCardNotes", { cardRefId: refId as never }, { reactivityKeys: ["library"] }),
    [refId]
  )
  const notes = useAtomValue(atom)
  return (
    <Button variant="ghost" onClick={onOpen} className="justify-start">
      Notes{AsyncResult.isSuccess(notes) ? ` (${notes.value.length})` : ""}
    </Button>
  )
}

/** A card's details; in a chat's panel, `onNotes` opens the chat's notes at the card's. */
export function CharacterPanel({
  entityId,
  onNotes,
  actions
}: {
  entityId: EntityId
  onNotes?: () => void
  actions?: ReactNode
}) {
  const data = useAtomValue(shellAtom)
  const refs = useAtomValue(refsAtom)
  const card = AsyncResult.isSuccess(data)
    ? data.value.cards.find((c) => c.card.entityId === entityId)?.card
    : undefined
  const ref =
    card?.refId ?? (AsyncResult.isSuccess(refs) ? refs.value.find((r) => r.entityId === entityId)?.id : undefined)
  const revision =
    card?.headRevisionId ??
    (AsyncResult.isSuccess(refs) ? refs.value.find((r) => r.id === ref)?.headRevisionId : undefined)
  const atom = useMemo(
    () =>
      ref && revision
        ? AppClient.query("GetRevision", { refId: ref, revisionId: revision }, { reactivityKeys: ["library"] })
        : null,
    [ref, revision]
  )
  const variants = AsyncResult.isSuccess(refs) ? refs.value.filter((r) => r.entityId === entityId && r.id !== ref) : []
  if (!ref || !atom) return <p className="text-sm text-muted">Loading the card…</p>
  return (
    <div className="flex flex-col gap-4">
      {card && (
        <header className="flex items-start gap-3">
          <Avatar id={entityId} name={card.name} mediaId={card.avatarMediaId} size="xl" />
          <div>
            <h2 className="text-lg font-semibold">{card.label}</h2>
            <p className="text-sm text-muted">{card.subtitle}</p>
          </div>
        </header>
      )}
      <Tooltip label="Opens a new chat at their greeting. Nothing is saved until you send.">
        <Link
          to="/cards/$entityId/chat"
          params={{ entityId }}
          search={{ ...sidebarCleared, character: entityId, panel: `card:${entityId}` }}
          className={buttonClass("primary")}
        >
          New chat
        </Link>
      </Tooltip>
      {actions ?? (
        <Link to="/library/$refId" params={{ refId: ref }} className={buttonClass()}>
          Edit card
        </Link>
      )}
      {onNotes && <NotesLine refId={ref} onOpen={onNotes} />}
      <AsyncView atom={atom} loading="Loading the definition…">
        {(doc) => <Definition doc={doc} />}
      </AsyncView>
      {variants.length > 0 && (
        <section aria-label="Card forks">
          <h3 className="font-medium">Card forks</h3>
          {variants.map((r) => (
            <Link key={r.id} to="/library/$refId" params={{ refId: r.id }} className="block text-sm text-accent">
              {r.label}
              {r.subtitle ? ` · ${r.subtitle}` : ""}
            </Link>
          ))}
        </section>
      )}
    </div>
  )
}
