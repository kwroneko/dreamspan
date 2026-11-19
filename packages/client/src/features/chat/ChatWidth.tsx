// The chat column's width (ST's Chat Width; owner 2026-11-01): per account, in Settings →
// Display and the chat's Display panel. One CSS variable, `--chat-width` on the root, is the
// widest the column gets; everything aligned to it uses the `chat-column` utility (styles.css),
// which also keeps a gutter and fills narrower screens. While the slider is dragged the value
// shows at once from a preview in this tab, and it's saved once, when the slider is let go.
import { CHAT_WIDTH } from "@dreamspan/shared/chatApi.ts"
import { useEffect, useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { Slider } from "../../ui/Slider.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"

let preview: number | null = null
const listeners = new Set<() => void>()
const setPreview = (value: number | null) => {
  preview = value
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => preview

/** The CSS value for a width: the top of the range is the full width of the space there is. */
const cssWidth = (width: number) => (width >= CHAT_WIDTH.max ? "100%" : `${width}px`)

/** Applies the account's chat width (or the one being dragged to) to the root. */
export function ChatWidthPreference() {
  const { prefs } = useViewPrefs()
  const dragged = useSyncExternalStore(subscribe, snapshot)
  const width = dragged ?? prefs.chatWidth
  useEffect(() => {
    const style = document.documentElement.style
    style.setProperty("--chat-width", cssWidth(width))
    return () => {
      style.removeProperty("--chat-width")
    }
  }, [width])
  return null
}

export function ChatWidthSetting() {
  const viewer = useViewPrefs()
  const dragged = useSyncExternalStore(subscribe, snapshot)
  const value = dragged ?? viewer.prefs.chatWidth
  return (
    <div className="flex flex-col gap-2">
      <Slider
        label="Chat width"
        value={value}
        min={CHAT_WIDTH.min}
        max={CHAT_WIDTH.max}
        step={CHAT_WIDTH.step}
        largeStep={CHAT_WIDTH.step * 5}
        disabled={!viewer.ready}
        valueText={(width) => (width >= CHAT_WIDTH.max ? "Full width" : `${width} px`)}
        onValueChange={setPreview}
        onValueCommitted={(width) => {
          // The optimistic write shows the value from here on, so the preview can go.
          if (width !== viewer.prefs.chatWidth) void viewer.change({ chatWidth: width })
          setPreview(null)
        }}
        about={`Set the maximum width of messages and the composer. Full width uses all available room. Default: ${CHAT_WIDTH.default} px.`}
      />
      {/* Back to the default in one click. */}
      {value !== CHAT_WIDTH.default && (
        <Button
          hint="Resets the chat column to its default width."
          variant="ghost"
          disabled={!viewer.ready}
          onClick={() => void viewer.change({ chatWidth: CHAT_WIDTH.default })}
          className="w-fit"
        >
          Reset to {CHAT_WIDTH.default} px
        </Button>
      )}
    </div>
  )
}
