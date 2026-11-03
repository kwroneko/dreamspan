import { libraryListAtom } from "../library/queries.ts"
import { useAtomValue } from "@effect/atom-react"
import type { EntityId } from "@rp/shared/chat.ts"
import type { CardFamily, FamilyMember, RefId } from "@rp/shared/library.ts"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useMemo, useState } from "react"
import { allOf, AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { MenuItem } from "../../ui/Menu.tsx"
import { Select } from "../../ui/Select.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Badge, Card, CardHeader } from "../../ui/Surface.tsx"
import { shellAtom } from "../characters/shellData.tsx"
import { useCaller } from "../editor/caller.ts"
import { ValueDiff } from "../editor/diff.tsx"
import { changedFields, fieldLabel } from "../editor/fields.ts"
import { ForkDialog } from "../editor/RefDialogs.tsx"
import { EditorStore } from "../editor/store.ts"
import type { CardMenuProps, CardSurfaceContext } from "./surfaces.tsx"

const familyQuery = (entityId: EntityId) => AppClient.query("CardFamily", { entityId }, { reactivityKeys: ["library"] })
const name = (member: FamilyMember) =>
  `${member.label || "Deleted card"}${member.subtitle ? ` · ${member.subtitle}` : ""}`
function MemberLink({ member }: { member: FamilyMember }) {
  return (
    <>
      {member.refId && ["live", "archived"].includes(member.state) ? (
        <Link
          to="/library/$refId"
          params={{ refId: member.refId }}
          className="text-accent hover:underline [overflow-wrap:anywhere]"
        >
          {name(member)}
        </Link>
      ) : (
        <span>{name(member)}</span>
      )}
      {member.state !== "live" && <Badge>{member.state === "binned" ? "in the bin" : member.state}</Badge>}
    </>
  )
}
function FamilyTree({ family, entityId }: { family: CardFamily; entityId: EntityId }) {
  const usage = useAtomValue(shellAtom)
  // The shell counts visible fork views as chats and dates each card by its Recent, as its
  // tile does. Family metadata alone counts containers, so it disagrees as soon as a chat branches.
  const cards = AsyncResult.isSuccess(usage)
    ? new Map([...usage.value.cards, ...usage.value.personas].map((c) => [c.card.entityId, c]))
    : null
  const walk = (parent: EntityId | null, depth = 0): Array<{ member: FamilyMember; depth: number }> =>
    family.members
      .filter((m) => m.parentEntityId === parent)
      .flatMap((member) => [{ member, depth }, ...walk(member.entityId, depth + 1)])
  return (
    <ul aria-label="Forks tree" className="flex flex-col gap-3">
      {walk(null).map(({ member, depth }) => {
        const shown = cards?.get(member.entityId)
        const chats = shown?.card.chats
        const last = shown?.recentAt ?? null
        return (
          <li
            key={member.entityId}
            style={{ paddingInlineStart: `${Math.min(depth, 6) * 12}px` }}
            className="flex min-w-0 flex-col gap-1 border-l border-border pl-2"
          >
            <div className="flex items-start gap-2">
              {depth > 0 && (
                <span aria-hidden className="shrink-0">
                  ↳
                </span>
              )}
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <MemberLink member={member} />
                {member.entityId === entityId && <Badge tone="accent">this card</Badge>}
              </div>
            </div>
            <p className="text-xs text-muted">
              {chats !== undefined ? (
                <>
                  {chats} {chats === 1 ? "chat" : "chats"} ·{" "}
                  {last === null ? "Never used" : `Last used ${new Date(last).toLocaleDateString()}`}
                </>
              ) : AsyncResult.isFailure(usage) || cards !== null ? (
                "Usage unavailable"
              ) : (
                "Loading usage…"
              )}
            </p>
          </li>
        )
      })}
    </ul>
  )
}
export function FamilySection({ entityId, whenForked }: CardSurfaceContext) {
  const atom = useMemo(() => familyQuery(entityId), [entityId])
  const result = useAtomValue(atom)
  // A card alone in its family has nothing to show here; More → Forks still opens the family.
  if (whenForked && AsyncResult.isSuccess(result) && result.value.members.length < 2) return null
  return (
    <Card>
      <CardHeader title="Forks" about="Separate copies of this card, each edited on its own." />
      <AsyncView atom={atom} loading="Loading the family…">
        {(family) => <FamilyTree family={family} entityId={entityId} />}
      </AsyncView>
    </Card>
  )
}
function FamilyDialog({ entityId, onClose }: CardSurfaceContext & { onClose: () => void }) {
  const atom = useMemo(() => familyQuery(entityId), [entityId])
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Forks"
      description="Edit each card independently. Changes to one leave the others as they are."
    >
      <AsyncView atom={atom} loading="Loading the family…">
        {(family) => <FamilyTree family={family} entityId={entityId} />}
      </AsyncView>
    </Dialog>
  )
}
export function Provenance({ entityId }: CardSurfaceContext) {
  const result = useAtomValue(useMemo(() => familyQuery(entityId), [entityId]))
  if (!AsyncResult.isSuccess(result)) return null
  const family = result.value
  const member = family.members.find((m) => m.entityId === entityId)
  const parent = family.members.find((m) => m.entityId === member?.parentEntityId)
  return (
    <div className="flex flex-col gap-1 text-sm text-muted">
      {parent && (
        <p className="flex flex-wrap gap-1">
          Forked from <MemberLink member={parent} />
        </p>
      )}
      {member?.forkedInChatId && (
        <p>
          Made for <ChatLink chatId={member.forkedInChatId} />.
        </p>
      )}
    </div>
  )
}
function ChatLink({ chatId }: { chatId: NonNullable<FamilyMember["forkedInChatId"]> }) {
  const result = useAtomValue(useMemo(() => AppClient.query("GetChat", { chatId }), [chatId]))
  return (
    <Link to="/chats/$chatId" params={{ chatId }} className="text-accent hover:underline">
      {AsyncResult.isSuccess(result) ? result.value.title || "Untitled chat" : "the chat"}
    </Link>
  )
}
/**
 * Which cards have a fork family, for every badge at once: a grid of hundreds of cards made
 * one CardFamily read per tile (1,257 on one home load at 420 cards). The tree is read when opened.
 */
