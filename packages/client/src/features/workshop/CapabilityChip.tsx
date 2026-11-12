// The workshop's capability chip in the composer's next-reply strip (spec/WORKSHOP.md §2.5): how
// much the assistant may do, opening a popover of full-width rows, one per capability, each with
// how it stands and what it allows. Choosing what it may do comes later (W4); until then the
// popover says so.
import { useState, useSyncExternalStore } from "react"
import { Popover } from "../../ui/Popover.tsx"
import { ChipText, chipClass } from "../chat/nextReplyStrip.tsx"
import { chipLabel, chipText, modeText, workshopCapabilities } from "./capabilities.ts"

export function CapabilityChip() {
  const [open, setOpen] = useState(false)
  const snapshot = useSyncExternalStore(
    workshopCapabilities.subscribe,
    workshopCapabilities.snapshot,
    workshopCapabilities.snapshot
  )
  const capabilities = [...snapshot.entries].sort((a, b) => a.order - b.order)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={<ChipText>{chipText(capabilities)}</ChipText>}
      triggerLabel={chipLabel(capabilities)}
      hint="What the assistant may do in this workshop. Click for the list."
      triggerClassName={chipClass()}
      title="What the assistant may do"
    >
      <ul
        aria-label="What the assistant may do"
        data-capabilities
        className="flex min-h-0 flex-col overflow-y-auto"
        data-layout-audit-ignore="inset: Unbordered list of full-width rows, inset by the popover's padding"
      >
        {capabilities.map((capability) => (
          <li
            key={capability.id}
            data-capability={capability.id}
            className="grid grid-cols-[1fr_auto] gap-x-3 rounded-md px-2 py-1.5 text-sm"
          >
            <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{capability.label}</span>
            <span className="text-right text-xs text-muted">{modeText(capability)}</span>
            <span className="col-span-2 text-xs text-muted [overflow-wrap:anywhere]">{capability.explanation}</span>
          </li>
        ))}
      </ul>
      <p className="shrink-0 border-t border-border px-2 pt-2 text-xs text-muted">You can&rsquo;t change these yet.</p>
    </Popover>
  )
}
