import { afterEach, expect, it, vi } from "vitest"
import { installPluginSync, listenForPluginChanges, syncClientPlugins } from "../src/pluginLifecycle.ts"

afterEach(() => vi.unstubAllGlobals())
it("announces successful local management to other tabs even without a server notice", async () => {
  const post = vi.fn(),
    apply = vi.fn(async () => undefined),
    check = vi.fn()
  let receive: (() => void) | undefined
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      postMessage = post
      close() {}
      set onmessage(value: () => void) {
        receive = value
      }
    }
  )
  installPluginSync(apply)
  listenForPluginChanges(check)
  await syncClientPlugins()
  expect(apply).toHaveBeenCalledOnce()
  expect(post).toHaveBeenCalledOnce()
  receive!()
  expect(check).toHaveBeenCalledOnce()
})
