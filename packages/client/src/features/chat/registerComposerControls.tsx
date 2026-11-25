import { QueuedMessages } from "./QueuedMessages.tsx"
import { RoundControls } from "./RoundControls.tsx"
import { type PendingComposerContext, pendingComposerControls } from "./pendingComposerControls.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { SquareIconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { CacheChip } from "./CacheIndicator.tsx"
import { ContextChip } from "./ContextChip.tsx"
import { DraftContextChip } from "./draftRequest.tsx"
import { ModelChip, PresetChip } from "./GenerationControls.tsx"
import { GenerateIcon, SendIcon } from "./icons.tsx"
import { NextReplyChip } from "./ReplyFrom.tsx"
import { SpeakerSwitcher } from "./SpeakerSwitcher.tsx"
import { composerControls } from "./composerControls.tsx"

/**
 * What the guidance toggle does, in the owner's words (2026-11-23), for the selected speaker:
 * a persona's name when you speak as yourself, "your character" when there's no name.
 */
const guidanceToggleHint = (guidance: boolean, speaker: string | null) =>
  guidance
    ? `Click to switch back to writing the message yourself. What you type is then sent as ${speaker ?? "your character"}'s message.`
    : `Click to switch to Guidance mode. In Guidance mode, you describe what ${speaker ?? "your character"} does next, and the model writes the actual turn for you.`

/** Guidance as an icon toggle in the box (DESIGN §2.2: a visible control), its name and use in the tooltip. */
function GuidanceToggle({
  guidance,
  prefsReady,
  changeGuidance,
  speaker
}: {
  guidance: boolean
  prefsReady: boolean
  changeGuidance: (next: boolean) => void
  speaker: string | null
}) {
  return (
    <Tooltip label={guidanceToggleHint(guidance, speaker)}>
      <Button
        role="switch"
        aria-checked={guidance}
        aria-label="Guidance"
        variant="ghost"
        disabled={!prefsReady}
        onClick={() => changeGuidance(!guidance)}
        className={`w-9 px-0! ${guidance ? "bg-guidance-surface text-guidance! ring-1 ring-guidance/60" : ""}`}
      >
        <Icon name="guidance" />
      </Button>
    </Tooltip>
  )
}

/**
 * With guidance on, the box has one action (owner, 2026-11-23): Send renders nothing and Generate
 * takes its place too, its own width plus the actions' gap (`--composer-actions-gap`, ComposerBox)
 * and Send's square (a button's height, `h-9`), added to `Button`'s own padding (`px-3`) on both
 * sides so its content stays centred; the guidance toggle and the group's left edge don't move.
 */
const WIDE_GENERATE = "px-[calc(--spacing(3)+(--spacing(9)+var(--composer-actions-gap))/2)]!"
/** On a phone, two of Send's squares and the gap: its word, not an icon, as it's not a square any more. */
const WIDE_PHONE_GENERATE = "w-[calc(--spacing(9)*2+var(--composer-actions-gap))]! px-0!"

/**
 * Generate's hover in a chat not made yet, as at the saved composer: "for you" only for the user's
 * own card; with a card from a card source, what it adds (spec/CARD-SOURCES.md §4.4); the key last
 * with guidance on, where Enter triggers it.
 */
