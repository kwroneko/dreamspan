import { useAtomValue } from "@effect/atom-react"
import type { EntityKind, RefId } from "@rp/shared/library.ts"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { Select } from "../../ui/Select.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { shellAtom } from "../characters/shellData.tsx"
import { libraryListAtom } from "../library/queries.ts"

/** Uses the same route transition as leaving an editor through the library. */
export function DocumentSwitcher({
  refId,
  label,
  kind,
  items,
  focus,
  subject: suppliedSubject
}: {
  refId: RefId
  label: string
  kind: EntityKind
  items?: ReadonlyArray<{ value: RefId; label: string }> | undefined
  subject?: string | undefined
  focus?: string | undefined
}) {
  const result = useAtomValue(libraryListAtom(kind))
  const shell = useAtomValue(shellAtom)
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const navigate = useNavigate()
  let choices =
    items ??
    (AsyncResult.isSuccess(result)
      ? result.value.map((ref) => ({
          value: ref.id,
          label: ref.kind !== "card" && ref.subtitle ? `${ref.label} · ${ref.subtitle}` : ref.label
        }))
      : [])
  let subject: string = suppliedSubject ?? kind
  if (kind === "card" && AsyncResult.isSuccess(shell)) {
    const persona = shell.value.personas.some((p) => p.card.refId === refId)
    const ids = new Set((persona ? shell.value.personas : shell.value.cards).map((p) => p.card.refId))
    choices = choices.filter((choice) => ids.has(choice.value))
    subject = persona ? "persona" : "card"
  }
  if (!choices.some((choice) => choice.value === refId)) choices = [{ value: refId, label }, ...choices]
  return (
    <Tooltip label={`Switches to another ${subject} in this editor.`}>
      <span className="block min-w-0 flex-1">
        <Select
          ariaLabel={`Switch ${subject}`}
          className="border-transparent bg-transparent px-1 shadow-none"
          value={refId}
          items={choices}
          shown={() => label}
          onValueChange={(next) => {
            if (next === refId) return
            // An editor opened from a chat stays bound to that chat.
            const chat = typeof search.chat === "string" ? { chat: search.chat } : {}
            const chatFork = typeof search.chatFork === "string" ? { chatFork: search.chatFork } : {}
            void navigate({
              to: "/library/$refId",
              params: { refId: next },
              search: { ...(focus ? { focus } : {}), ...chat, ...chatFork }
            })
          }}
        />
      </span>
    </Tooltip>
  )
}
