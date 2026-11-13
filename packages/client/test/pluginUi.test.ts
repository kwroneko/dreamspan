import { expect, it, vi } from "vitest"

const internal = vi.hoisted(() => ({
  pending: false,
  error: { message: "Plain failure", tag: "InternalTag", problems: ["internal detail"] },
  clearError: () => undefined,
  run: vi.fn(async () => ({ ok: false, error: { message: "Plain failure", tag: "InternalTag", problems: [] } }))
}))
vi.mock("../src/actions.tsx", () => ({ useAction: () => internal }))
import { rpc } from "../src/pluginUi.tsx"

it("returns only the declared RPC facade, including on failure", async () => {
  const action = rpc.useAction()
  expect(Object.keys(action).sort()).toEqual(["error", "pending", "run"])
  expect(action.error).toEqual({ message: "Plain failure" })
  expect(await action.run("SyntheticOperation", {})).toEqual({ ok: false })
})
