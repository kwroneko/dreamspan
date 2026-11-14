import { ForkNotesDialog } from "./ForkNotesDialog.tsx"
import { Link } from "@tanstack/react-router"
import { lazy, Suspense } from "react"
import { continueUnavailable, ContinueView, runContinue } from "./ContinueAction.tsx"
import { copy } from "./copy.ts"
import {
  MessageActionDialog,
  invokeMessageAction,
  type MessageActionProps,
  messageActions,
  viewOf
} from "./messageActions.tsx"
import { chatOverlays } from "./presentation.tsx"
import type { ChatSession } from "./session.ts"
import { mergesInto } from "./kindLooks.ts"

/**
 * The fork the message is viewed in, for the inspector's links back into the chat. It isn't
 * necessarily the fork the version was generated in, nor the chat's current one.
 */
const viewedFork = (session: ChatSession) => {
  const fork = session.snapshot().forkId
  return fork === null ? {} : { fork }
}

const MergeHere = lazy(() => import("./MergeChatDialog.tsx").then((m) => ({ default: m.MergeChatHereDialog })))
const MergeChatHereDialog = (props: MessageActionProps) => (
  <Suspense fallback={null}>
    <MergeHere {...props} />
  </Suspense>
)

/** Ways in besides the button, said in Edit's explanation. */
const EDIT_KEYS = "Or double-click the message; ↑ in the empty composer edits the latest message, Ctrl+↑ your own."

/**
 * The chat's message actions, in the menu's order: change this message (edit, continue, other
 * versions), put something beside it (a branch, a message), what the model sees and where it
 * came from, copy, delete. Pinned by default: Edit, Continue, Branch from here and Delete.
 */
