import { useState } from "react"
import { Atom } from "effect/reactivity"
import { ArchiveCriteria, cardArchiveCriteria, type ArchiveCandidate } from "@rp/shared/cardArchive.ts"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Checkbox } from "../../ui/Choice.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { WindowedList } from "../../ui/WindowedList.tsx"

const candidates = Atom.family((key: string) =>
  AppClient.query(
    "ListArchiveCandidates",
    { criteria: JSON.parse(key) as ArchiveCriteria },
    { reactivityKeys: ["library", "chats", "favourites"] }
  )
)
const date = (at: number) => new Date(at).toLocaleDateString()

function Selection({
  cards,
  criteria,
  close
}: {
  cards: ReadonlyArray<ArchiveCandidate>
  criteria: ArchiveCriteria
  close: () => void
}) {
  const [omitted, setOmitted] = useState<ReadonlySet<string>>(new Set())
  const selected = cards.filter((card) => !omitted.has(card.entityId))
  const action = useAction()
  const archive = async () => {
    const result = await action.run(
      (client) => client("ArchiveUnusedCards", { criteria, entityIds: selected.map((card) => card.entityId) }),
      ["library"]
    )
    if (!result.ok) return
    close()
    const receipt = result.value
    showToast({
      title: `${receipt.entityIds.length} cards archived`,
      actions: [
        {
          label: "Undo",
          hint: "Return these cards to the normal lists",
          onClick: () => {
            void action
              .run((client) => client("UndoCardArchive", receipt), ["library"])
              .then((result) => {
                if (!result.ok) showToast({ title: "Couldn’t undo archive", description: result.error.message })
              })
          }
        }
      ]
    })
  }
  return (
    <>
      <p className="text-sm text-muted">
        {cards.length.toLocaleString()} matches · {selected.length.toLocaleString()} selected
      </p>
      <WindowedList
        items={cards}
        itemKey={(card) => card.entityId}
        listLabel="Matching cards"
        className="max-h-72 min-h-0 overflow-y-auto rounded-md border border-border p-2 [scrollbar-gutter:stable]"
        renderItem={(card) => (
          <div className="flex min-w-0 items-center gap-3 rounded-md p-2">
            <Avatar id={card.entityId} name={card.name} mediaId={card.avatarMediaId} size="md" />
            <div className="min-w-0 flex-1">
              <Checkbox
                checked={!omitted.has(card.entityId)}
                disabled={action.pending}
                hint={`Include ${card.name} in this archive`}
                hintInline={false}
                onCheckedChange={(checked) =>
                  setOmitted((old) => {
                    const next = new Set(old)
                    if (checked) next.delete(card.entityId)
                    else next.add(card.entityId)
                    return next
                  })
                }
              >
                <span className="[overflow-wrap:anywhere]">{card.name}</span>
              </Checkbox>
              <p className="mt-1 text-xs text-muted">
                Added {date(card.addedAt)} ·{" "}
                {card.lastUsedAt === null ? "Never used" : `Last used ${date(card.lastUsedAt)}`}
              </p>
            </div>
          </div>
        )}
      />
      <ErrorAlert error={action.error} />
      <DialogActions>
        <Button hint="Close without archiving cards" onClick={close}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!selected.length || action.pending}
          hint={
            selected.length ? "Archive the selected cards, keeping favourites" : "Select at least one matching card"
          }
          onClick={() => void archive()}
        >
          Archive {selected.length.toLocaleString()} cards
        </Button>
      </DialogActions>
    </>
  )
}

function ArchiveDialog({ close }: { close: () => void }) {
  const entries = cardArchiveCriteria.list()
  const [amounts, setAmounts] = useState<Record<string, number>>(() =>
    Object.fromEntries(entries.map((entry) => [entry.id, entry.initial]))
  )
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(entries.map((entry) => [entry.id, entry.enabled]))
  )
  const criteria = Object.fromEntries(
    entries.filter((entry) => enabled[entry.id]).map((entry) => [entry.id, amounts[entry.id]!])
  )
  const key = JSON.stringify(criteria)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
      title="Archive unused cards"
      placement="top"
    >
      <p className="text-sm text-muted">
        Matches either checked rule. Favourites stay. Sending a message, receiving a reply, editing or forking a card
        counts as use; a greeting alone doesn’t.
      </p>
      {entries.map((entry) => (
        <div key={entry.id} className="flex flex-col gap-2">
          <Checkbox
            checked={enabled[entry.id] === true}
            hint={`Click to ${enabled[entry.id] ? "stop matching" : "match"} this rule`}
            hintInline={false}
            onCheckedChange={(checked) => setEnabled((old) => ({ ...old, [entry.id]: checked }))}
          >
            {entry.label}
          </Checkbox>
          <Field label={`${entry.unit} (${entry.label.toLowerCase()})`} labelHidden>
            <div className="flex items-center gap-2 pl-6">
              <Input
                type="number"
                aria-label={entry.inputLabel}
                min={1}
                max={36000}
                value={amounts[entry.id]}
                onChange={(event) => {
                  const amount = event.currentTarget.valueAsNumber
                  if (Number.isInteger(amount) && amount >= 1 && amount <= 36000)
                    setAmounts((old) => ({ ...old, [entry.id]: amount }))
                }}
              />
              <span className="text-sm text-muted">{entry.unit}</span>
            </div>
          </Field>
        </div>
      ))}
      <AsyncView atom={candidates(key)} loading="Finding cards…">
        {(cards) => <Selection key={key} cards={cards} criteria={criteria} close={close} />}
      </AsyncView>
    </Dialog>
  )
}

export function ArchiveUnused() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <Button hint="Review older unused cards to archive together" aria-pressed={open} onClick={() => setOpen(true)}>
        Archive unused cards…
      </Button>
      {open && <ArchiveDialog close={() => setOpen(false)} />}
    </div>
  )
}
