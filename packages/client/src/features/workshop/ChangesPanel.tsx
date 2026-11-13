// The workshop's Changes tab (spec/WORKSHOP.md §2.5, §3.6): everything its runs changed outside the
// chat, newest first, grouped by the reply that made them, each change with Undo and Open and each
// reply with "Undo all of this reply". Read in pages of 50 (`ListRolloutEffects`): the first again
// whenever a change is undone anywhere or the newest reply settles.
import type { ChatId } from "@rp/shared/chat.ts"
import type { UndoAllReport } from "@rp/shared/workshopApi.ts"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/reactivity"
import { useEffect, useRef, useState } from "react"
import { useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { AppClient } from "../../rpc.ts"
import type { PanelProps } from "../chat/panels.tsx"
import { EffectRow } from "./EffectRow.tsx"
import {
  EFFECTS_KEY,
  effectId,
  groupByReply,
  type ReplyChanges,
  type RolloutEffect,
  undoAllOffered
} from "./effects.ts"

const PAGE = 50

const firstPage = Atom.family((chatId: ChatId) =>
  AppClient.query("ListRolloutEffects", { chatId, limit: PAGE }, { reactivityKeys: [EFFECTS_KEY, chatId] })
)

export function ChangesPanel({ session, view, active }: PanelProps) {
  const atom = firstPage(session.id)
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  const [older, setOlder] = useState<{ for: unknown; rows: ReadonlyArray<RolloutEffect>; more: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // A reply settling is what adds a row: read again when the newest one's status changes.
  const last = view.entries.at(-1)?.version
  const settled = `${last?.id ?? ""}:${last?.status ?? ""}`
  const seen = useRef(settled)
  useEffect(() => {
    if (!active || seen.current === settled) return
    seen.current = settled
    refresh()
  }, [active, settled, refresh])

  if (AsyncResult.isFailure(result))
    return (
      <p role="alert" className="text-sm text-danger">
        The changes couldn’t be read.
      </p>
    )
  if (!AsyncResult.isSuccess(result)) return <p className="text-sm text-muted">Loading the changes…</p>
  const first = result.value
  // Older pages hold only while the first page they followed is current.
  const extra = older?.for === first ? older : null
  const rows = [...first, ...(extra?.rows ?? [])]
  const more = extra ? extra.more : first.length === PAGE
  const showOlder = async () => {
    const tail = rows.at(-1)
    if (!tail) return
    setLoading(true)
    const next = await session.call((client) =>
      client("ListRolloutEffects", {
        chatId: session.id,
        limit: PAGE,
        before: { createdAt: tail.createdAt, rolloutId: tail.rolloutId, toolCallId: tail.toolCallId, seq: tail.seq }
      })
    )
    setLoading(false)
    if (next.ok) {
      setOlder({ for: first, rows: [...(extra?.rows ?? []), ...next.value], more: next.value.length === PAGE })
      setError(null)
    } else setError(`The older changes couldn't be read: ${next.error.message}`)
  }
  return (
    <div className="flex flex-col gap-3" data-changes-panel="">
      <p className="text-sm text-muted">What the assistant changed outside this chat, by reply, newest first.</p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nothing yet. Cards it makes or edits and chats it starts show here.</p>
      ) : (
        <ol className="flex flex-col gap-3" aria-label="Changes">
          {groupByReply(rows).map((group) => (
            <ReplyGroup key={group.rolloutId} chatId={session.id} group={group} />
          ))}
        </ol>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {more && (
        <Button
          className="self-start"
          pending={loading}
          hint="Shows the next 50, older ones."
          onClick={() => void showOlder()}
        >
          Show older
        </Button>
      )}
    </div>
  )
}

/** One reply's changes: when, how many, Undo all, then each change with its own Undo and Open. */
function ReplyGroup({ chatId, group }: { chatId: ChatId; group: ReplyChanges }) {
  const action = useAction()
  const [report, setReport] = useState<UndoAllReport | null>(null)
  const count = group.effects.length
  const when = new Date(group.startedAt).toLocaleString()
  const undoAll = async () => {
    const result = await action.run(
      (client) => client("UndoRolloutEffects", { chatId, rolloutId: group.rolloutId }),
      [EFFECTS_KEY, "library", "chats", "chat-lists", "bin"]
    )
    if (result.ok) setReport(result.value)
  }
  return (
    <li
      data-reply-changes={group.rolloutId}
      aria-label={`Reply of ${when}`}
      className="flex flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-medium">Reply of {when}</span>
        <span className="text-muted">{count === 1 ? "1 change" : `${count} changes`}</span>
        {undoAllOffered(group) && (
          <Button
            variant="ghost"
            className="ml-auto h-7 px-2 text-xs"
            pending={action.pending}
            hint="Takes back everything this reply changed, newest first. It stops at a change that can’t be undone."
            onClick={() => void undoAll()}
          >
            Undo all of this reply
          </Button>
        )}
      </div>
      {report && <UndoAllOutcome report={report} />}
      {action.error && (
        <p role="alert" className="text-xs text-danger [overflow-wrap:anywhere]">
          Not undone: {action.error.message}
        </p>
      )}
      <ul className="flex flex-col gap-2" aria-label="Changes of this reply">
        {group.effects.map((effect) => (
          <li key={effectId(effect)} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
            <EffectRow effect={effect} />
          </li>
        ))}
      </ul>
    </li>
  )
}

const undidText = (n: number) => (n === 1 ? "Undid 1 change." : `Undid ${n} changes.`)

/** What "Undo all of this reply" did, and what it couldn't. */
function UndoAllOutcome({ report }: { report: UndoAllReport }) {
  const undone = report.undone.length
  if (report.refused === null)
    return (
      <p role="status" className="text-xs text-muted" data-undo-all-report="">
        {undone === 0 ? "Nothing left to undo." : undidText(undone)}
      </p>
    )
  return (
    <div role="alert" className="flex flex-col gap-1 text-xs [overflow-wrap:anywhere]" data-undo-all-report="">
      {undone > 0 && <p className="text-muted">{undidText(undone)}</p>}
      <p className="text-danger">
        Not undone: {report.refused.effect.title}. {report.refused.reason}
      </p>
      {report.left.length > 0 && (
        <p className="text-muted">
          Left as {report.left.length === 1 ? "it is" : "they are"}, since a newer change couldn’t be undone:{" "}
          {report.left.map((e) => e.title).join("; ")}.
        </p>
      )}
    </div>
  )
}
