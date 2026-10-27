// The full stored image, independent of the chat's display crop. Its context lets stock
// avatars open the chat panel without making every avatar (inside a picker, say) a button.
import { useSearch } from "@tanstack/react-router"
import { createContext, type ReactNode, useContext, useState } from "react"
import { Button } from "./Button.tsx"
import { initials } from "./Avatar.tsx"
import { useImagePrefs } from "./imagePrefs.ts"
import { Sheet } from "./Sheet.tsx"
import { mediaUrl, useMediaWidth } from "./mediaImage.ts"

interface Portrait {
  readonly id: string
  readonly name: string
  readonly mediaId: string | null
}
const Context = createContext<{ portrait: Portrait | null; open: (portrait: Portrait) => void } | null>(null)

export function PortraitProvider({
  children,
  onOpen,
  faces
}: {
  children: ReactNode
  onOpen: (id: string) => void
  faces: ReadonlyArray<Portrait>
}) {
  const search = useSearch({ strict: false }) as { portrait?: unknown }
  const [clicked, setClicked] = useState<Portrait | null>(null)
  const portrait =
    faces.find((face) => face.id === search.portrait) ?? (clicked?.id === search.portrait ? clicked : null)
  return (
    <Context
      value={{
        portrait,
        open: (next) => {
          setClicked(next)
          onOpen(next.id)
        }
      }}
    >
      {children}
    </Context>
  )
}

export const useOpenPortrait = () => useContext(Context)?.open

export function PortraitView() {
  const portrait = useContext(Context)?.portrait
  const { mode } = useImagePrefs()
  const [full, setFull] = useState(false)
  const { ref, width } = useMediaWidth()
  if (!portrait)
    return (
      <p className="text-sm text-muted">
        Click a portrait in a message, the header or Cast to see the whole image here.
      </p>
    )
  const image = (natural = false) => (
    <div
      className={`relative flex items-center justify-center ${natural ? "min-h-full w-max min-w-full" : "h-full w-full"}`}
    >
      {portrait.mediaId && (natural || width !== undefined) ? (
        <>
          <img
            src={mediaUrl(portrait.mediaId, natural ? undefined : width)}
            decoding="async"
            alt={`${portrait.name}'s full portrait`}
            className={natural ? "max-w-none shrink-0" : "h-full w-full object-contain"}
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
  )
  return (
    <section aria-label={`${portrait.name}'s portrait`} className="flex h-full min-h-0 flex-col gap-3">
      <h2 className="text-lg font-semibold">{portrait.name}</h2>
      <Button disabled={!portrait.mediaId || mode !== "show"} onClick={() => setFull(true)}>
        Open full size
      </Button>
      {mode !== "show" && (
        <p className="text-sm text-muted">
          Images are {mode === "blur" ? "blurred" : "hidden"} in this browser. Use the images toggle to show them.
        </p>
      )}
      {!portrait.mediaId && <p className="text-sm text-muted">This card has no image.</p>}
      <button
        ref={ref}
        type="button"
        aria-label={`Open ${portrait.name}'s portrait full size`}
        disabled={!portrait.mediaId || mode !== "show"}
        onClick={() => setFull(true)}
        className="min-h-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {image()}
      </button>
      {full && (
        <Sheet open onOpenChange={setFull} title={`${portrait.name} — full size`}>
          <div className="min-h-0 flex-1 overflow-auto">{image(true)}</div>
        </Sheet>
      )}
    </section>
  )
}
