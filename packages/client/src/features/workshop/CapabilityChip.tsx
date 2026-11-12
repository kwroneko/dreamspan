// The workshop's capability chip in the composer's next-reply strip (spec/WORKSHOP.md §2.5, §3.4):
// how much the assistant may do, opening a popover of full-width rows, one per capability, each
// with what it allows and its Off / Ask first / Allowed choice. A choice is this workshop's
// (`SetWorkshopGrant`), and Default puts it back to the app's default. One with a single choice
// says so instead.
import { useState } from "react"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { ChatId } from "@rp/shared/chat.ts"
import type { CapabilityMode } from "@rp/shared/workshopApi.ts"
import { ErrorAlert, useAction } from "../../actions.tsx"
import type { ComposerControlContext } from "../chat/composerControls.tsx"
import { Button } from "../../ui/Button.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { ChipText, chipClass, LoadingChip } from "../chat/nextReplyStrip.tsx"
import {
  CAPABILITIES_KEY,
  capabilitiesAtom,
  chipLabel,
  chipText,
  choicesOf,
  modeDescription,
  modeLabel,
  modeText,
  type WorkshopCapability
} from "./capabilities.ts"

function CapabilityRow({ chatId, capability }: { chatId: ChatId; capability: WorkshopCapability }) {
  const action = useAction()
  const choices = choicesOf(capability)
  const set = (mode: CapabilityMode | null) =>
    void action.run(
      (client) => client("SetWorkshopGrant", { chatId, capability: capability.id, mode }),
      [CAPABILITIES_KEY]
    )
  const about = capability.example
    ? `${capability.explanation} For example: ${capability.example}`
    : capability.explanation
  return (
    <li
      data-capability={capability.id}
      data-mode={capability.mode}
      className="flex flex-col gap-1 rounded-md px-2 py-1.5 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Tooltip label={about}>
          <span className="min-w-0 font-medium [overflow-wrap:anywhere]" tabIndex={0}>
            {capability.label}
          </span>
        </Tooltip>
        {choices.length > 1 ? (
          <Segmented
            label={capability.label}
            inlineDescription={false}
            value={capability.mode}
            options={choices.map((mode) => ({
              value: mode,
              label: modeLabel[mode],
              description: `${modeDescription[mode]}${mode === capability.defaultMode ? " (The default.)" : ""}`
            }))}
            onValueChange={(mode) => mode !== capability.mode && set(mode)}
          />
        ) : (
          <span className="text-right text-xs text-muted">{modeText(capability)}</span>
        )}
      </div>
      <span className="text-xs text-muted [overflow-wrap:anywhere]">{capability.explanation}</span>
      {capability.chosen && choices.length > 1 && (
        <Button
          variant="ghost"
          className="h-7 self-start px-2 text-xs"
          pending={action.pending}
          hint={`Goes back to the default here: ${modeLabel[capability.defaultMode]}.`}
          onClick={() => set(null)}
        >
          Use the default
        </Button>
      )}
      <ErrorAlert error={action.error} title="Not changed" />
    </li>
  )
}

export function CapabilityChip({ session }: ComposerControlContext) {
  const [open, setOpen] = useState(false)
  const result = useAtomValue(capabilitiesAtom(session.chatId))
  if (!AsyncResult.isSuccess(result)) return <LoadingChip label="What the assistant may do" />
  const capabilities = result.value
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={<ChipText>{chipText(capabilities)}</ChipText>}
      triggerLabel={chipLabel(capabilities)}
      hint="What the assistant may do in this workshop. Click to see or change it."
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
          <CapabilityRow key={capability.id} chatId={session.chatId} capability={capability} />
        ))}
      </ul>
      <p className="shrink-0 border-t border-border px-2 pt-2 text-xs text-muted">These hold for this workshop only.</p>
    </Popover>
  )
}
