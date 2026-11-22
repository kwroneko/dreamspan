import { useDurableForm, useOpenPlace } from "../editor/durable.tsx"
import { useAtomValue } from "@effect/atom-react"
import { useState } from "react"
import { AsyncResult, Atom } from "effect/reactivity"
import { ArchiveCriteria, cardArchiveCriteria, type ArchiveCandidate } from "@dreamspan/shared/cardArchive.ts"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { sourcesAtom } from "../cardSources/remote.ts"
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

/** The names of the card sources that are on for this user; a criterion for them shows only then. */
function useSourceNames() {
  const result = useAtomValue(sourcesAtom)
  return AsyncResult.isSuccess(result) ? result.value.sources.filter((s) => s.enabled).map((s) => s.name) : []
}

/** How many cards a criterion matches on its own, beside it ("12 cards"). */
function MatchCount({ id, amount }: { id: string; amount: number }) {
  const result = useAtomValue(candidates(JSON.stringify({ [id]: amount })))
  if (!AsyncResult.isSuccess(result)) return null
  const count = result.value.length
  return (
    <span className="text-sm text-muted" data-criterion-count={id}>
      {count === 1 ? "1 card" : `${count.toLocaleString()} cards`}
    </span>
  )
}

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
                {card.userMessages !== undefined &&
                  ` · ${card.userMessages === 1 ? "1 message" : `${card.userMessages.toLocaleString()} messages`} of yours`}
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
  const sourceNames = useSourceNames()
  // A criterion for card sources shows only while one is on.
  const entries = cardArchiveCriteria.list().filter((entry) => !entry.forCardSources || sourceNames.length > 0)
  // The rules as typed (each amount as its text) and ticked, kept until the dialog closes.
  const form = useDurableForm("archive-unused", "Rules", {
    amounts: Object.fromEntries(entries.map((entry) => [entry.id, String(entry.initial)])) as Record<string, string>,
    enabled: Object.fromEntries(entries.map((entry) => [entry.id, entry.enabled])) as Record<string, boolean>
  })
  const { enabled } = form.values
  const valueOf = (id: string, initial: number) => {
    const next = Number(form.values.amounts[id])
    return Number.isInteger(next) && next >= 1 && next <= 36000 ? next : initial
  }
  const setEnabled = (change: (old: Record<string, boolean>) => Record<string, boolean>) =>
    form.edit({ enabled: change(enabled) })
  const closeDialog = () => {
    void form.discard()
    close()
  }
  const criteria = Object.fromEntries(
    entries.filter((entry) => enabled[entry.id]).map((entry) => [entry.id, valueOf(entry.id, entry.initial)])
  )
  const key = JSON.stringify(criteria)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeDialog()
      }}
      title="Archive unused cards"
      placement="top"
    >
      <p className="text-sm text-muted">
        Matches any checked rule. Favourites stay. Sending a message, receiving a reply, editing or forking a card
        counts as use; a greeting alone doesn’t.
      </p>
      {entries.map((entry) => {
        const label = entry.forCardSources?.(sourceNames) ?? entry.label
        const amount = valueOf(entry.id, entry.initial)
        return (
          <div key={entry.id} className="flex flex-col gap-2" data-archive-criterion={entry.id}>
            <Checkbox
              checked={enabled[entry.id] === true}
              hint={`Click to ${enabled[entry.id] ? "stop matching" : "match"} this rule`}
              hintInline={false}
              onCheckedChange={(checked) => setEnabled((old) => ({ ...old, [entry.id]: checked }))}
            >
              {label}
            </Checkbox>
            <Field label={`${entry.unit} (${label.toLowerCase()})`} labelHidden>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-6">
                <Input
                  type="number"
                  aria-label={entry.inputLabel}
                  min={1}
                  max={36000}
                  value={form.values.amounts[entry.id] ?? String(entry.initial)}
                  readOnly={!form.ready}
                  onChange={(event) =>
                    form.edit({ amounts: { ...form.values.amounts, [entry.id]: event.currentTarget.value } })
                  }
                />
                <span className="text-sm text-muted">{entry.unit}</span>
                {entry.forCardSources && <MatchCount id={entry.id} amount={amount} />}
              </div>
            </Field>
          </div>
        )
      })}
      <AsyncView atom={candidates(key)} loading="Finding cards…">
        {(cards) => <Selection key={key} cards={cards} criteria={criteria} close={closeDialog} />}
      </AsyncView>
    </Dialog>
  )
}

export function ArchiveUnused() {
  const [open, setOpen] = useOpenPlace("archive-unused")
  return (
    <div>
      <Button hint="Review older unused cards to archive together" aria-pressed={open} onClick={() => setOpen(true)}>
        Archive unused cards…
      </Button>
      {open && <ArchiveDialog close={() => setOpen(false)} />}
    </div>
  )
}
