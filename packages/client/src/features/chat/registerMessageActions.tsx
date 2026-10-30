import { ForkNotesDialog } from "./ForkNotesDialog.tsx"
import { Link } from "@tanstack/react-router"
import { useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { MenuItem, MenuLinkItem, MenuSeparator } from "../../ui/Menu.tsx"
import { Select } from "../../ui/Select.tsx"
import { IconButton, iconButtonClass, Tooltip } from "../../ui/Tooltip.tsx"
import { canContinue, ContinueAction, runContinue } from "./ContinueAction.tsx"
import { copy } from "./copy.ts"
import { parseModelValue, useModelChoices } from "./modelChoices.ts"
import { invokeMessageAction, messageActions, type MessageActionProps } from "./messageActions.tsx"
import type { ChatSession } from "./session.ts"

/**
 * "Regenerate with…": a new version of the message from a model the user picks, from the
 * same list as "Retry with…". Mounted only while open, so rows don't follow the session.
 */
function RegenerateWith({
  session,
  title,
  onClose,
  onPick
}: {
  session: ChatSession
  title: string
  onClose: () => void
  onPick: (model: ReturnType<typeof parseModelValue>) => void
}) {
  const models = useModelChoices(true)
  // The model the chat goes on using, named, so the choice here reads as a one-off.
  const effective = useSyncExternalStore(session.subscribe, session.snapshot).history?.model
  const chatModel =
    effective?.connectionName && effective.modelKey
      ? `${effective.connectionName} · ${effective.modelKey} (${effective.scope === "chat" ? "this chat's" : "your default"})`
      : null
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      description={`A new version of this message, written by the model you pick. The chat keeps its own model${
        chatModel ? `: ${chatModel}` : ""
      }.`}
    >
      {models.length === 0 ? (
        <p className="text-sm text-muted">Loading your models… None are listed until a connection has one.</p>
      ) : (
        <Select
          items={models}
          value={null}
          placeholder="Pick a model…"
          onValueChange={(value) => {
            onClose()
            onPick(parseModelValue(value))
          }}
        />
      )}
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
  )
}

function PickModel({ session, entry, generated, report, closeDialog }: MessageActionProps) {
  return (
    <RegenerateWith
      session={session}
      title={generated ? "Regenerate with another model" : "Generate a version with a model"}
      onClose={closeDialog}
      onPick={async (choice) => report(await session.regenerate(entry, choice))}
    />
  )
}

function Branch({ openDialog }: MessageActionProps) {
  return (
    <MenuItem icon="branch" onClick={() => openDialog("message.branch")}>
      Branch from here
    </MenuItem>
  )
}

/**
 * The fork the message is viewed in, for the inspector's links back into the chat. It isn't
 * necessarily the fork the version was generated in, nor the chat's current one.
 */
const viewedFork = (session: ChatSession) => {
  const fork = session.snapshot().forkId
  return fork === null ? {} : { fork }
}

