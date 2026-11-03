// One click shows/conceals images; right-click or long-press chooses how to conceal them.
import { useState } from "react"
import { Button } from "./Button.tsx"
import { Icon } from "./Icon.tsx"
import { ContextMenu, MenuRadioGroup } from "./Menu.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { IMAGES_SHORTCUT, setImageConceal, toggleImages, useImagePrefs } from "./imagePrefs.ts"

export function ImageControls() {
  const prefs = useImagePrefs()
  const [open, setOpen] = useState(false)
  const label = prefs.mode === "show" ? `${prefs.conceal === "hide" ? "Hide" : "Blur"} all images` : "Show all images"
  return (
    <ContextMenu
      label="Hidden images"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Tooltip
          label={`Shows or hides images on this device (${IMAGES_SHORTCUT}). Right-click to choose blur or hide.`}
          side="bottom"
        >
          <Button
            variant="ghost"
            aria-label={label}
            aria-keyshortcuts={IMAGES_SHORTCUT}
            aria-pressed={prefs.mode !== "show"}
            aria-haspopup="menu"
            aria-expanded={open}
            className="h-8 px-2"
            onClick={() => {
              if (!open) toggleImages()
            }}
          >
            <Icon name={prefs.mode === "show" ? "eye" : "eyeOff"} />
          </Button>
        </Tooltip>
      }
    >
      <MenuRadioGroup
        value={prefs.conceal}
        onValueChange={setImageConceal}
        items={[
          {
            value: "blur",
            label: "Blur hidden images",
            description: "Blurs images when images are hidden on this device."
          },
          {
            value: "hide",
            label: "Remove hidden images",
            description: "Removes images from view when images are hidden on this device."
          }
        ]}
      />
    </ContextMenu>
  )
}
