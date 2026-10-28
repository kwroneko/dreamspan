import { Avatar } from "../../ui/Avatar.tsx"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { SquareIconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { GenerationControls } from "./GenerationControls.tsx"
import { GenerateIcon, RegenerateIcon, SendIcon, StopIcon } from "./icons.tsx"
import { ReplyFrom } from "./ReplyFrom.tsx"
import { SpeakerSwitcher } from "./SpeakerSwitcher.tsx"
import { composerControls } from "./composerControls.tsx"

export const registerComposerControls = () => [
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
    component: ({ speaker, recent, onRecent }) => (
      <>
        <SpeakerSwitcher {...speaker} />
        {recent.map(({ id, name, mediaId }) => (
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
    id: "composer.stop",
    order: 20,
    placement: "actions",
    available: ({ leafGenerating }) => !!leafGenerating,
    run: async ({ session, leaf, report }) => {
      if (leaf) report(await session.stop(leaf.version.id))
    },
    component: ({ invoke }) => (
      <SquareIconButton label="Stop the reply" variant="ghost" onClick={invoke}>
        <StopIcon />
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
    component: ({ guidance, prefsReady, changeGuidance, hasText, hint }) => (
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className="shrink-0 text-sm">
          <Switch checked={guidance} disabled={!prefsReady} onCheckedChange={changeGuidance}>
            Guidance
          </Switch>
        </span>
        {(guidance || hasText) && (
          <p id="composer-hint" className="min-w-0 flex-1 basis-60 pt-0.5 text-xs text-muted">
            {hint}
          </p>
        )}
      </div>
    )
  }),
  composerControls.register({
    id: "composer.reply-from",
    order: 10,
    placement: "reply",
    component: ({ reply }) => <ReplyFrom {...reply} />
  })
]
