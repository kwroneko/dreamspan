// The composer's "To this thread ▾" chip (spec/THREADS.md §6.1, `composer.threads`), in the
// next-reply strip, only in a thread: its popover lists the other threads of every set this one
// is in, innermost first, each with a tick, its name, its characters' faces and whom the user
// writes as there. Ticked, the chip reads "To 2 threads" and Send says where the message goes.
import type { EntityId } from "@rp/shared/chat.ts"
import { useState } from "react"
import { Avatar } from "../../ui/Avatar.tsx"
import { Checkbox } from "../../ui/Choice.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Select } from "../../ui/Select.tsx"
import { listNames, useCast } from "../chat/cast.ts"
import type { ComposerControlContext } from "../chat/composerControls.tsx"
import { ChipText, chipClass } from "../chat/nextReplyStrip.tsx"
import { splitNumber, threadName } from "./model.ts"
import { offeredThreads, setTick, useTicks } from "./sendTargets.ts"
import { shownForkOf, useThreadSets } from "./threadSets.ts"

export const CHIP_HINT = "Choose other threads that get this message too. Each one replies on its own."

/** "As there": the card that thread's composer writes as. */
const AS_THERE = "as-there"

export function SendToThreadsChip({ session, view }: ComposerControlContext) {
  const sets = useThreadSets(session, view)
  const cast = useCast()
  const [open, setOpen] = useState(false)
  const shown = shownForkOf(view)
  const chatId = view.chat?.id ?? null
  const chosen = useTicks(chatId, shown)
  if (sets === null || shown === null || chatId === null) return null
  const offered = offeredThreads(sets, shown)
  if (offered.length === 0) return null
  const name = (id: EntityId) => cast.cards.get(id)?.name ?? null
  const ticked = offered.filter((other) => chosen.has(other.key))
  const count = 1 + ticked.length
  const label = count === 1 ? "To this thread" : `To ${count} threads`
  const names = ticked.map((other) => `“${threadName(other.thread, name)}”`)
  const cards = [...new Set([...(cast.cast?.playedByMe ?? []), ...(cast.cast?.participants ?? [])])]
  const nested = new Set(offered.map((other) => other.set.splitId)).size > 1
  return (
    <span data-send-threads className="contents">
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger={
          <>
            <Icon name="threads" size={12} className="text-muted" />
            <ChipText>{label}</ChipText>
          </>
        }
        triggerLabel={`${label}. Choose other threads that get this message`}
        hint={count === 1 ? CHIP_HINT : `This message goes to this thread and ${listNames(names)}. ${CHIP_HINT}`}
        title="Send to threads"
        triggerClassName={chipClass(count > 1 ? "success" : "neutral")}
      >
        <p className="text-sm text-muted">
          What you send goes to this thread and each one ticked. Each replies on its own, from its own messages.
        </p>
        <div
          role="group"
          aria-label="Other threads"
          data-layout-audit-ignore="inset: Unbordered list of thread rows, inset by the popover's padding"
          className="flex min-h-0 flex-col gap-3 overflow-y-auto"
        >
          {offered.map((other, index) => {
            const title = threadName(other.thread, name)
            const on = chosen.has(other.key)
            const faces = other.thread.cast.flatMap((id) => cast.cards.get(id) ?? [])
            const heading = nested && (index === 0 || offered[index - 1]!.set.splitId !== other.set.splitId)
            return (
              <div key={other.key} data-send-thread={other.key} className="flex flex-col gap-1.5">
                {heading && <p className="text-xs font-medium text-muted">Threads from {splitNumber(other.set)}</p>}
                <div className="flex min-w-0 items-start gap-2">
                  <span className="min-w-0 flex-1">
                    <Checkbox
                      checked={on}
                      onCheckedChange={(next) => setTick(chatId, shown, other.key, next ? null : undefined)}
                      hint={`Also sends this message to “${title}”, where it gets a reply of its own.`}
                    >
                      {title}
                    </Checkbox>
                  </span>
                  {faces.length > 0 && (
                    <span
                      aria-label={`In this thread: ${faces.map((face) => face.name).join(", ")}`}
                      className="flex shrink-0 items-center gap-0.5"
                    >
                      {faces.slice(0, 3).map((face) => (
                        <Avatar
                          key={face.entityId}
                          id={face.entityId}
                          name={face.name}
                          mediaId={face.avatarMediaId}
                          crop={face.avatarCrop}
                          size="xs"
                        />
                      ))}
                    </span>
                  )}
                </div>
                {on && (
                  <label className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 ps-6.5 text-sm">
                    <span className="text-muted">Writes as</span>
                    <Select<string>
                      ariaLabel={`Writes as, in “${title}”`}
                      className="min-w-0 flex-1 basis-40"
                      value={chosen.get(other.key) ?? AS_THERE}
                      onValueChange={(value) =>
                        setTick(chatId, shown, other.key, value === AS_THERE ? null : (value as EntityId))
                      }
                      items={[
                        {
                          value: AS_THERE,
                          label: "As there",
                          description: "Whoever that thread's composer writes as."
                        },
                        ...cards.map((id) => ({ value: id as string, label: name(id) ?? "?" }))
                      ]}
                    />
                  </label>
                )}
              </div>
            )
          })}
        </div>
      </Popover>
    </span>
  )
}
