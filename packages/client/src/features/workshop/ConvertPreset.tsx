// "Convert to workshop" on a preset (spec/WORKSHOP-CONTEXT.md §4.4): a new workshop preset made
// from this one's saved version. The story pieces are listed to keep, drop or reword; the
// workshop pieces are added. The original never changes.
import type { PresetDoc } from "@dreamspan/shared/docs/preset.ts"
import { type ConversionChoice, conversionItems, workshopPieces } from "@dreamspan/shared/workshopPreset.ts"
import { useNavigate } from "@tanstack/react-router"
import { type FormEvent, useMemo } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input, Textarea } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { type EditorStore, useEditorState } from "../editor/store.ts"
import { useUserDraft, UserDraftStatus } from "../editor/userDraft.tsx"

const HINT =
  "Makes a new workshop preset from this one's saved version. You choose which story pieces to keep; this preset doesn't change."

export function ConvertPresetButton({ store, compact }: { store: EditorStore; compact: boolean }) {
  const snapshot = useEditorState(store).snapshot
  const [place, setPlace] = usePlaceParam("convertPreset", "")
  if (!snapshot || snapshot.ref.kind !== "preset") return null
  const target = `${compact ? "panel" : "editor"}:${snapshot.ref.id}`
  return (
    <>
      <Button
        // With only its icon showing, the 32 px square of the toolbar's icon buttons.
        className="h-8! px-2! @max-[60rem]:w-8 @max-[60rem]:px-0!"
        aria-label="Convert to workshop"
        hint={HINT}
        onClick={() => setPlace(target)}
      >
        <Icon name="tool" />
        {/* The toolbar's longest label goes first: with it, the row needs 59rem (presetMarkers.spec.ts). */}
        <span className="@max-[60rem]:hidden">Convert to workshop</span>
      </Button>
      {place === target && (
        <ConvertDialog
          refId={snapshot.ref.id}
          label={snapshot.ref.label}
          doc={snapshot.doc as PresetDoc}
          onClose={() => setPlace("")}
        />
      )}
    </>
  )
}

function ConvertDialog({
  refId,
  label,
  doc,
  onClose
}: {
  refId: string
  label: string
  doc: PresetDoc
  onClose: () => void
}) {
  const navigate = useNavigate()
  const action = useAction()
  const items = useMemo(() => conversionItems(doc), [doc])
  const draft = useUserDraft(
    `workshop-convert:${refId}`,
    "Workshop preset",
    JSON.stringify({
      name: `${label} (workshop)`,
      instructions: doc.prompts.find((p) => p.identifier === "workspaceInstructions")?.content ?? "",
      choices: Object.fromEntries(
        items.map((item) => [item.identifier, { identifier: item.identifier, keep: item.kind === "review" }])
      )
    })
  )
  const values = JSON.parse(draft.text) as {
    name: string
    instructions: string
    choices: Record<string, ConversionChoice>
  }
  const { name, instructions, choices } = values
  const edit = (change: Partial<typeof values>) => draft.setText(JSON.stringify({ ...values, ...change }))
  const set = (identifier: string, change: Partial<ConversionChoice>) =>
    edit({ choices: { ...choices, [identifier]: { ...choices[identifier]!, ...change } } })
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (action.pending || !draft.ready) return
    await draft.commit(draft.text, async () => {
      const result = await action.run(
        (client) =>
          client("ConvertPresetToWorkshop", {
            refId: refId as never,
            label: name.trim(),
            choices: Object.values(choices),
            instructions
          }),
        ["library"]
      )
      if (!result.ok) return false
      await navigate({ to: "/library/$refId", params: { refId: result.value.id }, search: {} })
      return true
    })
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Convert to a workshop preset"
      description="A new preset for workshops. The card's description and personality and the conversation stay."
      placement="top"
    >
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <Field label="Name">
          <Input
            value={name}
            onChange={(event) => edit({ name: event.currentTarget.value })}
            maxLength={200}
            required
          />
        </Field>
        {items.length > 0 && (
          <ul className="flex flex-col gap-3" aria-label="Pieces to keep or drop">
            {items.map((item) => {
              const choice = choices[item.identifier] ?? { identifier: item.identifier, keep: item.kind === "review" }
              return (
                <li key={item.identifier} className="flex flex-col gap-2 rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 font-medium">{item.name}</span>
                    <Segmented
                      label={`Keep ${item.name}`}
                      // The piece's own reason shows below; Keep and Drop explain themselves on hover.
                      inlineDescription={false}
                      value={choice.keep ? "keep" : "drop"}
                      onValueChange={(value) => set(item.identifier, { keep: value === "keep" })}
                      options={[
                        { value: "keep", label: "Keep", description: "The new preset keeps this piece." },
                        { value: "drop", label: "Drop", description: "The new preset leaves this piece out." }
                      ]}
                    />
                  </div>
                  <p className="text-sm text-muted">{item.reason}</p>
                  {choice.keep && !item.marker && (
                    <Field label={`Text of ${item.name}`}>
                      <Textarea
                        value={choice.content ?? item.content}
                        onChange={(event) => set(item.identifier, { content: event.currentTarget.value })}
                      />
                    </Field>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <Field label="Workspace instructions">
          <Textarea
            value={instructions}
            placeholder="How you like the assistant to work, such as how cards should be written."
            onChange={(event) => edit({ instructions: event.currentTarget.value })}
          />
        </Field>
        <p className="text-sm text-muted">
          Also added:{" "}
          {workshopPieces()
            .slice(1)
            .map((p) => p.prompt.name)
            .join(", ")}
          , filled in as the app gets them.
        </p>
        <ErrorAlert error={action.error} />
        <UserDraftStatus draft={draft} />
        <DialogActions>
          <Button hint="Closes this dialog without making a preset." onClick={onClose}>
            Cancel
          </Button>
          <Button
            hint="Makes the new workshop preset and opens it."
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={!name.trim() || !draft.ready}
          >
            Make preset
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
