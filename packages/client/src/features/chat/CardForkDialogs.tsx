import { useUserDraft, UserDraftStatus } from "../editor/userDraft.tsx"
import { useSession } from "../../session.ts"
import { showCardSaved, type CardSaved } from "../editor/cardSaved.ts"
import { useAtomValue } from "@effect/atom-react"
import type { CastCard } from "@rp/shared/chat.ts"
import type { ChatCard } from "@rp/shared/chatSetupApi.ts"
import { useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useMemo, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { useCardNameCheck } from "../editor/cardNameCheck.ts"
import { flushOpenEditors, refreshOpenEditors } from "../editor/openEditors.ts"
import { usePresetWorkspace } from "../editor/PresetWorkspace.tsx"
import { usePortraitViewer } from "../../ui/Portrait.tsx"
import type { ChatSession } from "./session.ts"

/** What a card's actions need of its library entry: the ref to edit, and how far a change reaches. */
export type ChatCardInfo = Pick<ChatCard, "entityId" | "refId" | "usedByChats" | "binding">

export interface ChatCardActionProps {
  /** Null in a chat not made yet (before the first send): actions on this chat's copy aren't offered. */
  session: ChatSession | null
  card: CastCard
  info: ChatCardInfo | undefined
  /** The card the user plays here (the persona's tab): actions for a character in the chat leave it out. */
  persona?: boolean | undefined
}

/** The full card editor, over the chat (the chat stays as it was); without the workspace, its page. */
export function EditChatCard({ session, card, info }: ChatCardActionProps) {
  const navigate = useNavigate()
  const workspace = usePresetWorkspace()
  return (
    <Button
      variant="ghost"
      className="h-8! px-2!"
      aria-label={`Open ${card.name} in the full editor`}
      hint="Edit every field of the card, over the chat."
      disabled={!info}
      onClick={() => {
        if (!info) return
        if (workspace) return workspace.open(info.refId)
        void navigate({
          to: "/library/$refId",
          params: { refId: info.refId },
          ...(session === null ? {} : { search: { renameChat: session.id, renameFork: session.snapshot().forkId } })
        })
      }}
    >
      Full editor
    </Button>
  )
}
export function ForkChatCard({ session, card, info, persona }: ChatCardActionProps) {
  const [open, setOpen] = useState(false)
  if (persona || session === null) return null
  return (
    <>
      <Button
        variant="ghost"
        className="h-8! px-2!"
        disabled={!info || card.inBin}
        aria-label={`Fork for this chat: ${card.name}`}
        hint="Change the card for this branch only, as a copy."
        onClick={() => setOpen(true)}
      >
        Fork for this chat
      </Button>
      {open && info && <ChatCardForkDialog session={session} card={card} onClose={() => setOpen(false)} />}
    </>
  )
}
export function ChooseChatCard({ session, card, info, persona }: ChatCardActionProps) {
  const [open, setOpen] = useState(false)
  if (persona || session === null) return null
  return (
    <>
      <Button
        variant="ghost"
        className="h-8! px-2!"
        disabled={!info || card.inBin}
        aria-label={`Use another version: ${card.name}`}
        hint="Use another card of its family, such as a fork, on this branch."
        onClick={() => setOpen(true)}
      >
        Use another version
      </Button>
      {open && <CardVersionDialog session={session} card={card} onClose={() => setOpen(false)} />}
    </>
  )
}

function ChatCardForkDialog({ session, card, onClose }: { session: ChatSession; card: CastCard; onClose: () => void }) {
  // Keep the position the dialog was opened at even if another tab moves the chat.
  const [position] = useState(() => ({ slotId: session.snapshot().leafSlotId, forkId: session.snapshot().forkId }))
  const durable = useUserDraft(
    `chat:${session.id}:fork:${position.forkId}:card:${card.entityId}:new-fork`,
    "Names",
    JSON.stringify({ name: card.name, nickname: card.modelName ?? card.name, version: card.subtitle ?? "" })
  )
  const names = JSON.parse(durable.text) as { name: string; nickname: string; version: string }
  const { name, nickname, version } = names
  const setName = (name: string) => durable.setText(JSON.stringify({ ...names, name }))
  const setNickname = (nickname: string) => durable.setText(JSON.stringify({ ...names, nickname }))
  const setVersion = (version: string) => durable.setText(JSON.stringify({ ...names, version }))
  const clash = useCardNameCheck(name.trim(), version.trim())
  const action = useAction()
  const navigate = useNavigate()
  const userId = useSession().user.id
  const finish = (refId: string, stay = false) => {
    onClose()
    if (!stay) void navigate({ to: "/library/$refId", params: { refId } })
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !action.pending && onClose()} title="Fork for this chat">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (clash || !name.trim() || action.pending) return
          // What's typed in its notes reaches the server first: the copies take it (carryDrafts.ts).
          void durable.commit(durable.text, async () => {
            await flushOpenEditors().catch(() => undefined)
            return action
              .run(
                (client) =>
                  client("ForkCardForChat", {
                    chatId: session.id,
                    ...position,
                    entityId: card.entityId,
                    name: name.trim(),
                    nickname: nickname.trim(),
                    characterVersion: version.trim()
                  }),
                ["library", "chats", `chat-cards:${session.id}`, `chat-notes:${session.id}`]
              )
              .then((result) => {
                if (result.ok) {
                  // Its notes' unsaved text moved to the copies: open editors read again.
                  void refreshOpenEditors()
                  const change: CardSaved = {
                    entityId: result.value.entityId,
                    oldName: card.modelName ?? card.name,
                    newName: result.value.modelName ?? result.value.label,
                    ...(position.forkId ? { current: { chatId: session.id, forkId: position.forkId } } : {}),
                    onlyThis: true
                  }
                  onClose()
                  showCardSaved(userId, change, (stay) => finish(result.value.id, stay))
                }
                return result.ok
              })
          })
        }}
      >
        <UserDraftStatus draft={durable} />
        <Field label="Display name" about="Unsaved changes move to the copy; the original returns to its last save.">
          <Input required value={name} onChange={(event) => setName(event.currentTarget.value)} />
        </Field>
        <Field label="Version (shown as subtitle)" about="Change the version or display name to tell this fork apart.">
          <Input autoFocus value={version} onChange={(event) => setVersion(event.currentTarget.value)} />
        </Field>
        <Field label="In-character name" about="Used in prompts and {{char}}. Empty uses the display name.">
          <Input value={nickname} onChange={(event) => setNickname(event.currentTarget.value)} />
        </Field>
        {clash && (
          <p role="status" className="text-sm text-muted">
            {clash}
          </p>
        )}
        <ErrorAlert error={action.error} />
        <DialogActions>
          <Button onClick={onClose} disabled={action.pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" pending={action.pending} disabled={!name.trim() || clash !== null}>
            Fork and edit
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function CardVersionDialog({ session, card, onClose }: { session: ChatSession; card: CastCard; onClose: () => void }) {
  const query = useMemo(
    () => AppClient.query("CardFamily", { entityId: card.entityId }, { reactivityKeys: ["library"] }),
    [card.entityId]
  )
  const result = useAtomValue(query)
  const userId = useSession().user.id
  const portraits = usePortraitViewer()
  const [position] = useState(() => ({ forkId: session.snapshot().forkId }))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const members = AsyncResult.isSuccess(result) ? result.value.members : []
  const children = (parent: string | null): typeof members =>
    members.filter((member) => member.parentEntityId === parent)
  const tree = (parent: string | null, depth = 0): Array<{ member: (typeof members)[number]; depth: number }> =>
    children(parent).flatMap((member) => [{ member, depth }, ...tree(member.entityId, depth + 1)])
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      title="Use another version"
      description="Choose from this card’s family. Other branches keep their cards."
    >
      <ul aria-label="Card family" className="flex flex-col gap-2">
        {tree(null).map(({ member, depth }) => (
          <li key={member.entityId} style={{ paddingInlineStart: `${Math.min(depth, 6) * 12}px` }}>
            <Button
              className="h-auto! min-h-11 w-full! justify-start! py-2! whitespace-normal! text-left"
              disabled={pending || member.entityId === card.entityId || !["live", "archived"].includes(member.state)}
              onClick={() => {
                setPending(true)
                void (async () => {
                  if (session.snapshot().forkId !== position.forkId) {
                    setPending(false)
                    return setError("The branch shown changed. Close this dialog and choose again.")
                  }
                  const outcome = await session.changeCast({
                    _tag: "Swap",
                    entityId: member.entityId,
                    replaces: card.entityId
                  })
                  setPending(false)
                  if (!outcome.ok) return setError(outcome.error.message)
                  const used = outcome.value.cards.find((c) => c.entityId === member.entityId)
                  // A portrait shown of the card swapped out shows the one swapped in.
                  if (used)
                    portraits?.replace(card.entityId, {
                      id: used.entityId,
                      name: used.name,
                      mediaId: used.avatarMediaId
                    })
                  const change: CardSaved = {
                    entityId: member.entityId,
                    oldName: card.modelName ?? card.name,
                    newName: used?.modelName ?? used?.name ?? member.label,
                    ...(position.forkId ? { current: { chatId: session.id, forkId: position.forkId } } : {}),
                    onlyThis: true
                  }
                  onClose()
                  showCardSaved(userId, change, () => {})
                })()
              }}
            >
              {depth > 0 ? "↳ " : ""}
              {member.label || "Deleted card"}
              {member.subtitle && ` · ${member.subtitle}`} · {member.chats} {member.chats === 1 ? "chat" : "chats"}
              {member.entityId === card.entityId ? " · in use" : member.state !== "live" ? ` · ${member.state}` : ""}
            </Button>
          </li>
        ))}
      </ul>
      {AsyncResult.isFailure(result) && (
        <p role="alert" className="text-sm text-danger">
          The card family could not be read.
        </p>
      )}
      {!AsyncResult.isSuccess(result) && !AsyncResult.isFailure(result) && (
        <p className="text-sm text-muted">Loading…</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <DialogActions>
        <Button onClick={onClose} disabled={pending}>
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  )
}
