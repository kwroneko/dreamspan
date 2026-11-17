// A workshop beside a story before it exists (owner, 2026-11-17: "It should be a chat UI already
// open with the composer ... The chat is created when the first message is sent."). The Workshop
// tab shows the chat's own surface at once: a brief intro where its messages will be, and its
// composer, focused, with the strip's model and preset. The first send makes the workshop and sends
// the message in one action, as a pending story chat's first send makes the chat (StartChatPage.tsx):
// `CreateWorkshop`, the message and its reply, then the new chat's path and cast seeded
// (`seedChat`), so the workshop opens on them with nothing loading in between. What's typed is
// kept as a pending chat's first message is (`useUserDraft`), under the story's pending copy.
import type { Chat, ChatId, ForkId } from "@rp/shared/chat.ts"
import { BUILTIN_PRESET_LABEL } from "@rp/shared/generation.ts"
import type { WorkshopPresetChoice } from "@rp/shared/workshopApi.ts"
import { useAtomValue } from "@effect/atom-react"
import { Effect, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type CSSProperties, type ReactNode, useId, useRef, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { AutoGrowTextarea } from "../../ui/AutoGrowTextarea.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { SquareIconButton } from "../../ui/Tooltip.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { useUserDraft, UserDraftNotices, UserDraftUndo } from "../editor/userDraft.tsx"
import { ComposerBox, useCompactComposer } from "../chat/Composer.tsx"
import { composerKeyDown, composerSubmitHint } from "../chat/composerKeys.ts"
import { ModelChip } from "../chat/GenerationControls.tsx"
import { SendIcon } from "../chat/icons.tsx"
import { kindRootProps, useChatKindLook } from "../chat/kindLooks.ts"
import { ChipText, chipClass, LoadingChip, StripRow } from "../chat/nextReplyStrip.tsx"
import { planReply } from "../chat/replyPolicy.ts"
import { type ChatSession, type ChatView, seedChat } from "../chat/session.ts"
import { PresetPickerPopover } from "../pickers/PresetPicker.tsx"
import { BUILTIN, type PresetSelection, usePresetSelection } from "../pickers/presetSelection.ts"
import { pendingWorkshopCopy, SIDE_CHATS_KEY } from "./sideChat.ts"
import { workshopDefaultsAtom } from "./workshopPersona.tsx"

/** What the tab says before the workshop exists: what it is, and that the story stays as it is. */
const SIDE_CHAT_INTRO =
  "Talk about this story with an assistant, out of character. It reads the branch shown here, up to its newest message; nothing said here reaches the story. Your first message starts the workshop."

/** The chat surface's view before there's a chat: nothing loading, no cast yet. */
const NO_CHAT: ChatView = {
  chat: null,
  forkId: null,
  leafSlotId: null,
  entries: [],
  branchNames: new Map(),
  older: null,
  newer: null,
  follow: true,
  opened: 0,
  pathRevision: 0,
  loading: false,
  error: null,
  deleted: false,
  cast: null,
  queue: [],
  cache: null,
  history: null,
  lcm: null,
  lcmVersion: 0,
  lcmViewer: null,
  highlight: null
}

/** The preset chosen before the first send: the workshop default until one is picked. */
type PresetChoice = { readonly _tag: "Default" } | WorkshopPresetChoice

/**
 * The preset picker's selection before the workshop exists. Kept for this workshop (locked, as a
 * new workshop's preset is): the workshop default, or the one picked here, only for this one.
 * Unlocked: the account's preset, chosen as the composer chooses it.
 */
function usePendingPresetSelection(choice: PresetChoice, setChoice: (next: PresetChoice) => void): PresetSelection {
  const account = usePresetSelection(null)
  const defaults = useAtomValue(workshopDefaultsAtom)
  const stored = AsyncResult.isSuccess(defaults) ? defaults.value.preset : undefined
  if (choice._tag === "Account")
    return {
      ...account,
      lock: {
        locked: false,
        disabled: false,
        change: (on) => {
          if (on) setChoice({ _tag: "Lock", ref: account.value === BUILTIN ? null : account.value })
        }
      }
    }
  // The workshop default is null before the first workshop, which makes it.
  const chosen = choice._tag === "Lock" ? (choice.ref ?? BUILTIN) : stored
  const current =
    chosen == null || chosen === BUILTIN
      ? null
      : (account.live.find((ref) => ref.id === chosen) ?? account.archived.find((ref) => ref.id === chosen) ?? null)
  const loaded = account.loaded && chosen !== undefined
  return {
    ...account,
    lock: { locked: true, disabled: false, change: (on) => void (on || setChoice({ _tag: "Account" })) },
    loaded,
    value: chosen ?? "",
    current,
    label: !loaded ? null : chosen === BUILTIN ? BUILTIN_PRESET_LABEL : (current?.label ?? "Workshop preset"),
    choose: (value) => {
      setChoice(value === BUILTIN ? { _tag: "Lock", ref: null } : { _tag: "Lock", ref: value })
      return Promise.resolve(true)
    }
  }
}

/** The strip's preset chip before the workshop exists, as the saved workshop's (locked to it). */
function PendingPresetChip({ selection }: { selection: PresetSelection }) {
  const label = selection.label
  if (!selection.loaded || label === null) return <LoadingChip label="Prompt preset" />
  return (
    <PresetPickerPopover
      selection={selection}
      triggerLabel={`Prompt preset: ${label}. Change the preset`}
      hint={`Prompt preset for this workshop's replies: ${label}`}
      triggerClassName={chipClass()}
      trigger={
        <>
          {selection.lock?.locked && (
            <span role="img" aria-label="Preset locked for this chat">
              <Icon name="lock" size={12} />
            </span>
          )}
          <ChipText>{label}</ChipText>
        </>
      }
    />
  )
}

export function PendingSideChat({
  story,
  attachFork,
  header,
  onCreated
}: {
  /** The story it's beside. */
  story: ChatSession
  /** The story branch shown: the workshop's first branch goes with it (spec/WORKSHOP-BRANCHES.md §8.1). */
  attachFork: ForkId | null
  header: ReactNode
  /** The workshop the first send made, its path and cast seeded for its session. */
  onCreated: (chat: Chat) => void
}) {
  const composerId = useId()
  const action = useAction()
  const viewPrefs = useViewPrefs()
  const { compact, ref: composerRef } = useCompactComposer()
  const kindRoot = kindRootProps(useChatKindLook("workshop"))
  const durable = useUserDraft(pendingWorkshopCopy(story.id), "First message", "")
  // The box shows the draft store's text: reconciled with this browser's and the server's copies.
  const text = durable.text
  const [presetChoice, setPresetChoice] = useState<PresetChoice>({ _tag: "Default" })
  const preset = usePendingPresetSelection(presetChoice, setPresetChoice)
  // A workshop made by a send whose message didn't go: the next send uses it, not another.
  const made = useRef<Chat | null>(null)

  const busy = action.pending
  const ready = viewPrefs.ready && durable.ready
  const send = async () => {
    const submitted = text
    if (busy || !ready || submitted.trim() === "") return
    const result = await action.run(
      (client) =>
        Effect.gen(function* () {
          const chat =
            made.current ??
            (yield* client("CreateWorkshop", {
              attachTo: story.id,
              ...(attachFork ? { attachFork } : {}),
              ...(presetChoice._tag === "Default" ? {} : { preset: presetChoice })
            }))
          made.current = chat
          const chatId = chat.id as ChatId
          // The message after its greeting, as its composer sends it: as the workshop persona,
          // to the reply its turn order names.
          const opening = yield* client("ReadPath", {
            chatId,
            forkId: null,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 60
          })
          const cast = yield* client("GetCast", { chatId, slotId: opening.leafSlotId })
          const speaker = cast.playedByMe[0] ?? null
          const plan = planReply(cast, opening.entries, speaker, null, submitted)
          const sent = yield* client("SendMessage", {
            chatId,
            forkId: opening.forkId,
            parentSlotId: opening.leafSlotId,
            branch: false,
            content: submitted,
            speakerEntityId: speaker,
            replySpeakerEntityId: plan.replier,
            ...(plan.reply ? {} : { reply: false }),
            ...(plan.reply && plan.round.length > 0 ? { round: plan.round } : {})
          })
          // Its reply, as after any send; a server without a generator still keeps the message.
          if (sent._tag === "Posted" && plan.reply)
            yield* Effect.ignore(
              client("Generate", {
                chatId,
                forkId: opening.forkId,
                parentSlotId: sent.entry.slotId,
                branch: false,
                speakerEntityId: plan.replier,
                ...(plan.round.length > 0 ? { round: plan.round } : {})
              })
            )
          // What its session opens on, so the tab shows the workshop at once rather than loading it.
          const opened = yield* Effect.option(
            Effect.gen(function* () {
              const path = yield* client("ReadPath", {
                chatId,
                forkId: null,
                leafSlotId: null,
                range: { _tag: "Bottom" },
                limit: 60
              })
              const atLeaf = yield* client("GetCast", { chatId, slotId: path.leafSlotId })
              return { path, cast: atLeaf }
            })
          )
          if (Option.isSome(opened)) {
            const { path, cast: atLeaf } = opened.value
            seedChat(chatId, {
              chat: sent._tag === "Posted" ? sent.chat : chat,
              forkId: path.forkId,
              leafSlotId: path.leafSlotId,
              entries: path.entries,
              older: path.older,
              newer: path.newer,
              cast: atLeaf
            })
          }
          return chat
        }),
      [SIDE_CHATS_KEY, "chats"]
    )
    if (!result.ok) return
    await durable.commit(submitted, async () => true)
    onCreated(result.value)
  }

  return (
    <div
      {...kindRoot}
      data-side-chat-pending=""
      className="@container/chat flex min-h-0 flex-1 flex-col"
      style={{ ...kindRoot.style, "--chat-portrait-width": "48px" } as CSSProperties}
    >
      {header}
      {/* Where its messages will be: what this is, until the first message starts it. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="chat-column flex flex-col gap-1.5 py-4">
          <p
            data-side-chat-intro=""
            role="note"
            className="mx-3 rounded-lg bg-surface-raised px-3 py-2 text-sm text-muted"
          >
            {SIDE_CHAT_INTRO}
          </p>
        </div>
      </div>
      <div
        ref={composerRef}
        className="@container chat-column flex flex-col gap-1.5 border-t border-border pt-2 pb-2 max-sm:px-2"
      >
        <ComposerBox
          guidance={false}
          header={<UserDraftNotices draft={durable} />}
          start={<UserDraftUndo draft={durable} />}
          end={
            <SquareIconButton
              label="Send"
              hint={`Starts this workshop with your message (${composerSubmitHint(viewPrefs.prefs.enterSends)})`}
              variant="primary"
              pending={busy}
              disabled={busy || !ready || text.trim() === ""}
              className="data-disabled:bg-surface-raised! data-disabled:text-muted!"
              focusableWhenDisabled
              onClick={() => void send()}
            >
              <SendIcon />
            </SquareIconButton>
          }
        >
          {/* Named on itself, not by a label's `for`: two frames can each show a composer. */}
          <AutoGrowTextarea
            autoFocus
            aria-label="Message"
            id={composerId}
            data-testid="composer"
            value={text}
            // The text stays in the box while its send makes the workshop, then goes with it.
            readOnly={busy || !durable.ready}
            aria-busy={busy || !durable.ready}
            placeholder={durable.ready ? "Message…" : "Loading…"}
            onKeyDown={(event) => composerKeyDown(send, viewPrefs.prefs.enterSends)(event)}
            onChange={(event) => durable.setText(event.currentTarget.value)}
          />
        </ComposerBox>
        <ErrorAlert error={action.error} />
        <StripRow scroll={compact}>
          <ModelChip session={null} view={NO_CHAT} onSettings={() => {}} />
          <PendingPresetChip selection={preset} />
        </StripRow>
      </div>
    </div>
  )
}
