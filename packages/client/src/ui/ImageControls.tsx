// A one-click public-place toggle, with concealment modes and account-owned portrait size.
import { useViewPrefs } from "./viewPrefs.ts"
import { useState } from "react"
import { Button } from "./Button.tsx"
import { Field } from "./Field.tsx"
import { Popover } from "./Popover.tsx"
import { Select } from "./Select.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { IMAGES_SHORTCUT, setImageMode, toggleImages, useImagePrefs } from "./imagePrefs.ts"

export function ImageControls() {
  const prefs = useImagePrefs()
  const viewer = useViewPrefs()
  const [open, setOpen] = useState(false)
  const label = prefs.mode === "show" ? `${prefs.conceal === "hide" ? "Hide" : "Blur"} all images` : "Show all images"
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip label={`${label} (${IMAGES_SHORTCUT})`} side="bottom">
        <Button
          variant="secondary"
          aria-label={label}
          aria-keyshortcuts={IMAGES_SHORTCUT}
          aria-pressed={prefs.mode !== "show"}
          className="h-8 px-2 text-xs"
          onClick={toggleImages}
        >
          Images: {prefs.mode === "show" ? "shown" : prefs.mode === "blur" ? "blurred" : "hidden"}
        </Button>
      </Tooltip>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="⋯"
        triggerLabel="Image settings"
        hint="Image settings"
        hintSide="bottom"
        title="Images in this browser"
        side="bottom"
        align="end"
        triggerClassName="h-8 rounded-md px-2 text-muted outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Field label="Every image">
          <Select
            value={prefs.mode}
            onValueChange={setImageMode}
            items={[
              { value: "show", label: "Show" },
              { value: "blur", label: "Blur" },
              { value: "hide", label: "Hide" }
            ]}
          />
        </Field>
        <Field label="Message portrait size (account)">
          <Select<typeof viewer.prefs.portraitSize>
            value={viewer.prefs.portraitSize}
            onValueChange={(portraitSize) => void viewer.change({ portraitSize })}
            items={[
              { value: "small", label: "Small (48 × 72)" },
              { value: "default", label: "SillyTavern default (60 × 90)" },
              { value: "large", label: "Large (72 × 108)" },
              { value: "largest", label: "Largest (84 × 126)" }
            ]}
          />
        </Field>
        {viewer.error && (
          <p role="alert" className="text-xs text-danger">
            {viewer.error.message}
          </p>
        )}
        <p className="text-xs text-muted">
          Image concealment stays on this device. Portrait size follows your account. {IMAGES_SHORTCUT} toggles images
          anywhere. Blurred images stay blurred on hover and tap.
        </p>
      </Popover>
    </div>
  )
}
