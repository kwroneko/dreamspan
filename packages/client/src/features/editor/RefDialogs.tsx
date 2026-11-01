import { useUserDraft, UserDraftStatus } from "./userDraft.tsx"
import { cardNames } from "@rp/shared/cardNames.ts"
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

export function ForkDialog({ store, onClose }: { store: EditorStore; onClose: () => void }) {
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
  const [moveDrafts, setMoveDrafts] = useState(dirty)
  const [preparing, setPreparing] = useState(false)
  const pending = preparing || action.pending

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (clash || pending) return
    setPreparing(true)
    await store.flush()
    if (moveDrafts && store.saveError) {
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
                  characterVersion: subtitle.trim(),
                  moveDrafts
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
        if (result.ok) void navigate({ to: "/library/$refId", params: { refId: result.value.id } })
        return result.ok
      })
      .finally(() => setPreparing(false))
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      title={ref.kind === "card" ? "Fork card" : "Make a variant"}
      description={
        ref.kind === "card"
          ? `Creates an independent card and copies its notes from “${ref.label}”. Parent edits never reach it.`
          : `A named variant follows “${ref.label}”: its changes stay in the variant, and updates to “${ref.label}” still reach it.`
      }
    >
      <UserDraftStatus draft={durable} />
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <Field label={ref.kind === "card" ? "Display name" : "Library label"}>
          <Input value={label} onChange={(event) => setLabel(event.currentTarget.value)} required />
        </Field>
        <Field
          label={ref.kind === "card" ? "Version (shown as subtitle)" : "Subtitle (optional)"}
          description={ref.kind === "card" ? "Change the version or display name to tell this fork apart." : undefined}
        >
          <Input
            autoFocus={ref.kind === "card"}
            value={subtitle}
            onChange={(event) => setSubtitle(event.currentTarget.value)}
          />
        </Field>
        {ref.kind === "card" && (
          <Field label="In-character name" description="Used in prompts and {{char}}. Empty uses the display name.">
            <Input value={nickname} onChange={(event) => setNickname(event.currentTarget.value)} />
          </Field>
        )}
        {dirty && (
          <Checkbox
            checked={moveDrafts}
            onCheckedChange={setMoveDrafts}
            description={
              ref.kind === "card"
                ? "Drafts of the display name, in-character name and version stay here."
                : "They leave this one and become the variant's unsaved changes."
            }
          >
            Take my unsaved changes to the {ref.kind === "card" ? "fork" : "variant"}
          </Checkbox>
        )}
        {clash && (
          <p role="status" className="text-sm text-muted">
            {clash}
          </p>
        )}
        <ErrorAlert error={action.error ?? store.saveError} />
        <DialogActions>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" pending={pending} disabled={label.trim() === "" || clash !== null}>
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
export function RefName({ store, children }: { store: EditorStore; children?: ReactNode }) {
  const ref = useEditorState(store).snapshot!.ref
  const action = useAction()
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <InlineRename
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
          if (result.ok) await store.refresh()
          return result.ok
        }}
      >
        {children}
      </InlineRename>
      <ErrorAlert error={action.error} />
    </span>
  )
}
