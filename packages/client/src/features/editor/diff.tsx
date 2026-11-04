// How a field changed, as one stretch of removed and inserted text with a little context
// around it: linear in the text's length, so a 50 KB description compares at once.
import { diffPatch } from "@rp/shared/drafts.ts"
import { RevisionDiff } from "../../ui/RevisionDiff.tsx"

/** Characters of unchanged text shown on each side of the change. */
const CONTEXT = 80
/** Changed text shown before the rest is summarized. */
const SHOWN = 1500

const asText = (value: unknown) =>
  value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2)

const cut = (text: string) => (text.length <= SHOWN ? text : `${text.slice(0, SHOWN)}… (${text.length - SHOWN} more)`)

export function ValueDiff({
  before,
  after,
  rich = false,
  beforeLabel = "Before",
  afterLabel = "After"
}: {
  before: unknown
  after: unknown
  rich?: boolean
  beforeLabel?: string
  afterLabel?: string
}) {
  const a = asText(before)
  const b = asText(after)
  if (rich)
    return (
      <RevisionDiff
        before={a}
        after={b}
        beforeLabel={beforeLabel}
        afterLabel={afterLabel}
        unifiedLabel={
          beforeLabel === "Before" && afterLabel === "After" ? undefined : `${beforeLabel} (−) → ${afterLabel} (+)`
        }
      />
    )
  const patch = diffPatch(a, b)
  const prefix = a.slice(Math.max(0, patch.start - CONTEXT), patch.start)
  const end = patch.start + patch.removed.length
  const suffix = a.slice(end, end + CONTEXT)
  return (
    <pre className="max-h-64 overflow-auto rounded-md border border-border bg-canvas p-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
      {patch.start > CONTEXT && <span className="text-muted">…</span>}
      <span className="text-muted">{prefix}</span>
      {patch.removed && (
        <del aria-label="Removed" className="bg-danger/15 text-danger">
          {cut(patch.removed)}
        </del>
      )}
      {patch.inserted && (
        <ins aria-label="Added" className="bg-success/15 text-success no-underline">
          {cut(patch.inserted)}
        </ins>
      )}
      <span className="text-muted">{suffix}</span>
      {end + CONTEXT < a.length && <span className="text-muted">…</span>}
    </pre>
  )
}
