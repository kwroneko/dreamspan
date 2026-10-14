// A one-click public-place toggle, with the three modes and chat portrait styles beside it.
import { useState } from "react"
import { Button } from "./Button.tsx"
import { Field } from "./Field.tsx"
import { Popover } from "./Popover.tsx"
import { Select } from "./Select.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { IMAGES_SHORTCUT, setAvatarStyle, setImageMode, toggleImages, useImagePrefs } from "./imagePrefs.ts"

export function ImageControls() {
  const prefs = useImagePrefs()
  const [open, setOpen] = useState(false)
  const label = prefs.mode === "show" ? `${prefs.conceal === "hide" ? "Hide" : "Blur"} all images` : "Show all images"
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip label={`${label} (${IMAGES_SHORTCUT})`}>
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
        <Field label="Chat portraits">
          <Select
            value={prefs.avatars}
            onValueChange={setAvatarStyle}
            items={[
              { value: "portrait", label: "Rectangular (60 × 90)" },
              { value: "round", label: "Circle (50 × 50)" },
              { value: "square", label: "Square (50 × 50)" },
              { value: "rounded", label: "Rounded square (50 × 50)" }
            ]}
          />
        </Field>
        <p className="text-xs text-muted">
          Kept on this device. {IMAGES_SHORTCUT} toggles images anywhere. Blurred images stay blurred on hover and tap.
        </p>
      </Popover>
    </div>
  )
}
