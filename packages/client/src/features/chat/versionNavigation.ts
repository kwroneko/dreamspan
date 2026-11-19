// Buttons, touch gestures and registered keyboard commands share version selection.
import type { PathEntry, Version } from "@dreamspan/shared/chat.ts"
import { messageVersions } from "./presentation.tsx"
import { stepFrom } from "./VersionControls.tsx"
import type { MessageActionContext } from "./messageActions.tsx"
import type { ChatSession, Outcome } from "./session.ts"

const navigation = () =>
  [...messageVersions.snapshot().entries].sort((a, b) => a.order - b.order).find((entry) => entry.step)
export const versionNavigationAvailable = () => navigation() !== undefined
export const stepVersion = async (
  entry: PathEntry,
  session: ChatSession,
  generated: boolean,
  report: (outcome: Outcome<unknown>) => void,
  step: -1 | 1,
  load: () => Promise<ReadonlyArray<Version> | null> = async () => {
    const result = await session.listVersions(entry.slotId)
    if (!result.ok) {
      report(result)
      return null
    }
    return result.value
  }
) => {
  const fork = session.snapshot().forkId
  const all = entry.versionCount > 1 ? await load() : [entry.version]
  // A list read can outlive the viewed fork or selection. Never act on a stale target.
  const view = session.snapshot()
  if (
    all === null ||
    view.loading ||
    view.forkId !== fork ||
    !view.entries.some((current) => current.slotId === entry.slotId && current.version.id === entry.version.id)
  )
    return
  const target = stepFrom(
    all,
    all.findIndex((v) => v.id === entry.version.id),
    step
  )
  if (target) report(await session.select(entry, target))
  else if (step === 1 && generated) report(await session.regenerate(entry))
}
export const invokeVersionStep = (context: MessageActionContext, direction: -1 | 1) =>
  navigation()?.step?.(
    {
      entry: context.entry,
      session: context.session,
      defaultStep: (step) => stepVersion(context.entry, context.session, context.generated, context.report, step)
    },
    direction
  )
