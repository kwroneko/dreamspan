// A card on a card source, not in the user's cards, in the full editor (owner, 2026-11-23: it's
// for reading and inspecting it): every field shows its text and scrolls, each opens in its own
// tab, and nothing can be changed or saved (readOnly.ts, and the store keeps no change). Add to
// my cards is there, as in the side panel's view of it: once added, the tab shows the user's own
// card, which edits as any.
import { remoteOf } from "@dreamspan/shared/cardSources.ts"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { Avatar } from "../../ui/Avatar.tsx"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import { RemoteCardLine } from "../cardSources/RemoteBadge.tsx"
import { remoteImageFullUrl, remoteImageUrl, useSourceCall } from "../cardSources/remote.ts"
import type { Caller } from "./caller.ts"
import { CardEditor } from "./CardEditor.tsx"
import { CardHeader } from "./CardNameHeader.tsx"
import { CardHeaderPortrait } from "./PortraitControls.tsx"
import { Region } from "./PresetWorkspace.tsx"
import { EditorReadOnly } from "./readOnly.ts"
import { type EditorStore, useEditorState, useText } from "./store.ts"

/** The card's picture on its source, as the source's card page shows it; null until known, or without one. */
function useSourcePicture(entityId: string) {
  const call = useSourceCall()
  const [picture, setPicture] = useState<{
    readonly id: string
    readonly src: ((width: number) => string) | null
    readonly full: string | null
  } | null>(null)
  useEffect(() => {
    const from = remoteOf(entityId)
    if (!from) return
    const controller = new AbortController()
    void call((client) => client("SourceCard", from), controller.signal).then((out) => {
      if (out?.ok)
        setPicture({
          id: entityId,
          src: out.value.summary.image ? remoteImageUrl(from.sourceId, out.value.summary.image) : null,
          full: out.value.summary.image ? remoteImageFullUrl(from.sourceId, out.value.summary.image) : null
        })
    })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `call` is a fresh closure each render
  }, [entityId])
  return picture?.id === entityId ? picture : null
}

export function ReadOnlyCardEditor({ store, call }: { store: EditorStore; call: Caller }) {
  const ref = useEditorState(store).snapshot!.ref
  const name = useText(store, ["name"]) || ref.label
  const picture = useSourcePicture(ref.entityId)
  const navigate = useNavigate()
  const own = (refId: string) =>
    void navigate({ to: "/library/$refId", params: { refId }, replace: true, resetScroll: false })
  // The user has it already (the server answers with theirs): their card, editable, instead.
  const held = ref.id !== store.refId ? ref.id : null
  useEffect(() => {
    if (held) own(held)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `own` is a fresh closure each render
  }, [held])
  return (
    <EditorReadOnly value>
      <Region label="Card editor" className="contents">
        <div data-read-only-card className="flex flex-col gap-6">
          <CenterHeaderContent>
            <h1 className="min-w-0 truncate text-base font-semibold">{name}</h1>
          </CenterHeaderContent>
          <header className="flex flex-col gap-1">
            <CardHeader
              portrait={
                <CardHeaderPortrait>
                  {/* A click opens the whole picture, as every other portrait's does. */}
                  <Avatar
                    id={ref.entityId}
                    name={name}
                    size="fill"
                    className="size-full"
                    {...(picture?.src && picture.full ? { src: picture.src, full: picture.full, preview: true } : {})}
                  />
                </CardHeaderPortrait>
              }
            >
              <div data-card-header-row className="col-span-full">
                <RemoteCardLine card={{ entityId: ref.entityId, name }} onAdded={(_entityId, refId) => own(refId)} />
              </div>
              <p className="text-sm text-muted">Shown for reading. Add it to your cards to edit it.</p>
            </CardHeader>
          </header>
          <CardEditor store={store} call={call} layout="page" />
        </div>
      </Region>
    </EditorReadOnly>
  )
}