export const registerMessageActions = () => [
  messageActions.register({
    id: "message.edit",
    order: 10,
    available: ({ generating }) => !generating,
    run: ({ session, entry }) => {
      session.openEditor({ _tag: "Edit", versionId: entry.version.id }, entry.version.content, entry.slotId)
    },
    toolbar: (context) => (
      <IconButton
        label="Edit"
        hint="Edit (ArrowUp in the empty composer; Ctrl+ArrowUp for your last message)"
        icon="edit"
        onClick={() => void invokeMessageAction("message.edit", context, "button")}
      />
    )
  }),
  messageActions.register({
    id: "message.regenerate",
    order: 20,
    toolbar: ({ generated, session, entry, report }) =>
      generated ? (
        <IconButton
          label="Regenerate"
          icon="regenerate"
          onClick={async () => report(await session.regenerate(entry))}
        />
      ) : null,
    menu: ({ generated, session, entry, report }) =>
      !generated ? (
        <MenuItem icon="regenerate" onClick={async () => report(await session.regenerate(entry))}>
          Generate a version
        </MenuItem>
      ) : null
  }),
  messageActions.register({
    id: "message.continue",
    order: 30,
    available: canContinue,
    run: runContinue,
    toolbar: ContinueAction
  }),
  messageActions.register({
    id: "message.context",
    order: 40,
    available: ({ entry }) => entry.version.context !== null,
    toolbar: ({ session, entry }) => (
      <Tooltip label="Request it was generated from">
        <Link
          to="/chats/$chatId/context/$versionId"
          params={{ chatId: session.id, versionId: entry.version.id }}
          search={viewedFork(session)}
          aria-label="Request it was generated from"
          className={iconButtonClass()}
        >
          <Icon name="layers" />
        </Link>
      </Tooltip>
    ),
    menu: ({ session, entry }) => (
      <MenuLinkItem
        icon="layers"
        render={
          <Link
            to="/chats/$chatId/context/$versionId"
            params={{ chatId: session.id, versionId: entry.version.id }}
            search={viewedFork(session)}
          />
        }
      >
        Context it was generated from
      </MenuLinkItem>
    )
  }),
  messageActions.register({
    id: "message.delete",
    order: 50,
    toolbar: ({ entry, session, toast }) => (
      <IconButton
        label={entry.versionCount > 1 ? "Delete version" : "Delete message"}
        icon="trash"
        tone="danger"
        onClick={async () =>
          toast(
            entry.versionCount > 1
              ? await session.deleteVersion(entry.version.id)
              : await session.deleteMessage(entry.slotId)
          )
        }
      />
    )
  }),
  messageActions.register({
    id: "message.write-version",
    order: 0,
    menu: ({ session, entry }) => (
      <MenuItem
        icon="write"
        onClick={() => session.openEditor({ _tag: "Write", slotId: entry.slotId }, "", entry.slotId)}
      >
        Write your own version
      </MenuItem>
    )
  }),
  messageActions.register({
    id: "message.regenerate-with",
    order: 25,
    menu: ({ generated, openDialog }) => (
      <MenuItem icon="regenerate" onClick={() => openDialog("message.regenerate-with")}>
        {generated ? "Regenerate with…" : "Generate a version with…"}
      </MenuItem>
    ),
    dialog: PickModel
  }),
  messageActions.register({ id: "message.branch", order: 30, menu: Branch, dialog: ForkNotesDialog }),
  messageActions.register({
    id: "message.visibility",
    order: 35,
    menu: ({ hidden, session, entry, report }) => (
      <MenuItem icon={hidden ? "eye" : "ghost"} onClick={async () => report(await session.setHidden(entry, !hidden))}>
        {hidden ? "Show to the model again" : "Hide from the model"}
      </MenuItem>
    )
  }),
  messageActions.register({
    id: "message.copy-text",
    order: 36,
    menu: ({ session, entry }) => (
      <MenuItem icon="copy" onClick={() => void copy(session.textOf(entry.version), "Text")}>
        Copy text
      </MenuItem>
    )
  }),
  messageActions.register({
    id: "message.copy-link",
    order: 37,
    menu: ({ session, entry, branchFork }) => (
      <MenuItem
        icon="link"
        onClick={() => {
          const url = new URL(`/chats/${session.id}`, window.location.origin)
          url.searchParams.set("slot", entry.slotId)
          if (branchFork !== null) url.searchParams.set("fork", branchFork)
          void copy(url.toString(), "Link")
        }}
      >
        Copy link
      </MenuItem>
    )
  }),
  messageActions.register({
    id: "message.delete-all",
    order: 60,
    available: ({ entry }) => entry.versionCount > 1,
    menu: ({ session, entry, toast }) => (
      <>
        <MenuSeparator />
        <MenuItem icon="trash" tone="danger" onClick={async () => toast(await session.deleteMessage(entry.slotId))}>
          Delete message (all {entry.versionCount} versions)
        </MenuItem>
      </>
    )
  })
]
