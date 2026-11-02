import { QueuedMessages } from "./QueuedMessages.tsx"
import { RoundControls } from "./RoundControls.tsx"
import { pendingComposerControls } from "./pendingComposerControls.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { SquareIconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { CacheChip } from "./CacheIndicator.tsx"
import { nameOf, useCast } from "./cast.ts"
import { ModelChip, PresetChip } from "./GenerationControls.tsx"
import { GenerateIcon, SendIcon } from "./icons.tsx"
import { chipClass } from "./nextReplyStrip.tsx"
import { hasReplyChoice, NextReplyChip } from "./ReplyFrom.tsx"
import { SpeakerSwitcher } from "./SpeakerSwitcher.tsx"
import { composerControls, type ComposerControlContext } from "./composerControls.tsx"

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
    <Tooltip label={`Guidance ${guidance ? "on" : "off"}: ${hint}`}>
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

/** ▶ beside "Next": who's next replies at once, with nothing sent from you (ST's force talk). */
function ReplyNow({ replier, busy, ready, invoke }: ComposerControlContext & { readonly invoke: () => void }) {
  const view = useCast()
  const name = nameOf(view, replier)
  const label = name ? `${name} replies now` : "No one to reply"
  return (
    <Tooltip label={name ? `${label}, with nothing sent from you` : label}>
      <button
        type="button"
        aria-label={label}
        disabled={busy || !ready || replier === null}
        onClick={invoke}
        className={`${chipClass()} w-9 justify-center px-0! text-accent!`}
      >
        <Icon name="play" size={12} />
      </button>
    </Tooltip>
  )
}

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
    component: ({ speaker, compact }) => <SpeakerSwitcher {...speaker} compact={compact} />
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
          hint={`Generate ${context.speakerName}'s first turn with the model${context.guidance ? ", following your guidance" : ""}.`}
          variant={context.guidance ? "primary" : "ghost"}
          pending={context.guidance && context.busy}
          disabled={context.busy || !context.prefsReady}
          onClick={() => void pendingComposerControls.get("pending.generate")?.run?.(context)}
        >
          {!(context.guidance && context.busy) && <GenerateIcon />}
        </SquareIconButton>
      ) : (
        <Button
          variant={context.guidance ? "primary" : "secondary"}
          aria-label={`Generate ${context.speakerName}`}
          hint={`Generate ${context.speakerName}'s first turn with the model${context.guidance ? ", following your guidance" : ""}.`}
          pending={context.busy}
          disabled={context.busy || !context.prefsReady}
          onClick={() => void pendingComposerControls.get("pending.generate")?.run?.(context)}
        >
          {/* Its word only: the speaker's name is on the chip at the row's start, and in its name. */}
          {context.guidance && <GenerateIcon />}
          Generate
        </Button>
      )
  }),
  pendingComposerControls.register({
    id: "pending.send",
    order: 20,
    placement: "actions",
    run: ({ start }) => start("send"),
    component: (context) =>
      context.guidance ? null : (
        <SquareIconButton
          label={context.speakerName === "You" ? "Send" : `Send as ${context.speakerName}`}
          hint={`${context.speakerName === "You" ? "Send" : `Send as ${context.speakerName}`} (${context.submitHint})`}
          variant="primary"
          pending={context.busy}
          disabled={context.busy || !context.prefsReady || !context.hasText}
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
    available: ({ reply }) => hasReplyChoice(reply),
    component: ({ reply }) => <NextReplyChip {...reply} />
  }),
  composerControls.register({
    id: "composer.reply-now",
    order: 50,
    placement: "strip",
    available: ({ reply }) => hasReplyChoice(reply),
    run: ({ replyNow }) => replyNow(),
    component: ReplyNow
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
        <SpeakerSwitcher {...speaker} compact={compact ?? false} />
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
    available: ({ guidance }) => !guidance,
    run: ({ hasText, send, replyNow }) => (hasText ? send() : replyNow()),
    component: ({ sendLabel, sendHint, busy, ready, hasText, replier, invoke }) => (
      <SquareIconButton
        label={sendLabel}
        hint={sendHint}
        variant="primary"
        pending={busy}
        disabled={!ready || (!hasText && replier === null)}
        onClick={invoke}
      >
        {!busy && <SendIcon />}
      </SquareIconButton>
    )
  })
]
