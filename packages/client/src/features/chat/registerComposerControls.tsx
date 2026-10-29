import { QueuedMessages } from "./QueuedMessages.tsx"
import { pendingComposerControls } from "./pendingComposerControls.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { SquareIconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { GenerationControls } from "./GenerationControls.tsx"
import { GenerateIcon, RegenerateIcon, SendIcon } from "./icons.tsx"
import { ReplyFrom } from "./ReplyFrom.tsx"
import { SpeakerSwitcher } from "./SpeakerSwitcher.tsx"
import { composerControls } from "./composerControls.tsx"

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
    component: ({ speaker }) => (
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span>Writing as</span>
        <SpeakerSwitcher {...speaker} />
      </div>
    )
  }),
  pendingComposerControls.register({
    id: "pending.guidance",
    order: 10,
    placement: "guidance",
    component: ({ guidance, prefsReady, changeGuidance }) => (
      <Switch checked={guidance} disabled={!prefsReady} onCheckedChange={changeGuidance}>
        Guidance
      </Switch>
    )
  }),
  pendingComposerControls.register({
    id: "pending.generate",
    order: 10,
    placement: "actions",
    run: ({ start }) => start("generate"),
    component: (context) => (
      <Button
        variant={context.guidance ? "primary" : "secondary"}
        aria-label={`Generate ${context.speakerName}`}
        pending={context.busy}
        disabled={context.busy}
        onClick={() => void pendingComposerControls.get("pending.generate")?.run?.(context)}
      >
        {context.guidance && <GenerateIcon />}
        <span className="truncate">{context.guidance ? `Generate ${context.speakerName}` : "Generate"}</span>
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
          hint={`${context.speakerName === "You" ? "Send" : `Send as ${context.speakerName}`} (Enter; Shift+Enter for a new line)`}
          variant="primary"
          pending={context.busy}
          disabled={context.busy || !context.hasText}
          onClick={() => void pendingComposerControls.get("pending.send")?.run?.(context)}
        >
          <SendIcon />
        </SquareIconButton>
      )
  }),
  composerControls.register({
    id: "composer.settings",
    order: 10,
    placement: "settings",
    component: GenerationControls
  }),
  composerControls.register({
    id: "composer.speaker",
    order: 10,
    placement: "speaker",
    component: ({ speaker, recent, onRecent, compact }) => (
      <>
        <SpeakerSwitcher {...speaker} />
        {!compact &&
          recent.map(({ id, name, mediaId }) => (
            <Tooltip key={id} label={`Speak as ${name}`}>
              <button
                type="button"
                aria-label={`Speak as ${name}`}
                onClick={() => onRecent(id)}
                className="shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <Avatar id={id} name={name} mediaId={mediaId} size="md" />
              </button>
            </Tooltip>
          ))}
      </>
    )
  }),
  composerControls.register({
    id: "composer.regenerate",
    order: 10,
    placement: "actions",
    available: ({ leaf, leafGenerating }) => leaf?.version.writer === "model" && !leafGenerating,
    run: async ({ session, leaf, report }) => {
      if (leaf) report(await session.regenerate(leaf))
    },
    component: ({ invoke }) => (
      <SquareIconButton
        label="Regenerate the latest reply"
        hint="Regenerate the latest reply: a new version of it, in its place"
        variant="ghost"
        onClick={invoke}
      >
        <RegenerateIcon />
      </SquareIconButton>
    )
  }),
  composerControls.register({
    id: "composer.generate",
    order: 30,
    placement: "actions",
    run: ({ generate }) => generate(),
    component: ({ guidance, busy, ready, generateHint, generateText, invoke }) => (
      <Tooltip label={generateHint}>
        <Button
          variant={guidance ? "primary" : "secondary"}
          pending={guidance && busy}
          aria-label={generateText}
          disabled={busy || !ready}
          onClick={invoke}
          className="max-w-52 sm:max-w-56"
        >
          {guidance && !busy && <GenerateIcon />}
          <span className="truncate">{generateText}</span>
        </Button>
      </Tooltip>
    )
  }),
  composerControls.register({
    id: "composer.send",
    order: 40,
    placement: "actions",
    available: ({ guidance }) => !guidance,
    run: ({ hasText, send, replyNow }, source) => (source === "keyboard" || hasText ? send() : replyNow()),
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
  }),
  composerControls.register({
    id: "composer.guidance",
    order: 10,
    placement: "guidance",
    component: ({ guidance, prefsReady, changeGuidance, hasText, hint, compact }) => (
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className="shrink-0 text-sm">
          <Switch checked={guidance} disabled={!prefsReady} onCheckedChange={changeGuidance}>
            Guidance
          </Switch>
        </span>
        {!compact && (guidance || hasText) && (
          <p id="composer-hint" className="min-w-0 flex-1 basis-60 pt-0.5 text-xs text-muted">
            {hint}
          </p>
        )}
      </div>
    )
  }),
  composerControls.register({
    id: "composer.help",
    order: 10,
    placement: "help",
    component: ({ hint }) => (
      <p id="composer-hint" className="text-xs text-muted">
        {hint}
      </p>
    )
  }),
  composerControls.register({
    id: "composer.reply-from",
    order: 10,
    placement: "reply",
    component: ({ reply }) => <ReplyFrom {...reply} />
  })
]
