import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
import { register } from "../src/features/status.tsx"
import { routes } from "../src/routes.tsx"

vi.mock("@effect/atom-react", () => ({ useAtomRefresh: () => () => {} }))
vi.mock("../src/rpc.ts", () => ({ AppClient: { query: (name: string) => name } }))
vi.mock("../src/session.ts", () => ({
  useSession: () => ({ user: { displayName: "Test reader", role: "user" } })
}))
vi.mock("../src/features/shell.tsx", () => ({ appBanners: {}, useTitle: () => {} }))
vi.mock("../src/actions.tsx", () => ({
  AsyncView: ({ atom, children }: { atom: string; children: (health: unknown) => ReactNode }) =>
    atom === "Health" ? children({ version: "9.8.7", uptimeMs: 0, eventLoopP99Ms: 0 }) : null
}))

it("shows the running server's version from Health", () => {
  register()
  const page = routes.get("settings.status")!
  const html = renderToStaticMarkup(createElement(page.component))
  expect(html).toContain("Version</dt><dd>9.8.7</dd>")
  expect(html).not.toContain(">Updates<")
})