export const registerMessageActions = () => [
  chatOverlays.register({ id: "chat.message-action-dialog", order: 10, component: MessageActionDialog }),
  messageActions.register({
    id: "message.edit",
    order: 10,
    group: "change",
    pinned: true,
    disabled: ({ generating }) => (generating ? "Wait for this reply to finish before editing it." : null),
    run: ({ session, entry }) => {
      session.openEditor({ _tag: "Edit", versionId: entry.version.id }, entry.version.content, entry.slotId)
    },
    describe: viewOf((context) => ({
      label: "Edit",
      icon: "edit",
      hint:
        context.entry.version.writer === "human" && context.entry.version.status === "complete"
          ? `Change this message's text in place. ${EDIT_KEYS}`
          : `Edit this message’s text and save a new version. ${EDIT_KEYS}`,
      onSelect: () => invokeMessageAction("message.edit", context, "button")
    }))
  }),
  messageActions.register({
    id: "message.continue",
    order: 20,
    group: "change",
    pinned: true,
    disabled: continueUnavailable,
    run: runContinue,
    describe: ContinueView
  }),
  messageActions.register({
    id: "message.write-version",
    order: 30,
    group: "change",
    describe: viewOf(({ session, entry }) => ({
      label: "Write your own version",
      icon: "write",
      hint: "Write a new version of this message, with its versions above the editor to take passages from.",
      onSelect: () => session.openEditor({ _tag: "Write", slotId: entry.slotId }, "", entry.slotId)
    }))
  }),
  // A generated message's › past its last version generates another (VersionControls.tsx), so
  // there's no Regenerate; a turn the user wrote has Generate a version here.
  messageActions.register({
    id: "message.regenerate",
    order: 50,
    group: "change",
    available: ({ generated }) => !generated,
    describe: viewOf(({ session, entry, report }) => ({
      label: "Generate a version",
      icon: "regenerate",
      hint: "Have the model write a new version of this turn as the same speaker.",
      onSelect: async () => report(await session.regenerate(entry))
    }))
  }),
  messageActions.register({
    id: "message.branch",
    onMerges: true,
    order: 60,
    group: "place",
    pinned: true,
    describe: viewOf(({ openDialog }) => ({
      label: "Branch from here",
      icon: "branch",
      hint: "Start a new branch from this message. The branch you're on keeps everything after it.",
      onSelect: () => openDialog("message.branch")
    })),
    dialog: ForkNotesDialog
  }),
  messageActions.register({
    id: "message.merge",
    dialogInUrl: true,
    order: 75,
    group: "place",
    // Not in a kind that takes no merges (a workshop): the server refuses them there.
    available: ({ entry, session }) => entry.version.origin !== "merge" && mergesInto(session.snapshot().chat),
    describe: viewOf(({ openDialog }) => ({
      label: "Merge a chat here…",
      icon: "merge",
      hint: "Brings another chat's messages into this one, after this message.",
      onSelect: () => openDialog("message.merge")
    })),
    dialog: MergeChatHereDialog
  }),
  messageActions.register({
    id: "message.visibility",
    onMerges: true,
    order: 80,
    group: "context",
    describe: viewOf(({ hidden, session, entry, report }) => ({
      label: hidden ? "Show to the model again" : "Hide from the model",
      icon: hidden ? "eye" : "ghost",
      hint: hidden
        ? "Click to send this message to the model again."
        : "Click to hide this message from the model. The message stays in the chat.",
      onSelect: async () => report(await session.setHidden(entry, !hidden))
    }))
  }),
  messageActions.register({
    id: "message.context",
    order: 90,
    group: "context",
    available: ({ entry }) => entry.version.context !== null,
    describe: viewOf(({ session, entry }) => ({
      label: "Request it was generated from",
      icon: "layers",
      hint: "See everything the model was sent for this version, and where each part came from.",
      link: (
        <Link
          to="/chats/$chatId/context/$versionId"
          params={{ chatId: session.id, versionId: entry.version.id }}
          search={viewedFork(session)}
        />
      )
    }))
  }),
  messageActions.register({
    id: "message.copy-text",
    order: 100,
    group: "copy",
    describe: viewOf(({ session, entry }) => ({
      label: "Copy text",
      icon: "clipboard",
      hint: "Copy the text of the message version shown.",
      onSelect: () => void copy(session.textOf(entry.version), "Text")
    }))
  }),
  messageActions.register({
    id: "message.copy-link",
    onMerges: true,
    order: 101,
    group: "copy",
    describe: viewOf(({ session, entry, branchFork }) => ({
      label: "Copy link",
      icon: "link",
      hint: `Copy a link that opens this chat at this message${branchFork !== null ? ", on this branch" : ""}.`,
      onSelect: () => {
        const url = new URL(`/chats/${session.id}`, window.location.origin)
        url.searchParams.set("slot", entry.slotId)
        if (branchFork !== null) url.searchParams.set("fork", branchFork)
        void copy(url.toString(), "Link")
      }
    }))
  }),
  messageActions.register({
    id: "message.delete",
    onMerges: true,
    order: 110,
    group: "delete",
    pinned: true,
    describe: viewOf(({ entry, session, toast }) =>
      entry.versionCount > 1
        ? {
            label: "Delete version",
            icon: "trash",
            tone: "danger",
            hint: "Moves this message version to the bin, from which it can be restored later.",
            onSelect: async () => toast(await session.deleteVersion(entry.version.id))
          }
        : {
            label: "Delete message",
            icon: "trash",
            tone: "danger",
            hint: "Moves this message to the bin, from which it can be restored later.",
            onSelect: async () => toast(await session.deleteMessage(entry.slotId))
          }
    )
  }),
  messageActions.register({
    id: "message.delete-all",
    order: 111,
    group: "delete",
    disabled: ({ entry }) => (entry.versionCount < 2 ? "This message has only one version; use Delete message." : null),
    describe: viewOf(({ session, entry, toast }) => ({
      label: "Delete all versions",
      icon: "trash-all",
      tone: "danger",
      hint: "Moves this message and all its versions to the bin, from which it can be restored later.",
      onSelect: async () => toast(await session.deleteMessage(entry.slotId))
    }))
  })
]
