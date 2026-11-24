// @vitest-environment jsdom
// Cast's reply settings row: Who replies (`cast.reply-order`) and One reply at a time
// (`cast.one-reply`) are separate `castSections` entries, so replacing or removing one, while the
// row is shown, leaves the other mounted beside it. Synthetic data only.
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it } from "vitest"
import { ReplySettingsRow } from "../src/features/chat/CastTab.tsx"
import { castSections } from "../src/features/chat/presentation.tsx"
import { OneReplySection, ReplyOrderSection } from "../src/features/chat/ReplyOrder.tsx"
import type { ChatSession } from "../src/features/chat/session.ts"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const cast = { participants: [], playedByMe: [], absent: [] }
const snapshot = { cast }
const session = { subscribe: () => () => {}, snapshot: () => snapshot } as unknown as ChatSession

let undo: Array<() => void> = []
let host: HTMLElement
let root: Root
beforeEach(() => {
  undo.push(
    castSections.register({ id: "cast.reply-order", order: 5, component: ReplyOrderSection }),
    castSections.register({ id: "cast.one-reply", order: 6, component: OneReplySection })
  )
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(ReplySettingsRow, { session })))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  for (const dispose of undo.reverse()) dispose()
  undo = []
})

const row = () => host.querySelector('section[aria-label="Who replies"]')!
const oneReply = () => row().querySelector('[role="switch"]')
const whoReplies = () => row().querySelector('[role="combobox"]')
const replace = (id: string, text: string) => {
  const original = castSections.get(id)!
  act(() => {
    undo.push(castSections.register({ ...original, component: () => createElement("p", null, text) }))
  })
}

it("shows Who replies and One reply at a time side by side in Cast's row", () => {
  expect(whoReplies()).not.toBeNull()
  expect(oneReply()).not.toBeNull()
  expect(row().textContent).toContain("One reply at a time")
})

it("keeps One reply at a time when a plugin replaces Who replies", () => {
  replace("cast.reply-order", "Plugin reply order")
  expect(row().textContent).toContain("Plugin reply order")
  expect(whoReplies()).toBeNull()
  expect(oneReply()).not.toBeNull()
  expect(row().textContent).toContain("One reply at a time")
})

it("keeps Who replies when a plugin replaces One reply at a time", () => {
  replace("cast.one-reply", "Plugin one reply")
  expect(row().textContent).toContain("Plugin one reply")
  expect(oneReply()).toBeNull()
  expect(whoReplies()).not.toBeNull()
})

it("keeps the other when either is disabled, and leaves an empty (hidden) row with neither", () => {
  let restore = () => {}
  act(() => {
    restore = castSections.disable("cast.reply-order")
  })
  expect(whoReplies()).toBeNull()
  expect(oneReply()).not.toBeNull()
  act(() => restore())
  act(() => {
    undo.push(castSections.disable("cast.one-reply"))
  })
  expect(oneReply()).toBeNull()
  expect(whoReplies()).not.toBeNull()
  act(() => {
    undo.push(castSections.disable("cast.reply-order"))
  })
  expect(row().childElementCount).toBe(0)
  expect(row().className).toContain("empty:hidden")
})
