import { useAtomValue } from "@effect/atom-react"
import type { EntityKind, RefId } from "@dreamspan/shared/library.ts"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { shellAtom } from "../characters/shellData.tsx"
import { libraryListAtom } from "../library/queries.ts"
import { type DocumentChoice, HeaderSwitcher, type NewDocument } from "../pickers/DocumentPickers.tsx"
import { NewCardDialog } from "./NewCard.tsx"
import { NewDocumentDialog } from "./NewDocument.tsx"

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
  subject: suppliedSubject,
  create
}: {
  refId: RefId
  label: string
  kind: EntityKind
  /** The documents offered, when not the library's of this kind (a chat's notes, snippets). */
  items?: ReadonlyArray<DocumentChoice> | undefined
  subject?: string | undefined
  focus?: string | undefined
  /**
   * Makes a new one of those documents and gives its ref, which then opens here ("New snippet",
   * "New note"). Library documents use their shared creation dialog.
   */
  create?: { label: string; hint: string; run: () => Promise<RefId | null> } | undefined
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
  const made: NewDocument | undefined = create && {
    label: create.label,
    hint: create.hint,
    start: () =>
      void create.run().then((next) => {
        if (next !== null) open(next)
      })
  }
  return items ? (
    <ChoicesSwitcher refId={refId} label={label} subject={subject} choices={items} open={open} create={made} />
  ) : (
    <LibrarySwitcher refId={refId} label={label} subject={subject} kind={kind} open={open} />
  )
}

function CardSwitcher({ refId, label, open }: { refId: RefId; label: string; open: (refId: RefId) => void }) {
  const shell = useAtomValue(shellAtom)
  const persona = AsyncResult.isSuccess(shell) && shell.value.personas.some((p) => p.card.refId === refId)
  // The library's New card form, outliving the list it's started from; the card opens here.
  const [making, setMaking] = useState<"card" | "persona" | null>(null)
  return (
    <>
      <HeaderSwitcher
        kind="card"
        subject={persona ? "persona" : "card"}
        value={refId}
        label={label}
        persona={persona}
        create={{
          label: "New card…",
          hint: "Opens a form to create a card in this editor.",
          start: () => setMaking("card")
        }}
        createPersona={{
          label: "New persona…",
          hint: "Opens a form to create a persona in this editor.",
          start: () => setMaking("persona")
        }}
        open={open}
      />
      <NewCardDialog
        key={making ?? "closed"}
        persona={making === "persona"}
        open={making !== null}
        onOpenChange={(next) => {
          if (!next) setMaking(null)
        }}
        onCreated={open}
      />
    </>
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
  const [making, setMaking] = useState(false)
  const choices = AsyncResult.isSuccess(result)
    ? result.value.map((ref) => ({ value: ref.id, label: ref.label, subtitle: ref.subtitle, updatedAt: ref.updatedAt }))
    : []
  const creatable = kind === "lorebook" || kind === "note" ? kind : null
  return (
    <>
      <ChoicesSwitcher
        {...props}
        choices={choices}
        create={
          creatable
            ? {
                label: `New ${creatable}…`,
                hint: `Creates an empty ${creatable} and opens its editor.`,
                start: () => setMaking(true)
              }
            : undefined
        }
      />
      {creatable && (
        <NewDocumentDialog
          kind={creatable}
          open={making}
          onOpenChange={setMaking}
          onCreated={(ref) => {
            setMaking(false)
            props.open(ref.id)
          }}
        />
      )}
    </>
  )
}

function ChoicesSwitcher({
  refId,
  label,
  subject,
  choices,
  create,
  open
}: {
  refId: RefId
  label: string
  subject: string
  choices: ReadonlyArray<DocumentChoice>
  create?: NewDocument | undefined
  open: (refId: RefId) => void
}) {
  // A card's own lorebook isn't one of the library's: it's offered too, under its own name.
  const all = choices.some((choice) => choice.value === refId) ? choices : [{ value: refId, label }, ...choices]
  return (
    <HeaderSwitcher
      kind="document"
      subject={subject}
      value={refId}
      label={label}
      choices={all}
      create={create}
      open={open}
    />
  )
}
