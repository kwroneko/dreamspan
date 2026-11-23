// A workshop before it exists (owner, 2026-11-17: "It should be a chat UI already open with the
// composer ... The chat is created when the first message is sent."): the chat's own surface at
// once, a brief intro where its messages will be, and the saved workshop's composer, focused:
// the speaker chip (with Your persona), Guidance, Generate and Send in the box, and the strip's
// model, preset and capability chips. What's chosen there before the first send (the speaker,
// guidance, the persona, the preset, what the assistant may do) is held here, as a pending story
// chat holds its choices (`PendingChat`), and the first send makes the workshop with them in one
// action, as that chat's first send makes it (StartChatPage.tsx): `CreateWorkshop` (with the
// preset and grants), then the message and its reply or, with Generate, the turn asked for,
// then the new chat's path and cast seeded (`seedChat`), so it opens on them with nothing
// loading in between. What's typed is kept as a pending chat's first message is (`useUserDraft`).
// Used beside a story (`PendingSideChat`, the Workshop tab) and on its own page (StartWorkshopPage.tsx).
import type { CastCard, Chat, ChatId, EntityId, ForkId } from "@dreamspan/shared/chat.ts"
import type { Draft } from "@dreamspan/shared/drafts.ts"
import { BUILTIN_PRESET_LABEL } from "@dreamspan/shared/generation.ts"
import type { WorkshopPresetChoice } from "@dreamspan/shared/workshopApi.ts"
import { useAtomValue } from "@effect/atom-react"
import { Effect, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type CSSProperties, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { useSession } from "../../session.ts"
import { AutoGrowTextarea } from "../../ui/AutoGrowTextarea.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { keepCopy } from "../editor/backup.ts"
import { useCaller } from "../editor/caller.ts"
import { useUserDraft, UserDraftNotices, UserDraftUndo } from "../editor/userDraft.tsx"
import { CastContext, castView } from "../chat/cast.ts"
import { ComposerBox, useCompactComposer } from "../chat/Composer.tsx"
import { composerCarryCopy } from "../chat/composerCarry.ts"
import { composerSubmitKey } from "../chat/composerKeys.ts"
import { composerKeyDown } from "../chat/composerKeys.ts"
import type { DraftPreviewState } from "../chat/draftRequest.tsx"
import { ModelChip } from "../chat/GenerationControls.tsx"
import { kindRootProps, useChatKindLook } from "../chat/kindLooks.ts"
import { ChipText, chipClass, LoadingChip, StripRow } from "../chat/nextReplyStrip.tsx"
import {
  invokePendingComposer,
  PendingComposerControls,
  type PendingComposerContext
} from "../chat/pendingComposerControls.tsx"
import { pendingView } from "../chat/pendingChat.ts"
import { planReply } from "../chat/replyPolicy.ts"
import { seedChat } from "../chat/session.ts"
import { PresetPickerPopover } from "../pickers/PresetPicker.tsx"
import { BUILTIN, type PresetSelection, usePresetSelection } from "../pickers/presetSelection.ts"
import { PendingCapabilityChip } from "./CapabilityChip.tsx"
import { PendingSubagentModelsChip } from "./SubagentModelsChip.tsx"
import type { PendingGrants } from "./capabilities.ts"
import { pendingWorkshopCopy, SIDE_CHATS_KEY } from "./sideChat.ts"
import { workshopDefaultsAtom } from "./workshopPersona.tsx"
import { NO_PERSONA } from "./workshopStart.ts"

/** Who a new workshop starts with: "" the workshop default; the persona's `NO_PERSONA` for none. */
export interface WorkshopStart {
  /** The assistant's card, an entity id. */
  readonly card: string
  /** The persona, an entity id, or `NO_PERSONA`. */
  readonly persona: string
}

/** The preset chosen before the first send: the workshop default until one is picked. */
type PresetChoice = { readonly _tag: "Default" } | WorkshopPresetChoice

/** No first-request preview for a workshop: its request is the agent's, built as it runs. */
const NO_DRAFT: DraftPreviewState = { preview: null, loading: false, error: null, openRequest: () => {} }

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
      place="workshop"
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

/** The user's cards, read once (and again when the persona picker opens), for the speaker chip. */
function useCards() {
  const call = useCaller()
  const [cards, setCards] = useState<ReadonlyArray<CastCard>>([])
  const list = useMemo(
    () => async () => {
      const result = await call((client) => client("ListCards", undefined))
      if (result.ok) setCards(result.value)
      return result
    },
    [call]
  )
  useEffect(() => {
    let live = true
    void call((client) => client("ListCards", undefined)).then((result) => {
      if (live && result.ok) setCards(result.value)
    })
    return () => {
      live = false
    }
  }, [call])
  return { cards, list }
}

export function PendingWorkshop({
  attachTo = null,
  attachFork = null,
  title,
  start,
  onPersona,
  header,
  intro,
  copyKey,
  portraitWidth = 48,
  onCreated,
  onTitleSent
}: {
  /** The story it's beside: a side chat (spec/WORKSHOP.md §4). */
  attachTo?: ChatId | null
  /** The story branch shown: the workshop's first branch goes with it (spec/WORKSHOP-BRANCHES.md §8.1). */
  attachFork?: ForkId | null
  /** Its title, typed before the first send ("" the server's default). */
  title?: string
  start: WorkshopStart
  /** The persona picked at the speaker chip's Your persona: this workshop's only. */
  onPersona: (persona: string) => void
  header: ReactNode
  /** What stands where its messages will be until the first send. */
  intro: ReactNode
  /** Where the first message typed is kept. */
  copyKey: string
  portraitWidth?: number
  /** The workshop the first send made, its path and cast seeded for its session. */
  onCreated: (chat: Chat) => void | Promise<void>
  /** The title typed was used: its draft can end. */
  onTitleSent?: () => Promise<unknown>
}) {
  const composerId = useId()
  const action = useAction()
  const viewPrefs = useViewPrefs()
  const userId = useSession().user.id
  const { compact, ref: composerRef } = useCompactComposer()
  const kindRoot = kindRootProps(useChatKindLook("workshop"))
  const durable = useUserDraft(copyKey, "First message", "")
  // The box shows the draft store's text: reconciled with this browser's and the server's copies.
  const text = durable.text
  const [presetChoice, setPresetChoice] = useState<PresetChoice>({ _tag: "Default" })
  const preset = usePendingPresetSelection(presetChoice, setPresetChoice)
  const [grants, setGrants] = useState<PendingGrants>(new Map())
  const [guidance, setGuidance] = useState(false)
  // The speaker picked at the chip; none: the persona, as a saved workshop's composer starts.
  const [picked, setPicked] = useState<EntityId | null>(null)
  // A workshop made by a send whose message didn't go: the next send uses it, not another.
  const made = useRef<Chat | null>(null)

  // Its cast as the saved workshop's will be: the assistant, and the persona the user plays.
  const defaultsResult = useAtomValue(workshopDefaultsAtom)
  const defaults = AsyncResult.isSuccess(defaultsResult) ? defaultsResult.value : null
  const { cards, list } = useCards()
  const assistantId = start.card || defaults?.card || null
  const personaId = start.persona === NO_PERSONA ? null : start.persona || defaults?.persona || null
  const assistant = cards.find((card) => card.entityId === assistantId) ?? null
  const playing = cards.find((card) => card.entityId === personaId && card.persona) ?? null
  const view = useMemo(
    () => pendingView(assistant && assistant.entityId !== playing?.entityId ? [assistant] : [], playing),
    [assistant, playing]
  )
  const cast = useMemo(() => castView(view.cast), [view.cast])
  const castCards = view.cast?.cards ?? []
  const speakerId = castCards.some((card) => card.entityId === picked) ? picked : (playing?.entityId ?? null)
  const speakerName = castCards.find((card) => card.entityId === speakerId)?.name ?? "You"

  const busy = action.pending
  const ready = viewPrefs.ready && durable.ready
  const send = async (first: "send" | "generate") => {
    const submitted = text
    if (busy || !ready || (first === "send" && submitted.trim() === "")) return
    // Generate with guidance off leaves the text, which goes along to the saved composer.
    const consumed = first === "send" || guidance
    const result = await action.run(
      (client) =>
        Effect.gen(function* () {
          const chat =
            made.current ??
            (yield* client("CreateWorkshop", {
              ...(attachTo === null ? {} : { attachTo }),
              ...(attachFork ? { attachFork } : {}),
              ...(title === undefined || title.trim() === "" ? {} : { title }),
              ...(start.card === "" ? {} : { card: start.card }),
              ...(start.persona === "" ? {} : { persona: start.persona === NO_PERSONA ? null : start.persona }),
              ...(presetChoice._tag === "Default" ? {} : { preset: presetChoice }),
              ...(grants.size === 0 ? {} : { grants: [...grants.values()] })
            }))
          made.current = chat
          const chatId = chat.id as ChatId
          const opening = yield* client("ReadPath", {
            chatId,
            forkId: null,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 60
          })
          const madeCast = yield* client("GetCast", { chatId, slotId: opening.leafSlotId })
          // The speaker picked, if it's in the workshop as made; else its persona, as its composer's default.
          const inCast = (id: EntityId | null) =>
            id !== null && (madeCast.participants.includes(id) || madeCast.playedByMe.includes(id))
          const speaker = inCast(picked) ? picked : (madeCast.playedByMe[0] ?? null)
          let latest: Chat = chat
          if (first === "send") {
            // The message after its greeting, as its composer sends it: to the reply its turn order names.
            const plan = planReply(madeCast, opening.entries, speaker, null, submitted)
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
            if (sent._tag === "Posted") latest = sent.chat
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
          } else {
            // Generate: the speaker's turn written by the model, with guidance its one-turn direction.
            const generated = yield* client("Generate", {
              chatId,
              forkId: opening.forkId,
              parentSlotId: opening.leafSlotId,
              branch: false,
              speakerEntityId: speaker,
              ...(guidance && submitted.trim() !== "" ? { direction: submitted } : {})
            })
            if (generated._tag === "Posted") latest = generated.chat
          }
          // Its composer goes on as this one was: the speaker picked, guidance on, and text not
          // used by Generate.
          const leftover = consumed ? "" : submitted
          let composer: Draft | null = null
          if (picked !== null || guidance || leftover.trim() !== "")
            composer = yield* Effect.option(
              Effect.gen(function* () {
                const opened = yield* client("OpenComposer", { chatId, forkId: null })
                if (picked !== null || guidance)
                  yield* client("SetComposerChoice", {
                    chatId,
                    draftId: opened.id,
                    ...(guidance ? { guidance: true } : {}),
                    ...(picked !== null ? { speakerEntityId: speaker } : {})
                  })
                return opened
              })
            ).pipe(Effect.map(Option.getOrNull))
          // What its session opens on, so it shows the workshop at once rather than loading it.
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
              chat: latest,
              forkId: path.forkId,
              leafSlotId: path.leafSlotId,
              entries: path.entries,
              older: path.older,
              newer: path.newer,
              cast: atLeaf
            })
          }
          return { chat, composer, leftover }
        }),
      [SIDE_CHATS_KEY, "chats"]
    )
    if (!result.ok) return
    const { chat, composer, leftover } = result.value
    if (composer !== null && leftover.trim() !== "")
      await keepCopy(composerCarryCopy(userId, chat.id, assistantId ?? chat.id, chat.title, leftover, null, composer))
    await durable.commit(submitted, async () => true)
    await onTitleSent?.()
    await onCreated(chat)
  }

  const controls: PendingComposerContext = {
    compact,
    speaker: {
      speaker: speakerId,
      recent: [],
      pending: true,
      onPick: (card) => setPicked(card.entityId),
      // Your persona, under Speak as, as at the saved composer: it changes only this workshop.
      personas: {
        current: playing?.entityId ?? null,
        listCards: list,
        onPick: (card) => onPersona(card.entityId)
      }
    },
    speakerName,
    submitKey: composerSubmitKey(viewPrefs.prefs.enterSends),
    speakerPlayed: speakerId === null || speakerId === playing?.entityId,
    guidance,
    prefsReady: ready,
    changeGuidance: setGuidance,
    busy,
    hasText: text.trim() !== "",
    start: send,
    view,
    onSettings: () => {},
    draft: NO_DRAFT,
    adds: ""
  }

  return (
    <CastContext value={cast}>
      <div
        {...kindRoot}
        {...(attachTo === null ? {} : { "data-side-chat-pending": "" })}
        data-workshop-pending=""
        className="@container/chat flex min-h-0 flex-1 flex-col"
        style={{ ...kindRoot.style, "--chat-portrait-width": `${portraitWidth}px` } as CSSProperties}
      >
        {header}
        {/* Where its messages will be: what this is, until the first message starts it. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="chat-column flex flex-col gap-1.5 py-4">{intro}</div>
        </div>
        {/* What to know before sending, above the composer as the saved chat's notes are. */}
        <PendingComposerControls placement="notes" context={controls} />
        <div
          ref={composerRef}
          className="@container chat-column flex flex-col gap-1.5 border-t border-border pt-2 pb-2 max-sm:px-2"
        >
          <ComposerBox
            guidance={guidance}
            header={<UserDraftNotices draft={durable} />}
            start={
              <>
                <PendingComposerControls placement="speaker" context={controls} />
                <UserDraftUndo draft={durable} place="composer" />
              </>
            }
            end={
              <>
                <PendingComposerControls placement="guidance" context={controls} />
                <PendingComposerControls placement="actions" context={controls} />
              </>
            }
          >
            {guidance && (
              <span aria-hidden className="px-2 pt-0.5 text-xs font-medium text-guidance">
                Guidance
              </span>
            )}
            {/* Named on itself, not by a label's `for`: two frames can each show a composer. */}
            <AutoGrowTextarea
              autoFocus
              aria-label={guidance ? "Guidance" : "Message"}
              id={composerId}
              data-testid="composer"
              value={text}
              // The text stays in the box while its send makes the workshop, then goes with it.
              readOnly={busy || !durable.ready}
              aria-busy={busy || !durable.ready}
              placeholder={!durable.ready ? "Loading…" : guidance ? "Guidance for the next message…" : "Message…"}
              onKeyDown={(event) =>
                composerKeyDown(async () => {
                  await invokePendingComposer(controls)
                }, viewPrefs.prefs.enterSends)(event)
              }
              onChange={(event) => durable.setText(event.currentTarget.value)}
            />
          </ComposerBox>
          <ErrorAlert error={action.error} />
          <StripRow scroll={compact}>
            <ModelChip session={null} view={view} onSettings={() => {}} />
            <PendingSubagentModelsChip attachTo={attachTo} grants={grants} />
            <PendingPresetChip selection={preset} />
            <PendingCapabilityChip attachTo={attachTo} grants={grants} onGrants={setGrants} />
          </StripRow>
        </div>
      </div>
    </CastContext>
  )
}

