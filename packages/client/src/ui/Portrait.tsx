// A portrait's whole original image, independent of the chat's display crop. Its context lets
// stock avatars marked `preview` open it without making every avatar (inside a picker, say) a
// button. Where it shows is the host's: the chat's portrait column on a wide screen
// (features/chat/PortraitColumn.tsx), a full-screen viewer here on a phone.
import { Dialog as BaseDialog } from "@base-ui/react/dialog"
import { createContext, type ReactElement, type ReactNode, useContext, useState } from "react"
import { initials } from "./Avatar.tsx"
import { ImageViewer, MAX_ZOOM, type NaturalSize, type Zoom } from "./ImageViewer.tsx"
import { Dialog } from "./Dialog.tsx"
import { useImagePrefs } from "./imagePrefs.ts"
import type { AvatarCrop } from "@dreamspan/shared/media.ts"
import { mediaUrl, pictureUrl } from "./mediaImage.ts"
import { close, even, keepOnly, move, replace, show, split, type Stack, toggle } from "./portraitStack.ts"
import { Segmented } from "./Segmented.tsx"
import { ToolbarSlider } from "./Slider.tsx"
import { useAway } from "./away.ts"
import { IconButton, Tooltip } from "./Tooltip.tsx"
import { ViewerHeader } from "./ViewerHeader.tsx"
import { useLayoutParam, writeLayoutParam } from "../tabLayoutParams.ts"

/** "Only keep one image open at a time" in this tab: `psingle=on`; absent, they stack. */
export const SINGLE_PORTRAIT_PARAM = "psingle"

export interface Portrait {
  readonly id: string
  readonly name: string
  readonly mediaId: string | null
  readonly picture?: AvatarCrop | undefined
  /** The whole picture's own address when it isn't a stored file (a card source's card). */
  readonly src?: string | undefined
  /** A message's attached image rather than a portrait: the viewer's labels say "image". */
  readonly image?: true | undefined
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
  readonly move: (id: string, index: number) => void
  /**
   * "Only keep one image open at a time": this browser tab's, in its URL (`SINGLE_PORTRAIT_PARAM`,
   * owner 2026-11-18: how a tab shows something is the tab's).
   */
  readonly single: boolean
  /** Turns it on, keeping only `keep` open, or off, back to stacking. */
  readonly setSingle: (on: boolean, keep: string) => void
  /** Puts `next` in place of the ones open (the workbench's one column, over several views). */
  readonly set: (next: Stack<Portrait>) => void
  /** The tab URL that opens a portrait's picture, for a drag onto a frame; absent outside the workbench's views. */
  readonly tabHref?: ((portrait: Portrait) => string | null) | undefined
}

export type { PortraitViewer }
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
  tabHref,
  children
}: {
  inline: boolean
  current?: (portrait: Portrait) => Portrait | null
  tabHref?: ((portrait: Portrait) => string | null) | undefined
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
  const single = useLayoutParam(SINGLE_PORTRAIT_PARAM) === "on"
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
    move: (id, index) => setStack((stack) => move(stack, id, index)),
    even: (index) => setStack((stack) => even(stack, index)),
    single,
    setSingle: (on, keep) => {
      if (on) setStack((stack) => keepOnly(stack, keep))
      writeLayoutParam(SINGLE_PORTRAIT_PARAM, on ? "on" : null)
    },
    set: (next) => setStack(() => next),
    tabHref
  }
  const top = shown[0]?.portrait
  return (
    <Context value={viewer}>
      {children}
      {top && !inline && <PortraitScreen portrait={top} onClose={() => viewer.close(top.id)} />}
    </Context>
  )
}

/** The shared click toggle for viewer portraits, including editable card headers. */
export const useOpenPortrait = () => useContext(Context)?.open
export const usePortraitViewer = () => useContext(Context)

/** Gives `viewer` to what's inside, in place of the one above (the workbench's shared column). */
export function PortraitViewerScope({ viewer, children }: { viewer: PortraitViewer; children: ReactNode }) {
  return <Context value={viewer}>{children}</Context>
}