const familyIndexAtom = AppClient.query("CardFamilyIndex", undefined, { reactivityKeys: ["library"] })

export function ForkBadge({ entityId, label }: CardSurfaceContext) {
  const index = useAtomValue(familyIndexAtom)
  const [open, setOpen] = useState(false)
  const entry = AsyncResult.isSuccess(index) ? index.value.find((card) => card.entityId === entityId) : undefined
  if (entry === undefined) return null
  const children = entry.forks
  return (
    <>
      {/* A badge that opens the family tree: shaped like the other badges beside it. */}
      <button
        type="button"
        className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-border px-2 text-xs font-medium whitespace-nowrap text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
        onClick={() => setOpen(true)}
        aria-label={label === undefined ? "Forks of this card" : `Forks of ${label}`}
      >
        <Icon name="branch" size={12} />
        {children ? `${children} ${children === 1 ? "fork" : "forks"}` : "Fork"}
      </button>
      {open && <FamilyDialog entityId={entityId} onClose={() => setOpen(false)} />}
    </>
  )
}
/** What each command does, beside its button or menu item. */
const EXPLAIN = {
  fork: "Makes an independent copy of the card, in its family, to change on its own.",
  family: "Every card of this card's family: the one it came from and its forks.",
  compareParent: "The saved fields where it differs from the card it was forked from.",
  compareFamily: "The saved fields where it differs from another card of its family.",
  parent: "Records another card as the one it was forked from. Neither card's content changes.",
  unlink: "Forgets which card it was forked from. Neither card's content changes."
} as const

