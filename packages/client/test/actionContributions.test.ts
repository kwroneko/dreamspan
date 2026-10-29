import {
  invokePendingComposer,
  pendingComposerControls,
  type PendingComposerContext
} from "../src/features/chat/pendingComposerControls.tsx"
import { Effect } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  availableComposerControls,
  composerControls,
  ComposerControls,
  invokeComposerControl,
  type ComposerControlContext
} from "../src/features/chat/composerControls.tsx"
import {
  availableMessageActions,
  messageActions,
  MessageActions,
  type MessageActionContext
} from "../src/features/chat/messageActions.tsx"
import { registerComposerControls } from "../src/features/chat/registerComposerControls.tsx"
import { registerMessageActions } from "../src/features/chat/registerMessageActions.tsx"
import { TooltipProvider } from "../src/ui/Tooltip.tsx"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})

const scoped = (install: () => () => void) =>
  Effect.acquireRelease(Effect.sync(install), (dispose) => Effect.sync(dispose))
const markup = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, element))

describe("composer contributions", () => {
  let dispose: Array<() => void>
  beforeEach(() => {
    dispose = registerComposerControls()
  })
  afterEach(() => {
    for (const close of dispose.reverse()) close()
  })

  it("uses a scoped plugin for both the rendered control and Enter, then restores the default", async () => {
    const send = vi.fn(async () => {})
    const alternative = vi.fn()
    const context = {
      guidance: false,
      hasText: true,
      send,
      sendLabel: "Send",
      sendHint: "Send",
      ready: true
    } as unknown as ComposerControlContext
    const original = composerControls.get("composer.send")!
    expect(markup(createElement(ComposerControls, { placement: "actions", context }))).toContain('aria-label="Send"')
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* scoped(() =>
            composerControls.register({
              ...original,
              component: () => createElement("p", null, "Synthetic send"),
              run: alternative
            })
          )
          yield* scoped(() => composerControls.disable("composer.generate"))
          expect(markup(createElement(ComposerControls, { placement: "actions", context }))).toBe(
            "<p>Synthetic send</p>"
          )
          invokeComposerControl("composer.send", context, "keyboard")
          invokeComposerControl("composer.send", context, "button")
          expect(alternative.mock.calls).toEqual([
            [context, "keyboard"],
            [context, "button"]
          ])
          expect(send).not.toHaveBeenCalled()
        })
      )
    )
    expect(composerControls.get(original.id)).toBe(original)
    await invokeComposerControl(original.id, context, "keyboard")
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("disables Enter with its control, supports peers and observes guidance availability", async () => {
    const send = vi.fn(async () => {})
    const context = { guidance: false, send } as unknown as ComposerControlContext
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* scoped(() => composerControls.disable("composer.send"))
          yield* scoped(() =>
            composerControls.register({
              id: "synthetic.control",
              placement: "actions",
              order: 1,
              component: () => createElement("p", null, "Peer")
            })
          )
          expect(availableComposerControls("actions", context)[0]?.id).toBe("synthetic.control")
          expect(availableComposerControls("actions", context).some((entry) => entry.id === "composer.send")).toBe(
            false
          )
          invokeComposerControl("composer.send", context, "keyboard")
          expect(send).not.toHaveBeenCalled()
        })
      )
    )
    invokeComposerControl("composer.send", { ...context, guidance: true }, "keyboard")
    expect(send).not.toHaveBeenCalled()
    await invokeComposerControl("composer.send", context, "keyboard")
    expect(send).toHaveBeenCalledTimes(1)
    expect(composerControls.get("synthetic.control")).toBeUndefined()
  })

  it("pending Enter follows guidance through overridable registered actions", async () => {
    const start = vi.fn(async () => {})
    const context = { guidance: false, start } as unknown as PendingComposerContext
    await invokePendingComposer(context)
    await invokePendingComposer({ ...context, guidance: true })
    expect(start.mock.calls).toEqual([["send"], ["generate"]])
    const close = pendingComposerControls.disable("pending.generate")
    await invokePendingComposer({ ...context, guidance: true })
    expect(start).toHaveBeenCalledTimes(2)
    close()
  })

  it("keeps Stop exclusively on versions, even while the selected leaf generates", () => {
    const context = {
      leafGenerating: true,
      leaf: { version: { writer: "model" } }
    } as unknown as ComposerControlContext
    expect(composerControls.get("composer.stop")).toBeUndefined()
    expect(availableComposerControls("actions", context).map((entry) => entry.id)).not.toContain("composer.stop")
  })

  it("preserves the empty-text difference between Enter and the reply-now button", async () => {
    const send = vi.fn(async () => {})
    const replyNow = vi.fn(async () => {})
    const context = { guidance: false, hasText: false, send, replyNow } as unknown as ComposerControlContext
    await invokeComposerControl("composer.send", context, "keyboard")
    expect(send).toHaveBeenCalledTimes(1)
    expect(replyNow).not.toHaveBeenCalled()
    await invokeComposerControl("composer.send", context, "button")
    expect(replyNow).toHaveBeenCalledTimes(1)
  })
})

describe("message action contributions", () => {
  let dispose: Array<() => void>
  beforeEach(() => {
    dispose = registerMessageActions()
  })
  afterEach(() => {
    for (const close of dispose.reverse()) close()
  })
  const context = {
    entry: { versionCount: 1, version: { context: {} } },
    generating: false
  } as unknown as MessageActionContext

  it("renders a scoped replacement in the actual message host and restores the built-in", async () => {
    const original = messageActions.get("message.edit")!
    // Isolate this host from unrelated menu/router/provider components.
    for (const action of messageActions.list()) if (action !== original) dispose.push(messageActions.disable(action.id))
    expect(markup(createElement(MessageActions, { context }))).toContain('aria-label="Edit"')
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* scoped(() =>
            messageActions.register({
              ...original,
              toolbar: ({ entry }) => createElement("p", null, `Synthetic edit: ${entry.versionCount}`)
            })
          )
          yield* scoped(() =>
            messageActions.register({ id: "synthetic.peer", order: 0, toolbar: () => createElement("p", null, "Peer") })
          )
          expect(markup(createElement(MessageActions, { context }))).toBe("<p>Peer</p><p>Synthetic edit: 1</p>")
        })
      )
    )
    expect(messageActions.get(original.id)).toBe(original)
    expect(markup(createElement(MessageActions, { context }))).toContain('aria-label="Edit"')
    expect(messageActions.get("synthetic.peer")).toBeUndefined()
  })

  it("one inspector registration removes and restores both its menu and toolbar offers", async () => {
    const original = messageActions.get("message.context")!
    expect(original.toolbar).toBeDefined()
    expect(original.menu).toBeDefined()
    expect(availableMessageActions(context)).toContain(original)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* scoped(() => messageActions.disable(original.id))
          expect(availableMessageActions(context)).not.toContain(original)
          expect(messageActions.get(original.id)).toBeUndefined()
        })
      )
    )
    expect(availableMessageActions(context)).toContain(original)
    expect(
      availableMessageActions({
        ...context,
        entry: { ...context.entry, version: { ...context.entry.version, context: null } }
      })
    ).not.toContain(original)
  })
})
