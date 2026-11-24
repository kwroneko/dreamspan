// The workshop's capability chip in the composer's next-reply strip (spec/WORKSHOP.md §2.5, §3.4):
// how much the assistant may do, opening a popover of full-width rows, one per capability, each
// with what it allows and its Off / Ask first / Allowed choice. A choice is this workshop's
// (`SetWorkshopGrant`), and Default puts it back to the app's default. One with a single choice
// says so instead. Before a workshop's first message (owner, 2026-11-17: its composer is the
// saved one from the start), the same chip lists what a new one offers and holds the choices
// made there, which its first send makes with it (`PendingCapabilityChip`).
import { type ReactNode, useState } from "react"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import type { CapabilityMode } from "@dreamspan/shared/workshopApi.ts"
import { ErrorAlert, useAction } from "../../actions.tsx"
import type { ComposerControlContext } from "../chat/composerControls.tsx"
import { Button } from "../../ui/Button.tsx"
import { ConfirmDialog } from "../../ui/Dialog.tsx"
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
  modeDescriptionOf,
  modeLabelOf,
  modeText,
  type WorkshopCapability
} from "./capabilities.ts"

function CapabilityRow({
  capability,
  choose,
  pending = false,
  error = null
}: {
  capability: WorkshopCapability
  /** A choice of mode; null goes back to the default. `consented`: the user agreed to its consent. */
  choose: (mode: CapabilityMode | null, consented?: boolean) => void
  pending?: boolean
  error?: ReactNode
}) {
  const choices = choicesOf(capability)
  // A capability with a consent (no sandbox, spec/FILES-AND-ENVIRONMENT.md §3.7) asks before it's turned on.
  const [asking, setAsking] = useState<CapabilityMode | null>(null)
  const ask = (mode: CapabilityMode | null) => {
    const turningOn = (mode ?? capability.defaultMode) !== "off" && capability.mode === "off"
    if (capability.confirm && turningOn && mode !== null) setAsking(mode)
    else choose(mode)
  }
  const about = capability.example
    ? `${capability.explanation} For example: ${capability.example}`
    : capability.explanation
  return (
    <li
      data-capability={capability.id}
      {...(capability.target ? { "data-capability-target": capability.target } : {})}
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
              label: modeLabelOf(capability, mode),
              description: `${modeDescriptionOf(capability, mode)}${mode === capability.defaultMode ? " (The default.)" : ""}`
            }))}
            onValueChange={(mode) => mode !== capability.mode && ask(mode)}
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
          pending={pending}
          hint={`Goes back to the default here: ${modeLabelOf(capability, capability.defaultMode)}.`}
          onClick={() => ask(null)}
        >
          Use the default
        </Button>
      )}
      {error}
      {capability.confirm && (
        <ConfirmDialog
          open={asking !== null}
          onOpenChange={(open) => !open && setAsking(null)}
          title={capability.confirm.title}
          description={capability.confirm.body}
          confirmLabel={capability.confirm.confirmLabel}
          confirmHint="Turns it on for this workshop."
          cancelLabel={capability.confirm.cancelLabel}
          onConfirm={() => {
            if (asking !== null) choose(asking, true)
            setAsking(null)
          }}
        />
      )}
    </li>
  )
}

/** A saved workshop's row: each choice is its grant at once. */
function SavedCapabilityRow({ chatId, capability }: { chatId: ChatId; capability: WorkshopCapability }) {
  const action = useAction()
  const choose = (mode: CapabilityMode | null, consented?: boolean) =>
    void action.run(
      (client) =>
        client("SetWorkshopGrant", {
          chatId,
          capability: capability.id,
          mode,
          ...(capability.target ? { target: capability.target } : {}),
          ...(consented ? { consented } : {})
        }),
      [CAPABILITIES_KEY]
    )
  return (
    <CapabilityRow
      capability={capability}
      choose={choose}
      pending={action.pending}
      error={<ErrorAlert error={action.error} title="Not changed" />}
    />
  )
}

/** The chip and its popover of rows. */
function CapabilityPopover({
  capabilities,
  row
}: {
  capabilities: ReadonlyArray<WorkshopCapability>
  row: (capability: WorkshopCapability) => ReactNode
}) {
  const [open, setOpen] = useState(false)
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
        {capabilities.map(row)}
      </ul>
      <p className="shrink-0 border-t border-border px-2 pt-2 text-xs text-muted">These hold for this workshop only.</p>
    </Popover>
  )
}

export function CapabilityChip({ session }: ComposerControlContext) {
  const result = useAtomValue(capabilitiesAtom(session.chatId))
  if (!AsyncResult.isSuccess(result)) return <LoadingChip label="What the assistant may do" />
  return (
    <CapabilityPopover
      capabilities={result.value}
      row={(capability) => (
        <SavedCapabilityRow
          key={`${capability.id}:${capability.target ?? ""}`}
          chatId={session.chatId}
          capability={capability}
        />
      )}
    />
  )
}
