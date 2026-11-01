import { useEffect } from "react"
import { Button } from "../../ui/Button.tsx"
import { Field, Fieldset, Input } from "../../ui/Field.tsx"
import { messageColors, useMessageColorDefault } from "../../ui/messageColors.ts"
import { useViewPrefs } from "../../ui/viewPrefs.ts"

/** Mounted through app.tools: colors follow the account in chats, previews and portals. */
export function MessageColorPreferences() {
  const { prefs } = useViewPrefs()
  const { mainTextColor, italicsTextColor, underlineTextColor, quoteTextColor } = prefs
  useEffect(() => {
    const values = { mainTextColor, italicsTextColor, underlineTextColor, quoteTextColor }
    const style = document.documentElement.style
    for (const { key, token } of messageColors) {
      if (values[key]) style.setProperty(token, values[key])
      else style.removeProperty(token)
    }
    return () => {
      for (const { token } of messageColors) style.removeProperty(token)
    }
  }, [mainTextColor, italicsTextColor, underlineTextColor, quoteTextColor])
  return null
}

function ColorControl({
  color,
  viewer
}: {
  color: (typeof messageColors)[number]
  viewer: ReturnType<typeof useViewPrefs>
}) {
  const defaultColor = useMessageColorDefault(color.token)
  return (
    <Field label={`${color.label} colour`}>
      <div className="flex items-center gap-2">
        {/* A swatch, not a bar across the panel. */}
        <Input
          type="color"
          className="w-24! px-1"
          value={viewer.prefs[color.key] ?? defaultColor}
          disabled={!viewer.ready || viewer.pending}
          onValueChange={(value) => void viewer.change({ [color.key]: value })}
        />
        <Button
          variant="secondary"
          aria-label={`Reset ${color.label.toLowerCase()} colour`}
          disabled={!viewer.ready || viewer.pending || viewer.prefs[color.key] === null}
          onClick={() => void viewer.change({ [color.key]: null })}
        >
          Reset
        </Button>
      </div>
    </Field>
  )
}

export function MessageColorSettings() {
  const viewer = useViewPrefs()
  return (
    <Fieldset
      legend="Message colours"
      description="Colours follow your account. Reset follows the current light or dark theme."
    >
      {/* One a row in a narrow panel, side by side as it widens. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3">
        {messageColors.map((color) => (
          <ColorControl key={color.key} color={color} viewer={viewer} />
        ))}
      </div>
      {viewer.error && (
        <p role="alert" className="text-sm text-danger">
          {viewer.error.message}
        </p>
      )}
    </Fieldset>
  )
}
