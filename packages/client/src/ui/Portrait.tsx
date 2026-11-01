// A portrait's whole original image, independent of the chat's display crop. Its context lets
// stock avatars marked `preview` open it without making every avatar (inside a picker, say) a
// button. Where it shows is the host's: the chat's portrait column on a wide screen
// (features/chat/PortraitColumn.tsx), a full-screen viewer here on a phone.
import { Dialog as BaseDialog } from "@base-ui/react/dialog"
import { createContext, type ReactNode, useContext, useState } from "react"
import { Button } from "./Button.tsx"
import { initials } from "./Avatar.tsx"
import { ImageViewer, type NaturalSize, type Zoom } from "./ImageViewer.tsx"
import { useImagePrefs } from "./imagePrefs.ts"
import { mediaUrl } from "./mediaImage.ts"
import { IconButton } from "./Tooltip.tsx"

export interface Portrait {
  readonly id: string
  readonly name: string
  readonly mediaId: string | null
}
interface PortraitViewer {
  /** A portrait's click: shows it, or closes it when it's the one shown (as ST's zoomed avatar). */
  readonly open: (portrait: Portrait) => void
  /** Shows a portrait, the one shown or not. */
  readonly show: (portrait: Portrait) => void
  /** Shows `portrait` in place of the one with id `from`, when that one is shown (a card swapped for another). */
  readonly replace: (from: string, portrait: Portrait) => void
  readonly close: () => void
  /** The one shown, as `current` reads it now: its name and image follow the card's. */
  readonly shown: Portrait | null
}
const Context = createContext<PortraitViewer | null>(null)

/**
 * Where avatars marked `preview` open their whole image: a click on one, from any of them.
 * `inline` says a host shows it beside the page (the chat's column); otherwise it's a
 * full-screen viewer over the page. `current` reads a portrait's name and image as they are
 * now (the chat's cast), so an edited card's shows without reopening it; without it, or when
 * it doesn't know the portrait, the one clicked shows as it was.
 */
export function PortraitProvider({
  inline,
  current,
  children
}: {
  inline: boolean
  current?: (portrait: Portrait) => Portrait | null
  children: ReactNode
}) {
  const [clicked, setShown] = useState<Portrait | null>(null)
  const shown = clicked && (current?.(clicked) ?? clicked)
  const viewer: PortraitViewer = {
    open: (portrait) => setShown((current) => (current?.id === portrait.id ? null : portrait)),
    show: setShown,
    replace: (from, portrait) => setShown((current) => (current?.id === from ? portrait : current)),
    close: () => setShown(null),
    shown
  }
  return (
    <Context value={viewer}>
      {children}
      {shown && !inline && <PortraitScreen portrait={shown} onClose={() => setShown(null)} />}
    </Context>
  )
}

export const useOpenPortrait = () => useContext(Context)?.open
export const usePortraitViewer = () => useContext(Context)

/** The phone's viewer: the whole screen, the image fitted to it or at 100% to pan and pinch. */
function PortraitScreen({ portrait, onClose }: { portrait: Portrait; onClose: () => void }) {
  return (
    <BaseDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Popup className="fixed inset-0 z-50 flex h-dvh flex-col bg-surface text-text outline-none">
          <PortraitView
            key={portrait.id}
            portrait={portrait}
            title={(name) => (
              <BaseDialog.Title className="min-w-0 flex-1 truncate text-base font-semibold">{name}</BaseDialog.Title>
            )}
            close={<BaseDialog.Close render={<IconButton label="Close" icon="close" className="shrink-0" />} />}
          />
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

/**
 * A portrait's name, Fit / 100%, the scale shown and a close button over its whole image.
 * Fit shows all of it, as large as the box allows (a small one enlarged at most
 * `MAX_UPSCALE` times); 100% is one image pixel to a CSS pixel, dragged or pinched about.
 */
export function PortraitView({
  portrait,
  title,
  close
}: {
  portrait: Portrait
  title: (name: string) => ReactNode
  close: ReactNode
}) {
  const { mode } = useImagePrefs()
  const [zoom, setZoom] = useState<Zoom>("fit")
  const [scale, setScale] = useState<{ value: number; natural: NaturalSize | null } | null>(null)
  const visible = portrait.mediaId !== null && mode === "show"
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        {title(portrait.name)}
        {visible && (
          <>
            {scale?.natural && (
              <span
                className="shrink-0 px-1 text-xs text-muted tabular-nums"
                title={`${scale.natural.width} × ${scale.natural.height} pixels, shown at ${Math.round(scale.value * 100)}%`}
              >
                {Math.round(scale.value * 100)}%
              </span>
            )}
            <Button
              variant="ghost"
              className="h-8 shrink-0 px-2.5"
              aria-pressed={zoom !== "fit"}
              title={zoom === "fit" ? "Show it at its own size, to drag around" : "Show all of it"}
              onClick={() => setZoom(zoom === "fit" ? 1 : "fit")}
            >
              {zoom === "fit" ? "100%" : "Fit"}
            </Button>
          </>
        )}
        {close}
      </div>
      {mode !== "show" && (
        <p className="px-3 pt-2 text-sm text-muted">
          Images are {mode === "blur" ? "blurred" : "hidden"} in this browser. Use the images toggle to show them.
        </p>
      )}
      <div className="min-h-0 flex-1 p-2">
        {portrait.mediaId !== null ? (
          <ImageViewer
            src={mediaUrl(portrait.mediaId)}
            placeholder={mediaUrl(portrait.mediaId, 768)}
            alt={`${portrait.name}'s full portrait`}
            zoom={visible ? zoom : "fit"}
            onZoom={(next) => visible && setZoom(next)}
            onScale={(value, natural) => setScale({ value, natural })}
            initials={initials(portrait.name)}
          />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-muted">
            <span className="text-4xl">{initials(portrait.name)}</span>
            <span className="text-sm">This card has no image.</span>
          </div>
        )}
      </div>
    </div>
  )
}

/** Shared 2:3 frame for every cropped card portrait. */
export function PortraitFrame({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`relative inline-flex aspect-[2/3] shrink-0 overflow-hidden ${className}`}>{children}</span>
}