export function ForkCommand({
  entityId,
  store,
  command
}: CardSurfaceContext & { command: "fork" | "family" | "compare" | "parent" | "unlink" }) {
  const result = useAtomValue(useMemo(() => familyQuery(entityId), [entityId]))
  const [open, setOpen] = useState<"fork" | "family" | "compare" | "parent" | null>(null)
  const [forkStore, setForkStore] = useState<EditorStore | null>(null)
  const action = useAction()
  const call = useCaller()
  const user = useSession().user.id
  const [loading, setLoading] = useState(false)
  const family = AsyncResult.isSuccess(result) ? result.value : null
  const member = family?.members.find((m) => m.entityId === entityId)
  const fork = async () => {
    if (store) {
      setOpen("fork")
      return
    }
    if (!member?.refId) return
    setLoading(true)
    const next = new EditorStore(member.refId, user, call)
    await next.load()
    setLoading(false)
    setForkStore(next)
    setOpen("fork")
  }
  return (
    <>
      {command === "fork" && (
        <Button disabled={!member?.refId} pending={loading} hint={EXPLAIN.fork} onClick={() => void fork()}>
          Fork
        </Button>
      )}
      {command === "family" && (
        <Button disabled={!family} hint={EXPLAIN.family} onClick={() => setOpen("family")}>
          Forks
        </Button>
      )}
      {command === "compare" && (
        <Button
          disabled={!family || family.members.length < 2}
          hint={member?.parentEntityId ? EXPLAIN.compareParent : EXPLAIN.compareFamily}
          onClick={() => setOpen("compare")}
        >
          {member?.parentEntityId ? "Compare with parent" : "Compare with family"}
        </Button>
      )}
      {command === "parent" && (
        <Button hint={EXPLAIN.parent} onClick={() => setOpen("parent")}>
          Mark as a fork of…
        </Button>
      )}
      {command === "unlink" && member?.parentEntityId && (
        <Button
          pending={action.pending}
          hint={EXPLAIN.unlink}
          onClick={() =>
            void action.run((api) => api("SetCardParent", { entityId, parentEntityId: null }), ["library"])
          }
        >
          Unlink
        </Button>
      )}
      <ErrorAlert error={action.error} />
      {open === "fork" && (store || forkStore)?.snapshot && (
        <ForkDialog store={(store || forkStore)!} onClose={() => setOpen(null)} />
      )}
      {open === "fork" && forkStore?.loadError && <ErrorAlert error={forkStore.loadError} />}
      {open === "family" && <FamilyDialog entityId={entityId} onClose={() => setOpen(null)} />}
      {open === "parent" && <ParentDialog entityId={entityId} onClose={() => setOpen(null)} />}
      {open === "compare" && family && member && (
        <CompareDialog family={family} member={member} onClose={() => setOpen(null)} />
      )}
    </>
  )
}
type Command = "fork" | "family" | "compare" | "parent" | "unlink"
const useMember = (entityId: EntityId) => {
  const result = useAtomValue(useMemo(() => familyQuery(entityId), [entityId]))
  const family = AsyncResult.isSuccess(result) ? result.value : null
  return { family, member: family?.members.find((m) => m.entityId === entityId) }
}
/** A command's item in a card's overflow menu; its dialog is `ForkMenuDialog`, mounted by the host. */
export function ForkMenuItem({ entityId, openDialog, command }: CardMenuProps & { command: Command }) {
  const { family, member } = useMember(entityId)
  const action = useAction()
  if (command === "fork")
    return (
      <MenuItem icon="branch" disabled={!member?.refId} description={EXPLAIN.fork} onClick={openDialog}>
        Fork…
      </MenuItem>
    )
  if (command === "family")
    return (
      <MenuItem disabled={!family} description={EXPLAIN.family} onClick={openDialog}>
        Forks
      </MenuItem>
    )
  if (command === "compare")
    return (
      <MenuItem
        icon="compare"
        disabled={!family || family.members.length < 2}
        description={member?.parentEntityId ? EXPLAIN.compareParent : EXPLAIN.compareFamily}
        onClick={openDialog}
      >
        {member?.parentEntityId ? "Compare with parent" : "Compare with family"}
      </MenuItem>
    )
  if (command === "parent")
    return (
      <MenuItem description={EXPLAIN.parent} onClick={openDialog}>
        Mark as a fork of…
      </MenuItem>
    )
  if (!member?.parentEntityId) return null
  return (
    <MenuItem
      description={EXPLAIN.unlink}
      onClick={() =>
        void action
          .run((api) => api("SetCardParent", { entityId, parentEntityId: null }), ["library"])
          .then(
            (result) =>
              !result.ok && showToast({ title: "Couldn’t unlink the card", description: result.error.message })
          )
      }
    >
      Unlink from parent
    </MenuItem>
  )
}
export function ForkMenuDialog({ entityId, store, closeDialog, command }: CardMenuProps & { command: Command }) {
  const { family, member } = useMember(entityId)
  if (command === "fork")
    return <ForkFromMenu entityId={entityId} {...(store ? { store } : {})} onClose={closeDialog} />
  if (command === "family") return <FamilyDialog entityId={entityId} onClose={closeDialog} />
  if (command === "parent") return <ParentDialog entityId={entityId} onClose={closeDialog} />
  if (command === "compare" && family && member)
    return <CompareDialog family={family} member={member} onClose={closeDialog} />
  return null
}
function ForkFromMenu({ entityId, store, onClose }: CardSurfaceContext & { onClose: () => void }) {
  const { member } = useMember(entityId)
  const call = useCaller()
  const user = useSession().user.id
  const refId = member?.refId ?? null
  const [loaded, setLoaded] = useState<EditorStore | null>(null)
  useEffect(() => {
    if (store || refId === null) return
    let live = true
    const next = new EditorStore(refId, user, call)
    void next.load().then(() => live && setLoaded(next))
    return () => {
      live = false
    }
  }, [store, refId, user, call])
  const ready = store ?? loaded
  if (ready?.snapshot) return <ForkDialog store={ready} onClose={onClose} />
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title="Fork card">
      {loaded?.loadError ? <ErrorAlert error={loaded.loadError} /> : <p className="text-muted">Loading the card…</p>}
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
  )
}
function ParentDialog({ entityId, onClose }: { entityId: EntityId; onClose: () => void }) {
  const atom = useMemo(
    () =>
      allOf({
        live: libraryListAtom("card"),
        archived: libraryListAtom("card", true)
      }),
    []
  )
  const [search, setSearch] = useState("")
  const action = useAction()
  return (
    <Dialog open onOpenChange={(open) => !open && !action.pending && onClose()} title="Mark as a fork of…">
      <Field label="Parent card" about="Links this card to a parent without changing either card’s text.">
        <Input
          aria-label="Find a parent card"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder="Find a card"
        />
      </Field>
      <AsyncView atom={atom} loading="Loading cards…">
        {(lists) => {
          const cards = [...lists.live, ...lists.archived]
          const current = cards.find((c) => c.entityId === entityId)
          const candidates = cards
            .filter(
              (c) =>
                c.entityId !== entityId &&
                [c.label, c.subtitle, c.modelName ?? ""].some((value) =>
                  value.toLowerCase().includes(search.trim().toLowerCase())
                )
            )
            .sort(
              (a, b) =>
                Number(b.label === current?.label) - Number(a.label === current?.label) ||
                a.label.localeCompare(b.label)
            )
          return (
            <ul aria-label="Parent cards" className="flex max-h-80 flex-col gap-2 overflow-auto p-2">
              {candidates.map((card) => (
                <li key={card.id}>
                  <Button
                    className="h-auto! min-h-11 whitespace-normal! text-left"
                    disabled={action.pending}
                    onClick={() =>
                      void action
                        .run((api) => api("SetCardParent", { entityId, parentEntityId: card.entityId }), ["library"])
                        .then((r) => {
                          if (r.ok) onClose()
                        })
                    }
                  >
                    {card.label}
                    {card.subtitle && ` · ${card.subtitle}`}
                  </Button>
                </li>
              ))}
              {!candidates.length && <li>No matching cards.</li>}
            </ul>
          )
        }}
      </AsyncView>
      <ErrorAlert error={action.error} />
      <DialogActions>
        <Button disabled={action.pending} onClick={onClose}>
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  )
}
function CompareDialog({ family, member, onClose }: { family: CardFamily; member: FamilyMember; onClose: () => void }) {
  const [targetId, setTargetId] = useState(
    member.parentEntityId ?? family.members.find((m) => m.entityId !== member.entityId)!.entityId
  )
  const target = family.members.find((m) => m.entityId === targetId)!
  return (
    <Dialog
      wide
      open
      onOpenChange={(open) => !open && onClose()}
      title={member.parentEntityId ? "Compare with parent" : "Compare with family"}
      description="Compare the last saved versions; drafts are left out. Removed text is from the selected card, added text from this card."
    >
      <Field label="Compare this card with">
        <Select
          value={targetId}
          onValueChange={setTargetId}
          items={family.members
            .filter((m) => m.entityId !== member.entityId)
            .map((m) => ({ value: m.entityId, label: `${name(m)}${m.state !== "live" ? ` (${m.state})` : ""}` }))}
        />
      </Field>
      {target?.refId && member.refId && ["live", "archived"].includes(target.state) ? (
        <Comparison key={`${targetId}/${member.refId}`} before={target.refId} after={member.refId} />
      ) : (
        <p className="text-sm text-muted">
          {target?.state === "binned"
            ? "This card’s saved content is unavailable. Restore it from the bin to compare."
            : "This card’s saved content is unavailable; it was deleted for good or is no longer in this family."}
        </p>
      )}
    </Dialog>
  )
}
function Comparison({ before, after }: { before: RefId; after: RefId }) {
  const a = useMemo(() => AppClient.query("OpenEditor", { refId: before }, { reactivityKeys: ["library"] }), [before])
  const b = useMemo(() => AppClient.query("OpenEditor", { refId: after }, { reactivityKeys: ["library"] }), [after])
  return (
    <AsyncView atom={a} loading="Reading comparison…">
      {(left) => (
        <AsyncView atom={b} loading="Reading this card…">
          {(right) => {
            const changes = changedFields(left.doc, right.doc)
            return (
              <div aria-label="Card differences" className="flex flex-col gap-4">
                {changes.length ? (
                  changes.map((change) => (
                    <section key={JSON.stringify(change.path)}>
                      <h3 className="mb-1 text-sm font-medium">{fieldLabel("card", right.doc, change.path)}</h3>
                      <ValueDiff before={change.before} after={change.after} rich />
                    </section>
                  ))
                ) : (
                  <p>The saved cards are identical.</p>
                )}
              </div>
            )
          }}
        </AsyncView>
      )}
    </AsyncView>
  )
}
