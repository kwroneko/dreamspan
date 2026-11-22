import type { RefId } from "@dreamspan/shared/library.ts"
import { useUserDraft, UserDraftStatus } from "./userDraft.tsx"
import { cardNames } from "@dreamspan/shared/cardNames.ts"
import { Effect } from "effect"
import { useCardNameCheck } from "./cardNameCheck.ts"
import { checkCardNames } from "./checkCardNames.ts"
// Edit scope: making a named variant is one action. Card names live in revision content;
// other library entries retain their separate labels.
import { useNavigate } from "@tanstack/react-router"
import { type FormEvent, type ReactNode, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Checkbox } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { InlineRename } from "../../ui/InlineRename.tsx"
import { type EditorStore, useEditorState } from "./store.ts"
import { flushOpenEditors, refreshOpenEditors } from "./openEditors.ts"

export function ForkDialog({
  store,
  onClose,
  onCreated
}: {
  store: EditorStore
  onClose: () => void
  onCreated?: (ref: RefId) => void
}) {
  const state = useEditorState(store)
  const ref = state.snapshot!.ref
  const action = useAction()
  const navigate = useNavigate()
  const dirty = state.dirty > 0
  const durable = useUserDraft(
    `ref:${ref.id}:fork`,
    "Names",
    JSON.stringify({
      label: ref.kind === "card" ? ref.label : `${ref.label} (variant)`,
      subtitle: ref.kind === "card" ? ref.subtitle : "",
      nickname: cardNames(state.snapshot!.doc).modelName
    })
  )
  const names = JSON.parse(durable.text) as { label: string; subtitle: string; nickname: string }
  const { label, subtitle, nickname } = names
  const setLabel = (label: string) => durable.setText(JSON.stringify({ ...names, label }))
  const setSubtitle = (subtitle: string) => durable.setText(JSON.stringify({ ...names, subtitle }))
  const setNickname = (nickname: string) => durable.setText(JSON.stringify({ ...names, nickname }))
  const nameCheck = useCardNameCheck(label.trim(), subtitle.trim())
  const clash = ref.kind === "card" ? nameCheck : null
  // A card's fork always takes its unsaved changes (owner, 2026-11-02); a variant asks.
  const [moveDrafts, setMoveDrafts] = useState(dirty)
  const moving = ref.kind === "card" ? dirty : moveDrafts
  const [preparing, setPreparing] = useState(false)
  const pending = preparing || action.pending

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (clash || pending) return
    setPreparing(true)
    await store.flush()
    // And its notes' editors: a card's fork takes their unsaved text (carryDrafts.ts).
    if (ref.kind === "card") await flushOpenEditors().catch(() => undefined)
    if (moving && store.saveError) {
      setPreparing(false)
      return
    }
    await durable
      .commit(durable.text, async () => {
        const result = await action.run(
          (client) =>
            Effect.gen(function* () {
              if (ref.kind === "card") yield* checkCardNames(client, label.trim(), subtitle.trim())
              if (ref.kind === "card")
                return yield* client("ForkCard", {
                  refId: ref.id,
                  name: label.trim(),
                  nickname,
                  characterVersion: subtitle.trim()
                })
              return yield* client("ForkVariant", {
                refId: ref.id,
                label: label.trim(),
                subtitle: subtitle.trim(),
                moveDrafts
              })
            }),
          ["library"]
        )
        setPreparing(false)
        if (result.ok && ref.kind === "card") void refreshOpenEditors()
        if (result.ok) {
          // Closed first: the fork may open in a tab of its own, beside this one.
          onClose()
          if (onCreated) onCreated(result.value.id)
          else void navigate({ to: "/library/$refId", params: { refId: result.value.id } })
        }
        return result.ok
      })
      .finally(() => setPreparing(false))
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      title={ref.kind === "card" ? "Fork card" : "Make a variant"}
    >
      <UserDraftStatus draft={durable} />
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <Field
          label={ref.kind === "card" ? "Display name" : "Library label"}
          about={
            ref.kind === "card"
              ? "Unsaved changes move to the copy; the original returns to its last save."
              : "The variant keeps its own content. Later changes to the original can be merged into it."
          }
        >
          <Input value={label} onChange={(event) => setLabel(event.currentTarget.value)} required />
        </Field>
        <Field
          label={ref.kind === "card" ? "Version (shown as subtitle)" : "Subtitle (optional)"}
          about={ref.kind === "card" ? "Change the version or display name to tell this fork apart." : undefined}
        >
          <Input
            autoFocus={ref.kind === "card"}
            value={subtitle}
            onChange={(event) => setSubtitle(event.currentTarget.value)}
          />
        </Field>
        {ref.kind === "card" && (
          <Field label="In-character name" about="Used in prompts and {{char}}. Empty uses the display name.">
            <Input value={nickname} onChange={(event) => setNickname(event.currentTarget.value)} />
          </Field>
        )}
        {dirty && ref.kind !== "card" && (
          <Checkbox
            checked={moveDrafts}
            onCheckedChange={setMoveDrafts}
            about="Move the unsaved changes to the new variant. This one returns to its last save."
          >
            Take my unsaved changes to the variant
          </Checkbox>
        )}
        {clash && (
          <p role="status" className="text-sm text-muted">
            {clash}
          </p>
        )}
        <ErrorAlert error={action.error ?? store.saveError} />
        <DialogActions>
          <Button hint="Closes this dialog without applying changes." onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            hint="Creates a separate copy for editing."
            type="submit"
            variant="primary"
            pending={pending}
            disabled={label.trim() === "" || clash !== null}
          >
            {ref.kind === "card" ? "Fork card" : "Make the variant"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

/**
 * A library entry's name, renamed in place (pencil, then the field with Save and Cancel): the
 * library label of a preset, lorebook or note. A card's name is its revision's own field.
 */
export function RefName({
  store,
  children,
  onRenamed
}: {
  store: EditorStore
  children?: ReactNode
  /** After the rename: a lorebook's document takes the name too, as a change of the book. */
  onRenamed?: (label: string) => void
}) {
  const ref = useEditorState(store).snapshot!.ref
  const action = useAction()
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <InlineRename
        place={`ref-name:${ref.id}`}
        value={ref.label}
        label={ref.label}
        onRename={async (label) => {
          const result = await action.run(
            (client) =>
              client("RenameRef", {
                refId: ref.id,
                label,
                subtitle: ref.subtitle,
                expectedRowVersion: ref.rowVersion
              }),
            ["library"]
          )
          if (result.ok) {
            onRenamed?.(label)
            await store.refresh()
          }
          return result.ok
        }}
      >
        {children}
      </InlineRename>
      <ErrorAlert error={action.error} />
    </span>
  )
}