/** What the tab says before the workshop exists: what it is, and that the story stays as it is. */
const SIDE_CHAT_INTRO =
  "Talk about this story with an assistant, out of character. It reads the branch shown here, up to its newest message; nothing said here reaches the story. Your first message starts the workshop."

/** The workshop beside a story before it exists: the Workshop tab's chat surface (SidePanel.tsx). */
export function PendingSideChat({
  story,
  attachFork,
  header,
  onCreated
}: {
  /** The story it's beside. */
  story: { readonly id: ChatId }
  /** The story branch shown: the workshop's first branch goes with it. */
  attachFork: ForkId | null
  header: ReactNode
  onCreated: (chat: Chat) => void
}) {
  // Beside a story it's the workshop default card; the persona can change from the speaker chip.
  const [persona, setPersona] = useState("")
  return (
    <PendingWorkshop
      attachTo={story.id}
      attachFork={attachFork}
      start={{ card: "", persona }}
      onPersona={setPersona}
      header={header}
      copyKey={pendingWorkshopCopy(story.id)}
      onCreated={onCreated}
      intro={
        <p
          data-side-chat-intro=""
          role="note"
          className="mx-3 rounded-lg bg-surface-raised px-3 py-2 text-sm text-muted"
        >
          {SIDE_CHAT_INTRO}
        </p>
      }
    />
  )
}
