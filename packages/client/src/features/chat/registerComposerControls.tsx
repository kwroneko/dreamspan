import { QueuedMessages } from "./QueuedMessages.tsx"
import { RoundControls } from "./RoundControls.tsx"
import { type PendingComposerContext, pendingComposerControls } from "./pendingComposerControls.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { SquareIconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { CacheChip } from "./CacheIndicator.tsx"
import { DraftContextChip } from "./draftRequest.tsx"
import { ModelChip, PresetChip } from "./GenerationControls.tsx"
import { GenerateIcon, SendIcon } from "./icons.tsx"
import { NextReplyChip } from "./ReplyFrom.tsx"
import { SpeakerSwitcher } from "./SpeakerSwitcher.tsx"
import { composerControls } from "./composerControls.tsx"

/** Guidance as an icon toggle in the box (DESIGN §2.2: a visible control), its name and use in the tooltip. */
function GuidanceToggle({
  guidance,
  prefsReady,
  changeGuidance,
  hint
}: {
  guidance: boolean
  prefsReady: boolean
  changeGuidance: (next: boolean) => void
  hint: string
}) {
  return (
    <Tooltip label={`Click to turn guidance ${guidance ? "off" : "on"}. ${hint}`}>
      <Button
        role="switch"
        aria-checked={guidance}
        aria-label="Guidance"
        variant="ghost"
        disabled={!prefsReady}
        onClick={() => changeGuidance(!guidance)}
        className={`w-9 px-0! ${guidance ? "bg-guidance-surface text-guidance! ring-1 ring-guidance/60" : ""}`}
      >
        <Icon name="guidance" size={18} />
      </Button>
    </Tooltip>
  )
}

/** Generate's hover in a chat not made yet; with a card from a card source, what it adds (spec/CARD-SOURCES.md §4.4). */
const generateHint = (context: PendingComposerContext) =>
  context.adds !== ""
    ? `Has ${context.speakerName} write the first message and adds ${context.adds} to your cards.`
    : `Generate ${context.speakerName}'s first turn with the model${context.guidance ? ", following your guidance" : ""}.`

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
        hint={`One-turn guidance for ${speakerName}'s first reply`}
      />
    )
  }),
  pendingComposerControls.register({
    id: "pending.generate",
    order: 10,
    placement: "actions",
    run: ({ start }) => start("generate"),
    component: (context) =>
      context.compact ? (
        <SquareIconButton
          label={`Generate ${context.speakerName}`}
          hint={generateHint(context)}
          variant={context.guidance ? "primary" : "ghost"}
          pending={context.guidance && context.busy}
          disabled={context.busy || !context.prefsReady}
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
          disabled={context.busy || !context.prefsReady}
          onClick={() => void pendingComposerControls.get("pending.generate")?.run?.(context)}
        >
          {/* Its word only: the speaker's name is on the chip at the row's start, and in its name. */}
          {!context.busy && <GenerateIcon />}
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
    component: (context) => (
      <SquareIconButton
        label={context.speakerName === "You" ? "Send" : `Send as ${context.speakerName}`}
        hint={
          context.guidance
            ? "Guidance is sent with Generate, as instructions for the reply."
            : context.adds !== ""
              ? `Sends your message and adds ${context.adds} to your cards (${context.submitHint})`
              : `${context.speakerName === "You" ? "Send" : `Send as ${context.speakerName}`} (${context.submitHint})`
        }
        variant="primary"
        pending={context.busy}
        disabled={context.guidance || context.busy || !context.prefsReady || !context.hasText}
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
  composerControls.register({
    id: "composer.model",
    order: 10,
    placement: "strip",
    component: ({ session, view, onSettings }) => <ModelChip session={session} view={view} onSettings={onSettings} />
  }),
  composerControls.register({
    id: "composer.preset",
    order: 20,
    placement: "strip",
    component: ({ session, view, onSettings }) => <PresetChip session={session} view={view} onSettings={onSettings} />
  }),
  composerControls.register({
    id: "composer.cache",
    order: 30,
    placement: "strip",
    component: ({ session, view }) => <CacheChip session={session} view={view} />
  }),
  composerControls.register({
    id: "composer.next",
    order: 40,
    placement: "strip",
    component: ({ reply }) => <NextReplyChip {...reply} />
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
    component: ({ guidance, prefsReady, changeGuidance, hint }) => (
      <GuidanceToggle guidance={guidance} prefsReady={prefsReady} changeGuidance={changeGuidance} hint={hint} />
    )
  }),
  composerControls.register({
    id: "composer.generate",
    order: 30,
    placement: "actions",
    run: ({ generate }) => generate(),
    // Its word only ("Generate", or "New version" while a reply's guidance is edited; an icon on a
    // phone): the speaker's name is on the chip at the row's start, and in this one's name and tooltip.
    component: ({ guidance, busy, ready, generateHint, generateText, generateWord, invoke, compact }) =>
      compact ? (
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
            className="px-2.5"
          >
            {!(guidance && busy) && <GenerateIcon />}
            {generateWord}
          </Button>
        </Tooltip>
      )
  }),
  composerControls.register({
    id: "composer.send",
    order: 40,
    placement: "actions",
    // With nothing typed it asks for the reply alone, guidance on or off (there's no guidance to
    // lose); with text and guidance on, Generate sends it, never Send.
    run: ({ guidance, editingGuidance, hasText, send, replyNow }) => {
      if (editingGuidance) return
      if (!hasText) return replyNow()
      if (!guidance) return send()
    },
    component: ({ guidance, editingGuidance, sendLabel, sendHint, busy, ready, hasText, replier, invoke }) => (
      <SquareIconButton
        label={sendLabel}
        hint={
          editingGuidance || (guidance && hasText)
            ? "Guidance is sent with Generate, as instructions for the reply."
            : sendHint
        }
        variant="primary"
        pending={busy}
        disabled={editingGuidance || (guidance && hasText) || !ready || (!hasText && replier === null)}
        className="data-disabled:bg-surface-raised! data-disabled:text-muted!"
        focusableWhenDisabled
        onClick={invoke}
      >
        {!busy && <SendIcon />}
      </SquareIconButton>
    )
  })
]
