import { expect, test } from "@playwright/test"
import { resolve } from "node:path"
import { createServer } from "vite"
import { ADMIN, serverPerFile, withAdmin } from "./support/server.ts"
import { asUser } from "./support/rpc.ts"
import { pluginFiles } from "./support/plugin.ts"

const server = serverPerFile(withAdmin)
test("Vite cannot serve inactive plugin sources through its filesystem routes", async ({ request }) => {
  test.setTimeout(120_000)
  const id = "dev-disabled"
  const commit = await asUser(server(), ADMIN.handle, ADMIN.password, (api) =>
    api.CreatePlugin({
      scope: "instance",
      id,
      files: pluginFiles(id, 'export const activate = () => { console.log("Synthetic disabled module") };', [])
    })
  )
  // The normal workspace allowlist includes DATA_DIR when it is ./data. Put our
  // synthetic data outside the repository and explicitly reproduce that allowance.
  const vite = await createServer({
    root: resolve(import.meta.dirname, ".."),
    server: {
      host: "127.0.0.1",
      port: 0,
      fs: { allow: [resolve(import.meta.dirname, "../../.."), server().dataDir] },
      proxy: { "/plugins": { target: server().url } }
    }
  })
  try {
    await vite.listen()
    const base = vite.resolvedUrls!.local[0]!.replace(/\/$/, "")
    const source = `${server().dataDir}/plugins/instance/${id}/client.tsx`
    for (const suffix of ["", "?import", "?raw", "?url"]) {
      const response = await request.get(`${base}/@fs/${source}${suffix}`)
      expect(response.status()).toBe(403)
      expect(await response.text()).not.toContain("Roll dev-disabled")
    }
    expect((await request.get(`${base}/plugins/instance/${id}/${commit}/client.mjs`)).status()).toBe(401)
    expect((await request.get(`${base}/plugin-host.mjs`)).headers()["content-type"]).toContain("text/javascript")
  } finally {
    await vite.close()
  }
})
