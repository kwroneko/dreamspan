// What the summary screens show alike (the Summaries tab, the summaries in the chat): a
// summary's state as small badges that say what they mean on hover or focus, and its text
// cut to a few lines with a control to show the rest.
import type { LcmSummary } from "@dreamspan/shared/lcm.ts"
import { type ReactNode, useLayoutEffect, useRef, useState } from "react"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { healthOf } from "./lcm.ts"

/** A badge with its meaning in a tooltip, reachable by keyboard. */
export function HintBadge({
  tone,
  hint,
  children
}: {
  tone?: "neutral" | "accent" | "warning" | "danger"
  hint: ReactNode
  children: ReactNode
}) {
  return (
    <Tooltip label={hint}>
      <span
        tabIndex={0}
        className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Badge tone={tone ?? "neutral"}>{children}</Badge>
      </span>
    </Tooltip>
  )
}

/** The level, as a short badge: what a level is, in its tooltip. */
export function LevelBadge({ level }: { level: number }) {
  return (
    <HintBadge
      tone="accent"
      hint={
        level === 1
          ? "Level 1: a summary of messages."
          : `Level ${level}: a summary of level-${level - 1} summaries, made when the summaries outgrew their space.`
      }
    >
      Level {level}
    </HintBadge>
  )
}

type Row = Pick<LcmSummary, "status" | "fresh" | "origin"> &
  Partial<Pick<LcmSummary, "resolved" | "replacementAvailable" | "rerun">>

/** A summary's state: only what differs from a fresh summary the model wrote. */
export function SummaryBadges({ summary }: { summary: Row }) {
  const health = healthOf({ status: summary.status, fresh: summary.fresh, resolved: summary.resolved === true })
  return (
    <>
      {health === "stale" && (
        <HintBadge
          tone="warning"
          hint={
            summary.origin === "generated"
              ? "Stale: its messages changed since it was written. It's written again with a reply that sends it."
              : "Stale: its messages changed since. It stays as it is until you edit or re-summarize it."
          }
        >
          Stale
        </HintBadge>
      )}
      {health === "failed" && (
        <HintBadge
          tone="danger"
          hint="Failed: no summary was written. Its messages are sent as they are while they fit."
        >
          Failed
        </HintBadge>
      )}
      {health === "resolved" && (
        <HintBadge hint="This failure no longer matters: a later summary covers these messages.">Resolved</HintBadge>
      )}
      {summary.origin === "user" && (
        <HintBadge hint="Edited by you. It stays as you wrote it, even when its messages change.">Edited</HintBadge>
      )}
      {summary.origin === "imported" && (
        <HintBadge hint="It came with the imported chat and was kept when summaries were turned on. It stays as it is.">
          Imported
        </HintBadge>
      )}
      {summary.origin === "changeset" && <HintBadge hint="Changed by an agent.">Changed by agent</HintBadge>}
      {summary.status === "truncated" && (
        <HintBadge hint="The model stopped before the summary was finished.">Cut short</HintBadge>
      )}
      {summary.replacementAvailable && (
        <HintBadge hint="A newer summary of these messages was written. Revisions has it, to use instead.">
          Newer text
        </HintBadge>
      )}
      {summary.rerun && (
        <HintBadge tone="accent" hint="You asked for it to be written again. That happens with your next reply.">
          Redo next reply
        </HintBadge>
      )}
    </>
  )
}

/** Text cut to a few lines, with Show all when there's more. */
export function ClampedText({ text, lines = 6, children }: { text: string; lines?: number; children?: ReactNode }) {
  const [all, setAll] = useState(false)
  const [cut, setCut] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || all) return
    const measure = () => setCut(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text, all])
  return (
    <div className="flex flex-col items-start gap-1">
      <div
        ref={ref}
        data-clamped={!all || undefined}
        className="w-full text-sm whitespace-pre-wrap [overflow-wrap:anywhere]"
        style={
          all
            ? undefined
            : { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines, overflow: "hidden" }
        }
      >
        {children ?? text}
      </div>
      {(cut || all) && (
        <Tooltip label={all ? "Click to collapse the summary text." : "Click to show the full summary text."}>
          <button
            type="button"
            aria-expanded={all}
            onClick={() => setAll(!all)}
            className="rounded-sm text-xs text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          >
            {all ? "Show less" : "Show all"}
          </button>
        </Tooltip>
      )}
    </div>
  )
}
