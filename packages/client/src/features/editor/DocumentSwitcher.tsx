import { useAtomValue } from "@effect/atom-react"
import type { EntityKind, RefId } from "@rp/shared/library.ts"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { shellAtom } from "../characters/shellData.tsx"
import { libraryListAtom } from "../library/queries.ts"
import { type DocumentChoice, HeaderSwitcher } from "../pickers/DocumentPickers.tsx"

/**
 * An editor's header switcher: its kind's complete picker (pickers/DocumentPickers.tsx).
 * Choosing uses the same route transition as leaving an editor through the library.
 */
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
  /** The documents offered, when not the library's of this kind (a chat's notes, snippets). */
  items?: ReadonlyArray<DocumentChoice> | undefined
  subject?: string | undefined
  focus?: string | undefined
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const navigate = useNavigate()
  const open = (next: RefId) => {
    if (next === refId) return
    // An editor opened from a chat stays bound to that chat.
    const chat = typeof search.chat === "string" ? { chat: search.chat } : {}
    const chatFork = typeof search.chatFork === "string" ? { chatFork: search.chatFork } : {}
    const chatTab = typeof search.chatTab === "string" ? { chatTab: search.chatTab } : {}
    void navigate({
      to: "/library/$refId",
      params: { refId: next },
      search: { ...(focus ? { focus } : {}), ...chat, ...chatFork, ...chatTab }
    })
  }
  if (kind === "preset")
    return <HeaderSwitcher kind="preset" subject="preset" value={refId} label={label} open={open} />
  if (kind === "card") return <CardSwitcher refId={refId} label={label} open={open} />
  const subject = suppliedSubject ?? kind
  return items ? (
    <ChoicesSwitcher refId={refId} label={label} subject={subject} choices={items} open={open} />
  ) : (
    <LibrarySwitcher refId={refId} label={label} subject={subject} kind={kind} open={open} />
  )
}

function CardSwitcher({ refId, label, open }: { refId: RefId; label: string; open: (refId: RefId) => void }) {
  const shell = useAtomValue(shellAtom)
  const persona = AsyncResult.isSuccess(shell) && shell.value.personas.some((p) => p.card.refId === refId)
  return (
    <HeaderSwitcher
      kind="card"
      subject={persona ? "persona" : "card"}
      value={refId}
      label={label}
      persona={persona}
      open={open}
    />
  )
}

function LibrarySwitcher({
  kind,
  ...props
}: {
  refId: RefId
  label: string
  subject: string
  kind: EntityKind
  open: (refId: RefId) => void
}) {
  const result = useAtomValue(libraryListAtom(kind))
  const choices = AsyncResult.isSuccess(result)
    ? result.value.map((ref) => ({ value: ref.id, label: ref.label, subtitle: ref.subtitle, updatedAt: ref.updatedAt }))
    : []
  return <ChoicesSwitcher {...props} choices={choices} />
}

function ChoicesSwitcher({
  refId,
  label,
  subject,
  choices,
  open
}: {
  refId: RefId
  label: string
  subject: string
  choices: ReadonlyArray<DocumentChoice>
  open: (refId: RefId) => void
}) {
  // A card's own lorebook isn't one of the library's: it's offered too, under its own name.
  const all = choices.some((choice) => choice.value === refId) ? choices : [{ value: refId, label }, ...choices]
  return <HeaderSwitcher kind="document" subject={subject} value={refId} label={label} choices={all} open={open} />
}
