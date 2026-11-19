import type { CastCard, EntityId, ForkId, PathEntry, QueuedMessage, SlotId } from "@dreamspan/shared/chat.ts"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CastContext, castView } from "../src/features/chat/cast.ts"
import type { ComposerControlContext } from "../src/features/chat/composerControls.tsx"
import { RoundControls } from "../src/features/chat/RoundControls.tsx"
import { TooltipProvider } from "../src/ui/Tooltip.tsx"

const forkId = "fork" as ForkId
const cast = castView(
  null,
  ["Mira", "Wren", "Ash"].map((name) => ({ entityId: name as EntityId, name }) as CastCard)
)
const turn = (slot: string, speaker: string, choosing = false) =>
  ({
    slotId: slot as SlotId,
    version: {
      speakerEntityId: speaker as EntityId,
      status: choosing ? "generating" : "complete",
      ...(choosing ? { speakerPick: { by: "auto" } } : {})
    }
  }) as PathEntry

const markup = (entries: ReadonlyArray<PathEntry>, startSlotId?: SlotId, held = false) => {
  const queue = [
    {
      replySlotId: entries.at(-1)!.slotId,
      speakerEntityId: "Mira" as EntityId,
      round: { forkId, held, decides: true, ...(startSlotId ? { startSlotId } : {}) }
    }
  ] as Array<QueuedMessage>
  const context = { view: { entries, queue, forkId } } as unknown as ComposerControlContext
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(CastContext.Provider, { value: cast }, createElement(RoundControls, context))
    )
  )
}

describe("decision round history", () => {
  it("does not attribute an earlier reply to a round whose first action is still queued", () => {
    const html = markup([turn("earlier", "Ash")])
    expect(html).not.toContain("so far.")
    expect(html).toContain("Then 1 more, each chosen when it&#x27;s their turn")
  })

  it("uses the current swipe's speaker and leaves a turn being chosen unnamed", () => {
    const html = markup([turn("before", "Mira"), turn("start", "Wren"), turn("next", "Ash", true)], "start" as SlotId)
    expect(html).toContain("Wren so far. Choosing who replies now.")
    expect(html).not.toContain("Mira so far.")
    expect(html).not.toContain("Ash so far.")
  })

  it("reconstructs a held round from persisted start and selected messages after reopening", () => {
    const html = markup([turn("before", "Mira"), turn("start", "Wren"), turn("next", "Ash")], "start" as SlotId, true)
    expect(html).toContain("Wren and Ash so far.")
    expect(html).toContain("Still to reply: 1 more")
    expect(html).not.toContain("Mira, Wren")
  })
})
