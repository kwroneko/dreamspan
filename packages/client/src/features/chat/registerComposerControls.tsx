import { useState, useSyncExternalStore } from "react"
import { chatCommands } from "./commands.tsx"
import { QueuedMessages } from "./QueuedMessages.tsx"
import { pendingComposerControls } from "./pendingComposerControls.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { SquareIconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { CacheChip } from "./CacheIndicator.tsx"
import { nameOf, useCast } from "./cast.ts"
import { ModelChip, PresetChip } from "./GenerationControls.tsx"
import { GenerateIcon, SendIcon } from "./icons.tsx"
import { chipClass } from "./nextReplyStrip.tsx"
import { hasReplyChoice, NextReplyChip } from "./ReplyFrom.tsx"
import { SpeakerSwitcher } from "./SpeakerSwitcher.tsx"
import { composerControls, type ComposerControlContext } from "./composerControls.tsx"

function ShortcutList() {
  const commands = useSyncExternalStore(chatCommands.subscribe, chatCommands.snapshot)
  return (
    <ul className="list-inside list-disc space-y-1 pt-1">
      {commands.entries
        .filter((command) => command.shortcut)
        .map((command) => (
          <li key={command.id}>{command.label}</li>
        ))}
    </ul>
  )
}

/** The strip's "?": the keyboard shortcuts, beside the controls they stand for. */
function Help({ hint }: ComposerControlContext) {
  const [open, setOpen] = useState(false)
  return (
    <span className="ml-auto">
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger={<Icon name="help" size={14} />}
        triggerLabel="Keyboard shortcuts"
        hint="Keyboard shortcuts"
        title="Keyboard shortcuts"
        triggerClassName={`${chipClass()} w-7 justify-center px-0! text-muted`}
        align="end"
      >
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto text-sm">
          <ShortcutList />
          <p className="text-xs text-muted">{hint}</p>
        </div>
      </Popover>
    </span>
  )
}

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
        className={`${chipClass()} w-7 justify-center px-0! text-accent!`}
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
        hint={`A one-turn direction for ${speakerName}'s first reply`}
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
          hint={`The model writes ${context.speakerName}'s turn`}
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
    id: "composer.help",
    order: 100,
    placement: "strip",
    component: Help
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
          recent.map(({ id, name, mediaId }) => (
            <Tooltip key={id} label={`Speak as ${name}`}>
              <button
                type="button"
                aria-label={`Speak as ${name}`}
                onClick={() => onRecent(id)}
                className="hidden shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus @min-[760px]:inline-flex"
              >
                <Avatar id={id} name={name} mediaId={mediaId} size="chip" />
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
    // Its word only ("Write", or "New version" while a reply's guidance is edited; an icon on a
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
