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
import { close, even, keepOnly, replace, show, split, type Stack, toggle } from "./portraitStack.ts"
import { IconButton } from "./Tooltip.tsx"
import { useViewPrefs } from "./viewPrefs.ts"

export interface Portrait {
  readonly id: string
  readonly name: string
  readonly mediaId: string | null
}
interface PortraitViewer {
  /**
   * A portrait's click: closes it when it's open (as ST's zoomed avatar); else opens it on top
   * of the others, or in place of them with "Only keep one image open at a time" (`single`).
   */
  readonly open: (portrait: Portrait) => void
  /** Opens a portrait as a click would, but never closes it. */
  readonly show: (portrait: Portrait) => void
  /** Shows `portrait` in place of the one with id `from`, when that one is open (a card swapped for another). */
  readonly replace: (from: string, portrait: Portrait) => void
  /** Closes one, by id; without one, the top one. */
  readonly close: (id?: string) => void
  /** The ones open, top first, as `current` reads them now: their names and images follow the cards'. */
  readonly shown: Stack<Portrait>
  /** Moves the boundary below `index` (portraitStack.ts `split`), or evens the two either side of it. */
  readonly split: (index: number, upper: number, total: number, min: number) => void
  readonly even: (index: number) => void
  /** "Only keep one image open at a time" (`DisplayPrefs.singlePortrait`): the account's choice. */
  readonly single: boolean
  /** Turns it on, keeping only `keep` open, or off, back to stacking. */
  readonly setSingle: (on: boolean, keep: string) => void
}
const Context = createContext<PortraitViewer | null>(null)

/**
 * Where avatars marked `preview` open their whole image: a click on one, from any of them.
 * `inline` says a host shows them beside the page (the chat's column, several stacked);
 * otherwise it's one full-screen viewer over the page, a click replacing it. `current` reads a
 * portrait's name and image as they are now (the chat's cast), so an edited card's shows
 * without reopening it; without it, or when it doesn't know the portrait, the one clicked
 * shows as it was.
 */
export function PortraitProvider({
  inline,
  current,
  stack: suppliedStack,
  onStackChange,
  children
}: {
  inline: boolean
  current?: (portrait: Portrait) => Portrait | null
  stack?: Stack<Portrait>
  onStackChange?: (next: Stack<Portrait>) => void
  children: ReactNode
}) {
  const [localStack, setLocalStack] = useState<Stack<Portrait>>([])
  const stack = suppliedStack ?? localStack
  const setStack = (change: (stack: Stack<Portrait>) => Stack<Portrait>) => {
    const next = change(stack)
    if (onStackChange) onStackChange(next)
    else setLocalStack(next)
  }
  const prefs = useViewPrefs()
  const single = prefs.prefs.singlePortrait
  // A phone has room for one: a click there always replaces it.
  const replaces = single || !inline
  const shown = stack.map((entry) => ({ ...entry, portrait: current?.(entry.portrait) ?? entry.portrait }))
  const viewer: PortraitViewer = {
    open: (portrait) => setStack((stack) => toggle(stack, portrait, replaces)),
    show: (portrait) => setStack((stack) => show(stack, portrait, replaces)),
    replace: (from, portrait) => setStack((stack) => replace(stack, from, portrait)),
    close: (id) => setStack((stack) => (id === undefined ? stack.slice(1) : close(stack, id))),
    shown,
    split: (index, upper, total, min) => setStack((stack) => split(stack, index, upper, total, min)),
    even: (index) => setStack((stack) => even(stack, index)),
    single,
    setSingle: (on, keep) => {
      if (on) setStack((stack) => keepOnly(stack, keep))
      prefs.change({ singlePortrait: on })
    }
  }
  const top = shown[0]?.portrait
  return (
    <Context value={viewer}>
      {children}
      {top && !inline && <PortraitScreen portrait={top} onClose={() => viewer.close(top.id)} />}
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
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        {title(portrait.name)}
        {visible && (
          <>
            {scale?.natural && (
              <span
                className="shrink-0 px-1 text-xs text-muted tabular-nums @max-[17rem]:hidden"
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
