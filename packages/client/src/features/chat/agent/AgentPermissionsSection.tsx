// The "This chat" tab's Model may change (spec/AGENTIC.md §4.3): what agent replies may change in
// this chat, each of its notes and each card field a checkbox, written as `agent.permission` at
// the leaf shown, so it follows the branch and applies from the next reply. A box starts as the
// note's own setting ("The agent may edit it") or the card's (its Model may change list) says.
// Shown with the Tools list, for a mode that uses tools.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { AgentPermissions } from "@rp/shared/agentApi.ts"
import type { CastChange } from "@rp/shared/chatSetupApi.ts"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useMemo, useState, useSyncExternalStore } from "react"
import { AppClient } from "../../../rpc.ts"
import { Checkbox } from "../../../ui/Choice.tsx"
import { Fieldset } from "../../../ui/Field.tsx"
import { CARD_FIELD_LABELS } from "../../editor/noteTargets.ts"
import type { ChatSession } from "../session.ts"
import { PLAIN, useReplyModes } from "./replyModes.ts"

type Target = Extract<CastChange, { readonly _tag: "AgentPermission" }>["target"]

/** The tools that change notes, and the one that changes card fields. */
const NOTE_TOOLS = ["edit_note", "switch_note"]
const CARD_TOOL = "edit_card"

/** "Click to …" for a box (owner, 2026-11-03: a toggle says what clicking does). */
const clickTo = (on: boolean, what: string) =>
  on ? `Click to stop the model changing ${what} in this chat.` : `Click to let the model change ${what} in this chat.`

export function AgentPermissionsSection({ session }: { session: ChatSession }) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const { modes } = useReplyModes(session)
  const mode = modes?.modes.find((m) => m.id === (view.cast?.replyMode ?? PLAIN))
  if (!modes || !mode?.agentic || view.cast === null) return null
  const tools = view.cast.agentTools ?? mode.tools
  const offered = (ids: ReadonlyArray<string>) => ids.some((id) => tools.includes(id))
  const cardTool = modes.tools.find((t) => t.id === CARD_TOOL)
  return (
    <Permissions
      session={session}
      forkId={view.forkId}
      leafSlotId={view.leafSlotId}
      notesOff={offered(NOTE_TOOLS) ? null : "Tick a tool that changes notes under Tools first."}
      cardsOff={
        offered([CARD_TOOL])
          ? null
          : cardTool
            ? `Tick “${cardTool.explanation}” under Tools first.`
            : "No tool that changes cards is installed."
      }
    />
  )
}

function Permissions({
  session,
  forkId,
  leafSlotId,
  notesOff,
  cardsOff
}: {
  session: ChatSession
  forkId: ReturnType<ChatSession["snapshot"]>["forkId"]
  leafSlotId: ReturnType<ChatSession["snapshot"]>["leafSlotId"]
  /** Why the note boxes do nothing now (no tool that changes notes is on); null when they do. */
  notesOff: string | null
  cardsOff: string | null
}) {
  const chatId = session.id
  // Read again on every change to the chat's state or the library (a card or note saved).
  const atom = useMemo(
    () =>
      AppClient.query(
        "GetAgentPermissions",
        { chatId, slotId: leafSlotId, forkId },
        { reactivityKeys: ["library", `chat-notes:${chatId}`] }
      ),
    [chatId, forkId, leafSlotId]
  )
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A read again keeps the last answer (`waiting`), so the boxes don't jump.
  if (!AsyncResult.isSuccess(result))
    return AsyncResult.isFailure(result) ? (
      <p role="alert" className="text-sm text-danger">
        What the model may change couldn't be read.
      </p>
    ) : null
  const value = result.value

  const write = async (key: string, target: Target, on: boolean) => {
    setPending(key)
    const outcome = await session.changeCast({ _tag: "AgentPermission", target, on })
    setPending(null)
    setError(outcome.ok ? null : `That wasn't changed: ${outcome.error.message}`)
    refresh()
  }
  const busy = pending !== null
  const chatNotes = value.notes.filter((n) => n.card === null)
  const cardNotes = (card: string) => value.notes.filter((n) => n.card === card)
  const note = (n: AgentPermissions["notes"][number]) => {
    const key = `note:${n.entityId}`
    return (
      <Checkbox
        key={key}
        checked={n.on}
        disabled={busy || n.linked || notesOff !== null}
        hintInline={false}
        {...(n.linked ? { description: "A shared note: only its own editor changes it." } : {})}
        hint={
          n.linked
            ? `“${n.title}” shows a shared note, which only that note's editor changes.`
            : (notesOff ?? clickTo(n.on, `“${n.title}”`))
        }
        onCheckedChange={(on) => void write(key, { note: n.entityId }, on)}
      >
        {n.title}
      </Checkbox>
    )
  }

  return (
    <Fieldset
      legend="Model may change"
      about="What the model may change in this chat with its tools: each note, and each card's fields. Each starts as the note or card says. A change applies from the next reply, on this branch."
    >
      <div data-agent-permissions className="flex flex-col gap-4">
        <Group heading="Chat notes" off={notesOff}>
          {chatNotes.length ? chatNotes.map(note) : <p className="text-sm text-muted">This chat has no notes.</p>}
        </Group>
        {value.cards.flatMap((card) => [
          <Group key={card.entityId} heading={`${card.name}'s card`} off={cardsOff} wrap>
            {card.fields.map((f) => {
              const key = `card:${card.entityId}:${f.field}`
              const label = CARD_FIELD_LABELS[f.field]
              return (
                <Checkbox
                  key={key}
                  checked={f.on}
                  disabled={busy || cardsOff !== null}
                  hintInline={false}
                  hint={cardsOff ?? clickTo(f.on, `${card.name}'s ${label}`)}
                  onCheckedChange={(on) => void write(key, { card: card.entityId, field: f.field }, on)}
                >
                  {label}
                </Checkbox>
              )
            })}
          </Group>,
          ...(cardNotes(card.entityId).length
            ? [
                <Group key={`notes:${card.entityId}`} heading={`${card.name}'s notes`} off={notesOff}>
                  {cardNotes(card.entityId).map(note)}
                </Group>
              ]
            : [])
        ])}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </Fieldset>
  )
}

/**
 * A heading and its boxes: one a row, or wrapped side by side (a card's six short field names),
 * with why they're disabled, when they are, once under the heading.
 */
function Group({
  heading,
  off,
  wrap = false,
  children
}: {
  heading: string
  off: string | null
  wrap?: boolean
  children: ReactNode
}) {
  return (
    <div role="group" aria-label={heading} className="flex min-w-0 flex-col gap-2">
      <h4 className="text-xs font-medium text-muted">{heading}</h4>
      {off && <p className="text-xs text-muted">{off}</p>}
      {wrap ? <div className="flex flex-wrap gap-x-5 gap-y-2">{children}</div> : children}
    </div>
  )
}
