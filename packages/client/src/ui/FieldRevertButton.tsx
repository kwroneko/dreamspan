import { Button } from "./Button.tsx"
import { chromeButton } from "./FieldFrame.tsx"
import { Icon } from "./Icon.tsx"

export function FieldRevertButton({
  changed,
  onRevert,
  pending = false
}: {
  changed: boolean
  onRevert: () => void
  pending?: boolean
}) {
  return (
    <Button
      variant="ghost"
      aria-label="Revert to last revision"
      hint="Revert to last revision"
      disabled={!changed || pending}
      focusableWhenDisabled
      className={`${chromeButton} px-0! data-disabled:pointer-events-auto!`}
      onClick={() => {
        if (changed && !pending) onRevert()
      }}
    >
      <Icon name="undo" />
    </Button>
  )
}
