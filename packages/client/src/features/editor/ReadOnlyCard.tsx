// A card on a card source, not in the user's cards, in the full editor (owner, 2026-11-23: it's
// for reading and inspecting it): every field shows its text and scrolls, each opens in its own
// tab, and nothing can be changed or saved (readOnly.ts, and the store keeps no change). Add to
// my cards is there, as in the side panel's view of it: once added, the tab shows the user's own
// card, which edits as any.
import { remoteOf } from "@dreamspan/shared/cardSources.ts"
import { Link, useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"
import { Avatar } from "../../ui/Avatar.tsx"
import { buttonClass } from "../../ui/Button.tsx"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { CardexCreator, CardexDetails, OpenOnCardex } from "../cardSources/CardexDetails.tsx"
import { AddRemoteCardButton, RemoteCardLine } from "../cardSources/RemoteBadge.tsx"
import { remoteImageFullUrl, remoteImageUrl } from "../cardSources/remote.ts"
import type { Caller } from "./caller.ts"
import { CardEditor } from "./CardEditor.tsx"
import { CardHeader } from "./CardNameHeader.tsx"
import { CardHeaderPortrait } from "./PortraitControls.tsx"
import { Region } from "./PresetWorkspace.tsx"
import { EditorReadOnly } from "./readOnly.ts"
import { type EditorStore, useEditorState, useText } from "./store.ts"

export function ReadOnlyCardEditor({ store, call }: { store: EditorStore; call: Caller }) {
  const { ref, doc, remoteSummary } = useEditorState(store).snapshot!
  const name = useText(store, ["name"]) || ref.label
  const from = remoteOf(ref.entityId)
  const cardex = from?.sourceId === "cardex" ? remoteSummary : undefined
  const image = remoteSummary?.image
  const navigate = useNavigate()
  const own = (refId: string) =>
    void navigate({ to: "/library/$refId", params: { refId }, replace: true, resetScroll: false })
  // The user has it already (the server answers with theirs): their card, editable, instead.
  const held = ref.id !== store.refId ? ref.id : (remoteSummary?.held?.refId ?? null)
  useEffect(() => {
    if (held) own(held)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `own` is a fresh closure each render
  }, [held])
  if (held) return null
  const portrait = (
    <Avatar
      id={ref.entityId}
      name={name}
      size="fill"
      className="size-full"
      {...(from && image
        ? {
            src: remoteImageUrl(from.sourceId, image),
            full: remoteImageFullUrl(from.sourceId, image),
            preview: true
          }
        : {})}
    />
  )
  return (
    <EditorReadOnly value>
      <Region label="Card editor" className="contents">
        <div data-read-only-card className="flex flex-col gap-6">
          <CenterHeaderContent>
            <h1 className="min-w-0 truncate text-base font-semibold">{cardex ? "Card editor" : name}</h1>
          </CenterHeaderContent>
          {from && cardex ? (
            <header data-cardex-editor-header className="@container">
              <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-3 @min-[34rem]:content-start">
                <div className="aspect-[2/3] w-18 @min-[34rem]:row-span-2 @min-[34rem]:w-22">{portrait}</div>
                <div className="flex min-w-0 flex-col gap-1">
                  <h2 className="text-xl leading-tight font-semibold [overflow-wrap:anywhere] @min-[34rem]:text-2xl">
                    {name}
                  </h2>
                  <CardexCreator summary={remoteSummary} />
                  <p className="text-sm text-muted">From cardex · not in your cards</p>
                </div>
                <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 @min-[34rem]:col-span-1">
                  <Tooltip label={`Opens a new chat with ${name}. It joins your cards when you send.`}>
                    <Link
                      to="/sources/$sourceId/cards/$remoteId/chat"
                      params={from}
                      className={`${buttonClass("primary")} pointer-coarse:h-11`}
                    >
                      Start a chat
                    </Link>
                  </Tooltip>
                  <AddRemoteCardButton
                    from={from}
                    cardName={name}
                    className="pointer-coarse:h-11"
                    onAdded={(_entityId, refId) => own(refId)}
                  />
                  <OpenOnCardex url={cardex.url} />
                  <CardexDetails name={name} remoteId={from.remoteId} listing={{ summary: cardex, doc }} />
                </div>
              </div>
            </header>
          ) : (
            <header>
              <CardHeader portrait={<CardHeaderPortrait>{portrait}</CardHeaderPortrait>}>
                <div data-card-header-row className="col-span-full">
                  <RemoteCardLine card={{ entityId: ref.entityId, name }} onAdded={(_entityId, refId) => own(refId)} />
                </div>
                <p className="text-sm text-muted">Shown for reading. Add it to your cards to edit it.</p>
              </CardHeader>
            </header>
          )}
          <CardEditor store={store} call={call} layout="page" />
        </div>
      </Region>
    </EditorReadOnly>
  )
}
