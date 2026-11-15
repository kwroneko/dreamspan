// One change a workshop run made outside the chat (spec/WORKSHOP.md §3.6), with Undo and Open: in
// its step's row and in the Changes tab. Undo is refused once the item changed since (an edit by
// hand, say); the reason shows with Open beside it, to look at its history first.
import { syncClientPlugins } from "../../pluginLifecycle.ts"
import { type StoryScope as Scope } from "@rp/shared/branchNaming.ts"
import type { StoryAt } from "@rp/shared/chat.ts"
import { StoryScope } from "./StoryScope.tsx"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { useAction } from "../../actions.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import {
  EFFECTS_KEY,
  effectId,
  effectKey,
  effectState,
  openHint,
  opensNow,
  openTarget,
  undoable,
  undoHint,
  type RolloutEffect
} from "./effects.ts"

export function EffectRow({ effect, when = false }: { effect: RolloutEffect; when?: boolean }) {
  const action = useAction()
  const [shown, setShown] = useState(effect)
  // A newer read of the same change wins over what the last undo returned.
  const current = shown.undoneAt !== null && effect.undoneAt === null ? shown : effect
  const target = openTarget(current)
  // A made item that's undone is in the bin, as a deleted one is until its undo: there's nothing to open.
  const opens = target !== null && opensNow(current)
  const state = effectState(current)
  const undo = async () => {
    const result = await action.run(
      (client) => client("UndoRolloutEffect", effectKey(current)),
      [EFFECTS_KEY, "library", "chats", "chat-lists", "bin"]
    )
    if (result.ok) {
      setShown(result.value)
      if (current.kind.startsWith("plugin.")) await syncClientPlugins()
    }
  }
  return (
    <div data-effect={effectId(current)} data-effect-kind={current.kind} className="flex flex-col gap-1 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
          {current.undo?.storyScope ? (
            <>
              {String(current.undo.scopeTitle)} ·{" "}
              <StoryScope
                scope={current.undo.storyScope as Scope}
                at={
                  (current.undo.storyAt as StoryAt | undefined) ??
                  (typeof current.undo.forkId === "string"
                    ? {
                        chatId: current.targetId as StoryAt["chatId"],
                        forkId: current.undo.forkId as StoryAt["forkId"]
                      }
                    : undefined)
                }
              />
            </>
          ) : (
            current.title
          )}
        </span>
        {state && <Badge>{state}</Badge>}
        {when && <span className="text-muted">{new Date(current.createdAt).toLocaleString()}</span>}
        <span className="ml-auto flex shrink-0 flex-wrap gap-1">
          {undoable(current) && (
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              pending={action.pending}
              hint={undoHint(current)}
              onClick={() => void undo()}
            >
              Undo
            </Button>
          )}
          {opens && (
            <Tooltip label={openHint(current)}>
              <Link
                to={target.to}
                params={target.params as never}
                className={`${buttonClass("ghost")} h-7 px-2 text-xs`}
              >
                Open
              </Link>
            </Tooltip>
          )}
        </span>
      </div>
      {action.error && (
        <p role="alert" className="text-danger [overflow-wrap:anywhere]">
          Not undone: {action.error.message}
        </p>
      )}
    </div>
  )
}
