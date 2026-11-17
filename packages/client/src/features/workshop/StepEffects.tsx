// Under a workshop step that changed things outside the chat (spec/WORKSHOP.md §3.6): each change,
// with Undo and Open. Read with the reply's other changes (`ListVersionEffects`) once its call is
// done; a step that finished after the list was read reads it again, once.
import { syncClientPlugins } from "../../pluginLifecycle.ts"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useRef, useSyncExternalStore } from "react"
import type { StepActionProps } from "../chat/agent/stepActions.ts"
import { kindShows } from "../chat/kindLooks.ts"
import { EffectRow } from "./EffectRow.tsx"
import { binnedTargets, CHANGES, versionEffectsAtom } from "./effects.ts"

/** The calls that can change things outside the chat. */
const CHANGING = new Set(["library", "setup", "outside", "mcp"])

export function StepEffects(props: StepActionProps) {
  const { step, session } = props
  const kind = useSyncExternalStore(session.subscribe, () => session.snapshot().chat?.kind)
  if (step.status !== "done" || !CHANGING.has(step.effectClass ?? "") || !kindShows(kind, CHANGES)) return null
  return <Effects {...props} />
}

function Effects({ step, version }: StepActionProps) {
  const atom = versionEffectsAtom(version.id)
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  const mine = AsyncResult.isSuccess(result) ? result.value.filter((e) => e.toolCallId === step.id) : null
  const binned = binnedTargets(AsyncResult.isSuccess(result) ? result.value : [])
  const asked = useRef(false)
  useEffect(() => {
    if (mine === null || mine.length > 0 || asked.current) return
    asked.current = true
    refresh()
  }, [mine, refresh])
  const synced = useRef(false)
  useEffect(() => {
    if (!synced.current && mine?.some((e) => e.kind.startsWith("plugin."))) {
      synced.current = true
      void syncClientPlugins().catch(() => undefined)
    }
  }, [mine])
  if (mine === null || mine.length === 0) return null
  return (
    <div className="ml-5 flex flex-col gap-1" aria-label="What this step changed" role="group">
      {mine.map((effect) => (
        <EffectRow key={`${effect.rolloutId}:${effect.seq}`} effect={effect} inBin={binned.has(effect.targetId)} />
      ))}
    </div>
  )
}
