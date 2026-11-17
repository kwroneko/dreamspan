import type { CardAsset } from "@rp/shared/docs/card.ts"
import { AssetKind, type AssetChange, assetGroup, galleryAssets } from "@rp/shared/gallery.ts"
import { useLayoutEffect, useRef, useState } from "react"
import { Effect } from "effect"
import { isAppDrag } from "../../ui/appDrags.ts"
import { ContentImage } from "../../ui/ContentImage.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"
import { Menu, MenuItem, MenuRadioGroup, MenuSubmenu } from "../../ui/Menu.tsx"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { usePortraitViewer } from "../../ui/Portrait.tsx"
import { PICTURE_ACCEPT } from "../../ui/portraitParts.ts"
import { mediaUrl } from "../../ui/mediaImage.ts"
import { revealAdded } from "../../ui/reveal.ts"
import type { CardTabProps } from "../editor/cardTabs.ts"
import { useEditorState, useValue } from "../editor/store.ts"
import { galleryPortraits } from "./portraits.ts"

export function Gallery({ store, call }: Pick<CardTabProps, "store" | "call">) {
  const { snapshot } = useEditorState(store)
  const assets = useValue<ReadonlyArray<CardAsset> | undefined>(store, ["assets"])
  const ids = useValue<Record<string, string> | undefined>(store, ["asset_media_ids"])
  const name = useValue<string>(store, ["name"]) || "Card"
  const images = galleryAssets({ assets: assets ?? [], asset_media_ids: ids ?? {} })
  const portraits = galleryPortraits(snapshot?.ref.id ?? "", {
    name,
    images: images.map((a) => ({ ...a, mediaId: ids![a.uri]! }))
  })
  const viewer = usePortraitViewer()
  const picker = useRef<HTMLInputElement>(null)
  const section = useRef<HTMLDivElement>(null)
  const [pending, setPending] = useState(false)
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rename, setRename] = useState<CardAsset | null>(null)
  const [newName, setNewName] = useState("")
  const [added, setAdded] = useState<ReadonlyArray<string>>([])
  useLayoutEffect(() => {
    if (!added.length) return
    const boxes = section.current?.querySelectorAll<HTMLElement>("[data-gallery-image]") ?? []
    for (const box of boxes) if (added.includes(box.dataset.galleryImage!)) revealAdded(box)
  }, [added])

  async function change(asset: CardAsset, change: typeof AssetChange.Type) {
    const ref = store.snapshot?.ref
    if (!ref) return
    setPending(true)
    setError(null)
    const result = await call(
      (client) =>
        client("ChangeCardAsset", { refId: ref.id, expectedRowVersion: ref.rowVersion, uri: asset.uri, change }),
      ["library", "bin"]
    )
    await store.refresh()
    if (!result.ok) setError(result.error.message)
    else {
      if (change.action === "rename") setRename(null)
      if (change.action === "remove") viewer?.close(`gallery:${ref.id}:${encodeURIComponent(asset.uri)}`)
      const fresh = await call((client) => client("GetCardGallery", { refId: ref.id }))
      if (fresh.ok) {
        const portrait = galleryPortraits(ref.id, fresh.value).find(
          (p) => p.id === `gallery:${ref.id}:${encodeURIComponent(asset.uri)}`
        )
        if (portrait) viewer?.replace(portrait.id, portrait)
      }
    }
    setPending(false)
  }
  async function add(files: ReadonlyArray<File>) {
    if (pending || !files.length) return
    setPending(true)
    setError(null)
    const before = new Set(images.map((a) => a.uri))
    try {
      for (const file of files) {
        const ref = store.snapshot?.ref
        if (!ref) break
        const query = new URLSearchParams({
          ref: ref.id,
          rowVersion: String(ref.rowVersion),
          name: file.name.replace(/\.[^.]+$/, "")
        })
        const response = await fetch(`/library/gallery?${query}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: file
        })
        if (!response.ok) {
          const body = (await response.json()) as { error?: string }
          throw new Error(body.error ?? "The image could not be added.")
        }
        await store.refresh()
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "The images could not be sent.")
    }
    await call(() => Effect.void, ["library"])
    await store.refresh()
    setAdded(
      ((store.value(["assets"]) as ReadonlyArray<CardAsset>) ?? []).filter((a) => !before.has(a.uri)).map((a) => a.uri)
    )
    setPending(false)
  }
  return (
    <div
      ref={section}
      data-gallery
      data-over={over || undefined}
      className="rounded-lg data-over:ring-2 data-over:ring-accent"
      // Only a file from outside: a picture dragged from the app opens where it's dropped instead.
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files") && !isAppDrag(e.dataTransfer)) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files") || isAppDrag(e.dataTransfer)) return
        e.preventDefault()
        setOver(false)
        void add([...e.dataTransfer.files])
      }}
    >
      <Card>
        <CardHeader
          title="Gallery"
          inline
          about="Extra pictures for this card. Click a picture to show or close it in the image viewer. Drop images here to add them."
          actions={
            <IconButton
              icon="plus"
              label="Add images"
              hint={
                pending
                  ? "The images are being saved."
                  : "Add images to this card's gallery. Choose one or more files, or drop images here."
              }
              disabled={pending || !snapshot}
              onClick={() => picker.current?.click()}
            />
          }
        />
        <input
          ref={picker}
          type="file"
          hidden
          multiple
          accept={PICTURE_ACCEPT}
          aria-label="Gallery images"
          onChange={(e) => {
            void add([...(e.currentTarget.files ?? [])])
            e.currentTarget.value = ""
          }}
        />
        {!images.length && <p className="text-sm text-muted">No extra pictures.</p>}
        <div className="flex flex-col gap-4">
          {["Portraits", "Expressions", "Backgrounds", "Other"].map((group) => {
            const members = images.filter((a) => assetGroup(a.type) === group)
            if (!members.length) return null
            return (
              <div key={group} className="flex flex-col gap-2">
                <h3 className="text-sm font-medium text-muted">{group}</h3>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-3">
                  {members.map((asset) => {
                    const portrait = portraits[images.indexOf(asset)]!
                    const open = viewer?.shown.some((e) => e.portrait.id === portrait.id) ?? false
                    return (
                      <div
                        key={asset.uri}
                        data-gallery-image={asset.uri}
                        className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-2"
                      >
                        <Tooltip
                          label={`Click to ${open ? "close" : "show"} ${asset.name || "this image"} in the image viewer.`}
                        >
                          <button
                            type="button"
                            aria-label={`View ${asset.name || "image"}`}
                            aria-pressed={open}
                            onClick={() => viewer?.open(portrait)}
                            className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-sm bg-surface-raised outline-none focus-visible:ring-2 focus-visible:ring-focus aria-pressed:ring-2 aria-pressed:ring-accent"
                          >
                            <ContentImage
                              frameClassName="size-full"
                              src={mediaUrl(ids![asset.uri]!, 192)}
                              alt={asset.name}
                              loading="lazy"
                              className="size-full object-contain"
                            />
                          </button>
                        </Tooltip>
                        <div className="flex min-w-0 items-center gap-2">
                          <span data-layout-name className="min-w-0 flex-1 truncate text-xs">
                            {asset.name || "Image"}
                          </span>
                          <Menu
                            label="Image actions"
                            hint={`Rename, change kind or remove ${asset.name || "this image"}.`}
                            trigger={
                              <IconButton
                                icon="more"
                                label={`Actions for ${asset.name || "image"}`}
                                disabled={pending}
                              />
                            }
                          >
                            <MenuItem
                              description="Change this image's name."
                              onClick={() => {
                                setRename(asset)
                                setNewName(asset.name)
                              }}
                            >
                              Rename
                            </MenuItem>
                            <MenuSubmenu label="Kind" description="Choose how this image is grouped and exported.">
                              <MenuRadioGroup
                                value={asset.type.toLowerCase()}
                                onValueChange={(kind) =>
                                  void change(asset, { action: "kind", kind: kind as typeof AssetKind.Type })
                                }
                                items={[
                                  {
                                    value: "icon",
                                    label: "Portrait",
                                    description: "An alternative portrait for this card."
                                  },
                                  {
                                    value: "user_icon",
                                    label: "User portrait",
                                    description: "A user portrait carried by this card."
                                  },
                                  {
                                    value: "emotion",
                                    label: "Expression",
                                    description: "An expression picture for this card."
                                  },
                                  {
                                    value: "background",
                                    label: "Background",
                                    description: "A background picture for this card."
                                  },
                                  { value: "other", label: "Other", description: "Another picture for this card." }
                                ]}
                              />
                            </MenuSubmenu>
                            {asset.type.toLowerCase() === "icon" && (
                              <MenuItem
                                description="Make this image the card's portrait; the current portrait becomes an alternative."
                                onClick={() => void change(asset, { action: "portrait" })}
                              >
                                Use as portrait
                              </MenuItem>
                            )}
                            <MenuItem
                              tone="danger"
                              description="Moves this image to the bin, from which it can be restored later."
                              onClick={() => void change(asset, { action: "remove" })}
                            >
                              Remove
                            </MenuItem>
                          </Menu>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}
      </Card>
      {rename && (
        <Dialog open onOpenChange={(open) => !open && setRename(null)} title="Rename image">
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              void change(rename, { action: "rename", name: newName })
            }}
          >
            <Field label="Name" about="The image's name in this gallery and in exported cards.">
              <Input autoFocus value={newName} maxLength={255} onChange={(e) => setNewName(e.currentTarget.value)} />
            </Field>
            <DialogActions>
              <Button variant="secondary" hint="Keep the image's current name." onClick={() => setRename(null)}>
                Cancel
              </Button>
              <Button type="submit" hint="Save the image's new name." disabled={pending}>
                Save name
              </Button>
            </DialogActions>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
          </form>
        </Dialog>
      )}
    </div>
  )
}
