// A one-click public-place toggle (an eye, struck through while images are blurred or hidden),
// with concealment modes and account-owned portrait size.
import { useViewPrefs } from "./viewPrefs.ts"
import { useState } from "react"
import { Button } from "./Button.tsx"
import { Icon } from "./Icon.tsx"
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
          variant="ghost"
          aria-label={label}
          aria-keyshortcuts={IMAGES_SHORTCUT}
          aria-pressed={prefs.mode !== "show"}
          className="h-8 px-2"
          onClick={toggleImages}
        >
          {/* An icon, so it doesn't take the header's room; the tooltip says what a click does. */}
          <Icon name={prefs.mode === "show" ? "eye" : "eyeOff"} />
        </Button>
      </Tooltip>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="⋯"
        triggerLabel="Image settings"
        hint="Image settings"
        hintSide="bottom"
        title="Images"
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
        <Field label="Message portrait size">
          <Select<typeof viewer.prefs.portraitSize>
            value={viewer.prefs.portraitSize}
            onValueChange={(portraitSize) => void viewer.change({ portraitSize })}
            items={[
              { value: "small", label: "Smallest (48 × 72)" },
              { value: "default", label: "Small (60 × 90)" },
              { value: "large", label: "Medium (72 × 108)" },
              { value: "largest", label: "Large (84 × 126)" }
            ]}
          />
        </Field>
        {viewer.error && (
          <p role="alert" className="text-xs text-danger">
            {viewer.error.message}
          </p>
        )}
        <p className="text-xs text-muted">
          Show, blur or hide applies on this device; portrait size on all your devices. {IMAGES_SHORTCUT} switches
          images anywhere. Blurred images stay blurred on hover and tap.
        </p>
      </Popover>
    </div>
  )
}
