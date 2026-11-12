// The workshop's Changes tab (spec/WORKSHOP.md §2.5, §3.6): everything its runs changed outside the
// chat, newest first, each with when, Undo and Open. Read in pages of 50 (`ListRolloutEffects`):
// the first again whenever a change is undone anywhere or the newest reply settles.
import type { ChatId } from "@rp/shared/chat.ts"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/reactivity"
import { useEffect, useRef, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { AppClient } from "../../rpc.ts"
import type { PanelProps } from "../chat/panels.tsx"
import { EffectRow } from "./EffectRow.tsx"
import { EFFECTS_KEY, effectId, type RolloutEffect } from "./effects.ts"

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
      <p className="text-sm text-muted">What the assistant changed outside this chat, newest first.</p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nothing yet. Cards it makes or edits and chats it starts show here.</p>
      ) : (
        <ol className="flex flex-col gap-2" aria-label="Changes">
          {rows.map((effect) => (
            <li key={effectId(effect)} className="rounded-md border border-border bg-surface px-3 py-2">
              <EffectRow effect={effect} when />
            </li>
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
