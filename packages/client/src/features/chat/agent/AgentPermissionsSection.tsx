// The "This chat" tab's Model may change (spec/AGENTIC.md §4.3): what agent replies may change in
// this chat, each of its notes and each card field a checkbox, written as `agent.permission` at
// the leaf shown, so it follows the branch and applies from the next reply. A box starts as the
// note's own setting ("The agent may edit it") or the card's (its Model may change list) says;
// once the chat has its own choice for a box, Reset beside it goes back to that setting. Shown
// with the Tools list, for a mode that uses tools.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { AgentPermissions } from "@dreamspan/shared/agentApi.ts"
import type { CastChange } from "@dreamspan/shared/chatSetupApi.ts"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useMemo, useState, useSyncExternalStore } from "react"
import { AppClient } from "../../../rpc.ts"
import { Button } from "../../../ui/Button.tsx"
import { Checkbox } from "../../../ui/Choice.tsx"
import { Fieldset } from "../../../ui/Field.tsx"
import { CARD_FIELD_LABELS } from "../../editor/noteTargets.ts"
import type { ChatSession } from "../session.ts"
import { useReplyTools } from "./replyTools.ts"

type Target = Extract<CastChange, { readonly _tag: "AgentPermission" }>["target"]

/** The tools that change notes, and the one that changes card fields. */
const NOTE_TOOLS = ["edit_note", "switch_note"]
const CARD_TOOL = "edit_card"

/** "Click to …" for a box (owner, 2026-11-03: a toggle says what clicking does). */
const clickTo = (on: boolean, what: string) =>
  on ? `Click to stop the model changing ${what} in this chat.` : `Click to let the model change ${what} in this chat.`

/**
 * Drops the chat's choice for a box, shown only while the chat has one: at the end of the box's
 * row, so nothing else moves when it comes or goes.
 */
function Reset({ hint, disabled, onReset }: { hint: string; disabled: boolean; onReset: () => void }) {
  return (
    <Button
      variant="ghost"
      className="-my-1 h-6! shrink-0 px-1.5 text-xs"
      disabled={disabled}
      hint={hint}
      onClick={onReset}
    >
      Reset
    </Button>
  )
}

/** A box and, while the chat overrides it, its Reset at the row's end. */
function Row({ children, reset }: { children: ReactNode; reset: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <div className="min-w-0">{children}</div>
      {reset}
    </div>
  )
}

export function AgentPermissionsSection({ session }: { session: ChatSession }) {
  const view = useSyncExternalStore(session.subscribe, session.snapshot)
  const { tools: available } = useReplyTools(session)
  if (!available || view.cast?.agentEnabled !== true) return null
  const tools = view.cast.agentTools ?? available.defaultTools
  const offered = (ids: ReadonlyArray<string>) => ids.some((id) => tools.includes(id))
  const cardTool = available.tools.find((t) => t.id === CARD_TOOL)
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

  const write = async (key: string, target: Target, on: boolean | null) => {
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
      <Row
        key={key}
        reset={
          n.chosen ? (
            <Reset
              disabled={busy}
              hint={`Goes back to “${n.title}”'s own setting: the model ${n.own ? "may" : "may not"} change it.`}
              onReset={() => void write(key, { note: n.entityId }, null)}
            />
          ) : null
        }
      >
        <Checkbox
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
      </Row>
    )
  }

  return (
    <Fieldset
      legend="Model may change"
      about="What the model may change in this chat with its tools: each note, and each card's fields. Each starts as the note or card says; Reset goes back to that. A change applies from the next reply, on this branch."
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
                <Row
                  key={key}
                  reset={
                    f.chosen ? (
                      <Reset
                        disabled={busy}
                        hint={`Goes back to ${card.name}'s card setting: the model ${f.own ? "may" : "may not"} change its ${label}.`}
                        onReset={() => void write(key, { card: card.entityId, field: f.field }, null)}
                      />
                    ) : null
                  }
                >
                  <Checkbox
                    checked={f.on}
                    disabled={busy || cardsOff !== null}
                    hintInline={false}
                    hint={cardsOff ?? clickTo(f.on, `${card.name}'s ${label}`)}
                    onCheckedChange={(on) => void write(key, { card: card.entityId, field: f.field }, on)}
                  >
                    {label}
                  </Checkbox>
                </Row>
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
 * A heading and its boxes: one a row, or side by side in equal columns (a card's six short field
 * names, each with room for its Reset), with why they're disabled, when they are, once under the
 * heading.
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
      {wrap ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-x-5 gap-y-2">{children}</div>
      ) : (
        children
      )}
    </div>
  )
}