const generateHint = (context: PendingComposerContext) =>
  `Let the model write ${context.speakerName === "You" ? "your" : `${context.speakerName}'s`} next turn${
    context.speakerPlayed && context.speakerName !== "You" ? " for you" : ""
  }${context.guidance && context.hasText ? ", following your guidance" : ""}${
    context.adds !== "" ? `, and add ${context.adds} to your cards` : ""
  }.${context.guidance ? ` (${context.submitKey})` : ""}`

export const registerComposerControls = () => [
  composerControls.register({
    id: "composer.queue",
    order: 10,
    placement: "queue",
    component: ({ view, session, recoverQueued }) => (
      <QueuedMessages queue={view.queue} session={session} onRecovered={recoverQueued} />
    )
  }),
  // The round under way after the queue: who's still to reply, Continue round once stopped.
  composerControls.register({ id: "composer.round", order: 20, placement: "queue", component: RoundControls }),
  pendingComposerControls.register({
    id: "pending.speaker",
    order: 10,
    placement: "speaker",
    // Left of the box, as at the chat's composer: the chip names who's speaking.
    component: ({ speaker, compact }) => <SpeakerSwitcher {...speaker} compact={compact} place="composer" />
  }),
  pendingComposerControls.register({
    id: "pending.guidance",
    order: 10,
    placement: "guidance",
    component: ({ guidance, prefsReady, changeGuidance, speakerName }) => (
      <GuidanceToggle
        guidance={guidance}
        prefsReady={prefsReady}
        changeGuidance={changeGuidance}
        speaker={speakerName === "You" ? null : speakerName}
      />
    )
  }),
  pendingComposerControls.register({
    id: "pending.generate",
    order: 10,
    placement: "actions",
    run: ({ start }) => start("generate"),
    component: (context) =>
      context.compact && !context.guidance ? (
        <SquareIconButton
          label={`Generate ${context.speakerName}`}
          hint={generateHint(context)}
          variant={context.guidance ? "primary" : "ghost"}
          pending={context.guidance && context.busy}
          disabled={context.busy || context.attaching || !context.prefsReady}
          onClick={() => void pendingComposerControls.get("pending.generate")?.run?.(context)}
        >
          {!(context.guidance && context.busy) && <GenerateIcon />}
        </SquareIconButton>
      ) : (
        <Button
          variant={context.guidance ? "primary" : "ghost"}
          aria-label={`Generate ${context.speakerName}`}
          hint={generateHint(context)}
          pending={context.busy}
          disabled={context.busy || context.attaching || !context.prefsReady}
          className={context.guidance ? (context.compact ? WIDE_PHONE_GENERATE : WIDE_GENERATE) : ""}
          onClick={() => void pendingComposerControls.get("pending.generate")?.run?.(context)}
        >
          {/* Its word only: the speaker's name is on the chip at the row's start, and in its name. */}
          {!context.busy && !context.compact && <GenerateIcon />}
          Generate
        </Button>
      )
  }),
  pendingComposerControls.register({
    id: "pending.send",
    order: 20,
    placement: "actions",
    run: async ({ guidance, start }) => {
      if (!guidance) await start("send")
    },
    // With guidance on, nothing: Generate takes its place (WIDE_GENERATE).
    component: (context) =>
      !context.guidance && (
        <SquareIconButton
          label={context.speakerName === "You" ? "Send" : `Send as ${context.speakerName}`}
          hint={
            !context.hasText
              ? "Type a message to send."
              : context.adds !== ""
                ? `Send your message and add ${context.adds} to your cards. (${context.submitKey})`
                : `${context.speakerName === "You" ? "Send" : `Send as ${context.speakerName}`}. (${context.submitKey})`
          }
          variant="primary"
          pending={context.busy}
          disabled={context.busy || context.attaching || !context.prefsReady || !context.hasText}
          className="data-disabled:bg-surface-raised! data-disabled:text-muted!"
          focusableWhenDisabled
          onClick={() => void pendingComposerControls.get("pending.send")?.run?.(context)}
        >
          <SendIcon />
        </SquareIconButton>
      )
  }),
  // The next-reply strip of a chat not made yet: the account's model and preset, as at the saved composer.
  pendingComposerControls.register({
    id: "pending.model",
    order: 30,
    placement: "strip",
    component: ({ view, onSettings }) => <ModelChip session={null} view={view} onSettings={onSettings} />
  }),
  pendingComposerControls.register({
    id: "pending.preset",
    order: 40,
    placement: "strip",
    component: ({ view, onSettings }) => <PresetChip session={null} view={view} onSettings={onSettings} />
  }),
  // Where the saved composer's cache chip is: the first request's size, and the request (DESIGN §2.1).
  pendingComposerControls.register({
    id: "pending.context",
    order: 50,
    placement: "strip",
    component: DraftContextChip
  }),
  // The strip: first the chips every chat kind has, in the same places (model, preset, the next
  // request's size, its cache; the subagents' models chip, where shown, right after the model: it is another
  // model selector), then each kind's own (a story's Next at 100; a workshop's
  // capabilities and folder from 110), then send-to-threads. Owner, 2026-11-25.
  composerControls.register({
    id: "composer.next",
    order: 100,
    placement: "strip",
    component: ({ reply }) => <NextReplyChip {...reply} />
  }),
  composerControls.register({
    id: "composer.model",
    order: 20,
    placement: "strip",
    component: ({ session, view, onSettings }) => <ModelChip session={session} view={view} onSettings={onSettings} />
  }),
  composerControls.register({
    id: "composer.preset",
    order: 30,
    placement: "strip",
    component: ({ session, view, onSettings }) => <PresetChip session={session} view={view} onSettings={onSettings} />
  }),
  composerControls.register({
    id: "composer.context",
    order: 80,
    placement: "strip",
    // Only the view, the typed text's store and the guidance switch: typing doesn't render it again.
    component: ({ view, typed, guidance, editingGuidance }) => (
      <ContextChip view={view} typed={typed} guidance={guidance} editingGuidance={editingGuidance} />
    )
  }),
  composerControls.register({
    id: "composer.cache",
    // Shared by every chat kind, so it sits with model, preset and size, before any kind's own chips.
    order: 85,
    placement: "strip",
    component: ({ session, view }) => <CacheChip session={session} view={view} />
  }),
  composerControls.register({
    id: "composer.history",
    order: 90,
    // In the box's control row, after the speaker, at every width: the text has a row of its own.
    placement: "tools",
    component: ({ history }) => history
  }),
  composerControls.register({
    id: "composer.speaker",
    order: 10,
    placement: "speaker",
    component: ({ speaker, recent, onRecent, compact }) => (
      <>
        <SpeakerSwitcher {...speaker} compact={compact ?? false} place="composer" />
        {/* The speakers used last, one tap each, where the box can spare the width. */}
        {!compact &&
          recent.map(({ id, name, mediaId, crop }) => (
            <Tooltip key={id} label={`Switch the next turn's speaker to ${name}.`}>
              <button
                type="button"
                aria-label={`Speak as ${name}`}
                onClick={() => onRecent(id)}
                className="hidden size-9 shrink-0 items-center justify-center rounded-md outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus @min-[760px]:inline-flex"
              >
                <Avatar id={id} name={name} mediaId={mediaId} crop={crop} size="chip" />
              </button>
            </Tooltip>
          ))}
      </>
    )
  }),
  composerControls.register({
    id: "composer.guidance",
    order: 5,
    placement: "actions",
    component: ({ guidance, prefsReady, changeGuidance, speakerName }) => (
      <GuidanceToggle
        guidance={guidance}
        prefsReady={prefsReady}
        changeGuidance={changeGuidance}
        speaker={speakerName}
      />
    )
  }),
  composerControls.register({
    id: "composer.generate",
    order: 30,
    placement: "actions",
    run: ({ generate }) => generate(),
    // Its word only ("Generate", or "New swipe" while a reply's guidance is edited; an icon on a
    // phone with guidance off): the speaker's name is on the chip at the row's start, and in this one's name and tooltip.
    component: ({ guidance, busy, ready, generateHint, generateText, generateWord, invoke, compact }) =>
      compact && !guidance ? (
        <SquareIconButton
          label={generateText}
          hint={generateHint}
          variant={guidance ? "primary" : "ghost"}
          pending={guidance && busy}
          disabled={busy || !ready}
          onClick={invoke}
        >
          {!(guidance && busy) && <GenerateIcon />}
        </SquareIconButton>
      ) : (
        <Tooltip label={generateHint}>
          <Button
            variant={guidance ? "primary" : "ghost"}
            pending={guidance && busy}
            aria-label={generateText}
            disabled={busy || !ready}
            onClick={invoke}
            className={guidance ? (compact ? WIDE_PHONE_GENERATE : WIDE_GENERATE) : ""}
          >
            {!(guidance && busy) && !compact && <GenerateIcon />}
            {generateWord}
          </Button>
        </Tooltip>
      )
  }),
  composerControls.register({
    id: "composer.send",
    order: 40,
    placement: "actions",
    // Only with guidance off: with it on, and while a reply's guidance is edited, Generate is the one
    // action and takes this one's place too (WIDE_GENERATE). With nothing typed it passes the turn:
    // the next reply, with nothing from the user.
    available: ({ guidance }) => !guidance,
    run: ({ hasText, send, replyNow }) => (hasText ? send() : replyNow()),
    component: ({ sendLabel, sendHint, busy, ready, hasText, replier, invoke }) => (
      <SquareIconButton
        label={sendLabel}
        hint={sendHint}
        variant="primary"
        pending={busy}
        disabled={!ready || (!hasText && replier === null)}
        className="data-disabled:bg-surface-raised! data-disabled:text-muted!"
        focusableWhenDisabled
        onClick={invoke}
      >
        {!busy && <SendIcon />}
      </SquareIconButton>
    )
  })
]