/**
 * A viewer for pages outside a chat (the full editor's own page): a full-screen one, unless a
 * host above already gives one. Every portrait that can be edited opens its picture on a click,
 * wherever it is (owner, 2026-11-02).
 */
export function EnsurePortraitViewer({ children }: { children: ReactNode }) {
  return useContext(Context) ? children : <PortraitProvider inline={false}>{children}</PortraitProvider>
}

/** The phone's viewer: the whole screen, the image fitted to it or at 100% to pan and pinch. */
function PortraitScreen({ portrait, onClose }: { portrait: Portrait; onClose: () => void }) {
  const away = useAway()
  return (
    <BaseDialog.Root open={!away} onOpenChange={(open) => !open && onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Popup
          data-layout-overlay="The full-screen viewer covers the page"
          className="fixed inset-0 z-50 flex h-dvh flex-col bg-surface text-text outline-none"
        >
          <PortraitView
            key={portrait.id}
            portrait={portrait}
            header={(node) => <ViewerHeader portrait={portrait}>{node}</ViewerHeader>}
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

/** The zoom slider's steps, spread evenly over the scale's logarithm, so each part of it zooms alike. */
const SLIDER_STEPS = 200
const toSlider = (scale: number, min: number) =>
  min >= MAX_ZOOM ? 0 : Math.round((Math.log(scale / min) / Math.log(MAX_ZOOM / min)) * SLIDER_STEPS)
const fromSlider = (value: number, min: number) => min * (MAX_ZOOM / min) ** (value / SLIDER_STEPS)
const percent = (scale: number) => `${Math.round(scale * 100)}%`

/**
 * A portrait's name and one toolbar row over its whole image (owner, 2026-11-02): a zoom
 * slider with the scale shown beside it, Fit and 100%, then the host's buttons (`close`).
 * Fit shows all of it, as large as the box allows (a small one enlarged at most
 * `MAX_UPSCALE` times); 100% is one image pixel to a CSS pixel. The wheel, a drag, a pinch
 * and a double click or tap work on the image itself (ImageViewer.tsx).
 */
export function PortraitView({
  portrait,
  title,
  toggle,
  close,
  alignToChatHeader = false,
  header = (node) => node,
  src,
  alt = `${portrait.name}'s full ${portrait.image ? "image" : "portrait"}`
}: {
  portrait: Portrait
  title: (name: string) => ReactNode
  toggle?: ReactNode
  close: ReactNode
  alignToChatHeader?: boolean
  header?: (node: ReactElement) => ReactNode
  /** The image's own address, in place of its media's: a local copy not uploaded yet. */
  src?: string | undefined
  alt?: string
}) {
  const { mode } = useImagePrefs()
  const [zoom, setZoom] = useState<Zoom>("fit")
  const [scale, setScale] = useState<{ value: number; natural: NaturalSize | null; min: number } | null>(null)
  src = src ?? portrait.src
  const shows = portrait.mediaId !== null || src !== undefined
  const visible = shows && mode === "show"
  const shownScale = scale?.value ?? 1
  const min = scale?.min ?? 1
  const atOwnSize = zoom !== "fit" && Math.abs(shownScale - 1) < 0.000001
  return (
    <div className="@container flex min-h-0 flex-1 flex-col overflow-hidden">
      {header(
        <div
          data-portrait-toolbar
          className={`flex flex-wrap items-center gap-x-3 border-b border-border px-3 ${alignToChatHeader ? "h-shell-header" : "min-h-14 @max-[22rem]:pt-2"}`}
        >
          {title(portrait.name)}
          {visible && scale && (
            // Narrower than its row (a narrow column), the zoom takes a row of its own under the name.
            <div
              data-zoom-controls
              className={`flex h-14 items-center gap-3 @max-[22rem]:order-last @max-[22rem]:w-full ${alignToChatHeader ? "@max-[22rem]:h-8" : ""}`}
            >
              <div data-zoom-group className="flex min-w-0 items-center gap-1 @max-[22rem]:flex-1">
                <ToolbarSlider
                  label="Zoom"
                  hint="Zoom: drag to enlarge or shrink the picture. The wheel and a pinch zoom too."
                  className="w-20 shrink-0 @max-[22rem]:w-auto @max-[22rem]:min-w-0 @max-[22rem]:flex-1"
                  value={toSlider(shownScale, min)}
                  min={0}
                  max={SLIDER_STEPS}
                  step={1}
                  valueText={(value) =>
                    percent(value === toSlider(shownScale, min) ? shownScale : fromSlider(value, min))
                  }
                  onValueChange={(value) => {
                    const next = fromSlider(value, min)
                    // The slider's low end is the fit, unless the fit enlarges the picture (then 100%).
                    setZoom(value === 0 && min < 1 ? "fit" : next)
                  }}
                />
                <Tooltip
                  label={
                    scale.natural
                      ? `Shown at ${percent(shownScale)} of its own size, ${scale.natural.width} × ${scale.natural.height} pixels`
                      : `Shown at ${percent(shownScale)} of its own size`
                  }
                >
                  <span
                    data-zoom-percent
                    className="w-11 shrink-0 text-right text-xs leading-8 text-muted tabular-nums"
                  >
                    {percent(shownScale)}
                  </span>
                </Tooltip>
              </div>
              <Segmented
                label="Zoom presets"
                inlineDescription={false}
                value={zoom === "fit" ? "fit" : atOwnSize ? "actual" : null}
                onValueChange={(value) => setZoom(value === "fit" ? "fit" : 1)}
                options={[
                  {
                    value: "fit",
                    label: <span className="font-medium">Fit</span>,
                    description: "Fit: show all of the picture"
                  },
                  {
                    value: "actual",
                    label: <span className="font-medium">100%</span>,
                    description: "100%: one pixel of the picture to one pixel of the screen"
                  }
                ]}
              />
            </div>
          )}
          {toggle}
          <div className="flex shrink-0 items-center pl-2">{close}</div>
        </div>
      )}
      {mode !== "show" && (
        <p className="px-3 pt-2 text-sm text-muted">
          Images are {mode === "blur" ? "blurred" : "hidden"} in this browser. Use the images toggle to show them.
        </p>
      )}
      <div className="min-h-0 flex-1 p-2">
        {shows ? (
          <ImageViewer
            src={src ?? pictureUrl(portrait.mediaId!, portrait.picture)}
            {...(src !== undefined
              ? {}
              : {
                  placeholder: portrait.picture
                    ? pictureUrl(portrait.mediaId!, portrait.picture)
                    : mediaUrl(portrait.mediaId!, 768)
                })}
            alt={alt}
            zoom={visible ? zoom : "fit"}
            onZoom={(next) => visible && setZoom(next)}
            onScale={(value, natural, least) => setScale({ value, natural, min: least })}
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

/**
 * A look at an image that doesn't open in the column (one attached to the composer, not sent
 * yet; owner, 2026-11-07): the column's viewer, with its zoom, Fit, 100%, wheel, drag and pinch,
 * in a modal over the page. `src` shows a local copy still uploading.
 */
export function PicturePeek({
  picture,
  src,
  onClose
}: {
  picture: Portrait | null
  src?: string | undefined
  onClose: () => void
}) {
  return (
    <Dialog open={picture !== null} onOpenChange={(open) => !open && onClose()} title={picture?.name ?? ""} wide>
      {picture && (
        <div
          data-picture-peek
          className="flex h-[min(70dvh,48rem)] min-h-0 shrink-0 flex-col overflow-hidden rounded-md border border-border"
        >
          <PortraitView
            portrait={picture}
            src={src}
            alt={`${picture.name} at full size`}
            title={() => null}
            close={null}
          />
        </div>
      )}
    </Dialog>
  )
}

/** Shared 2:3 frame for every cropped card portrait. */
export function PortraitFrame({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`relative inline-flex aspect-[2/3] shrink-0 overflow-hidden ${className}`}>{children}</span>
}
