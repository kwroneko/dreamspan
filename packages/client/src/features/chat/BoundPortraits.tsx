// An editor opened from a chat, in a tab of its own (features/workbench): pictures open in the
// chat's portrait column beside it, as they did beside the chat (owner, 2026-11-05: "for now
// the image-viewer would also open in its own extra column as it does").
import type { CSSProperties, ReactNode } from "react"
import { SlotOutlet } from "../../slots.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import type { CastView } from "./cast.ts"
import { ChatPortraitProvider } from "./ChatPortraitProvider.tsx"
import { useWide } from "./ChatPanels.tsx"
import { chatColumns } from "./presentation.tsx"

export function BoundPortraits({ cast, children }: { cast: CastView; children: ReactNode }) {
  const wide = useWide()
  const { prefs } = useViewPrefs()
  return (
    <ChatPortraitProvider wide={wide} cast={cast} ready>
      <div
        className="flex min-h-0 flex-1"
        style={
          {
            "--chat-portrait-width": `${{ small: 48, default: 60, large: 72, largest: 84 }[prefs.portraitSize]}px`
          } as CSSProperties
        }
      >
        <SlotOutlet slot={chatColumns} props={{ wide }} />
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </ChatPortraitProvider>
  )
}
