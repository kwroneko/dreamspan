// A portrait's whole image, in a lightbox over the page, independent of the chat's display crop.
// Its context lets stock avatars open it without making every avatar (inside a picker, say) a button.
import { Dialog as BaseDialog } from "@base-ui/react/dialog"
import { createContext, type ReactNode, useContext, useState } from "react"
import { Button } from "./Button.tsx"
import { initials } from "./Avatar.tsx"
import { Icon } from "./Icon.tsx"
import { useImagePrefs } from "./imagePrefs.ts"
import { mediaUrl } from "./mediaImage.ts"

interface Portrait {
  readonly id: string
  readonly name: string
  readonly mediaId: string | null
}
const Context = createContext<{ open: (portrait: Portrait) => void } | null>(null)

/** Where avatars marked `preview` open their whole image: a click on one, from any of them. */
export function PortraitProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Portrait | null>(null)
  return (
    <Context value={{ open: setShown }}>
      {children}
      {shown && <PortraitLightbox portrait={shown} onClose={() => setShown(null)} />}
    </Context>
  )
}

export const useOpenPortrait = () => useContext(Context)?.open

/** The whole image fitted to the screen, or at its own size to scroll around; Escape or a click beside it closes. */
function PortraitLightbox({ portrait, onClose }: { portrait: Portrait; onClose: () => void }) {
  const { mode } = useImagePrefs()
  const [actual, setActual] = useState(false)
  const shown = portrait.mediaId !== null && mode === "show"
  return (
    <BaseDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-40 min-h-dvh bg-overlay" />
        <BaseDialog.Popup className="fixed inset-2 z-50 flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 text-text shadow-xl outline-none sm:inset-6">
          <div className="flex items-center gap-2">
            <BaseDialog.Title className="min-w-0 flex-1 truncate text-base font-semibold">
              {portrait.name}
            </BaseDialog.Title>
            {shown && (
              <Button variant="ghost" className="h-8 px-2.5" onClick={() => setActual(!actual)}>
                {actual ? "Fit to the screen" : "Actual size"}
              </Button>
            )}
            <BaseDialog.Close
              aria-label="Close"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted outline-none hover:bg-surface-raised hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Icon name="close" />
            </BaseDialog.Close>
          </div>
          {mode !== "show" && (
            <p className="text-sm text-muted">
              Images are {mode === "blur" ? "blurred" : "hidden"} in this browser. Use the images toggle to show them.
            </p>
          )}
          {portrait.mediaId === null && <p className="text-sm text-muted">This card has no image.</p>}
          <div
            className={`relative min-h-0 flex-1 ${actual ? "overflow-auto" : "flex items-center justify-center overflow-hidden"}`}
            onClick={(event) => event.target === event.currentTarget && onClose()}
          >
            {portrait.mediaId !== null ? (
              <>
                <img
                  src={mediaUrl(portrait.mediaId)}
                  decoding="async"
                  alt={`${portrait.name}'s full portrait`}
                  className={actual ? "max-w-none" : "max-h-full max-w-full object-contain"}
                />
                <span
                  data-image-fallback
                  className="absolute inset-0 items-center justify-center rounded-md bg-surface-raised text-4xl text-muted"
                >
                  {initials(portrait.name)}
                </span>
              </>
            ) : (
              <span className="text-4xl text-muted">{initials(portrait.name)}</span>
            )}
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

/** Shared 2:3 frame for every cropped card portrait. */
export function PortraitFrame({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`relative inline-flex aspect-[2/3] shrink-0 overflow-hidden ${className}`}>{children}</span>
}
