import { execFile } from "node:child_process"
import { createServer, type Server } from "node:http"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const run = promisify(execFile)

async function occupy(): Promise<Server> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const server = createServer((_request, response) => response.writeHead(200).end("foreign-health-probe"))
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(20001 + Math.floor(Math.random() * 11980), "127.0.0.1", resolve)
      })
      return server
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error
    }
  }
  throw new Error("No free port for the occupied-port fixture")
}

test("a healthy foreign listener cannot stand in for the browser test server", async () => {
  const foreign = await occupy()
  try {
    const address = foreign.address()
    if (!address || typeof address === "string") throw new Error("Expected a TCP port")
    const { stdout } = await run(process.execPath, [
      fileURLToPath(new URL("./support/serverPortProbe.ts", import.meta.url)),
      String(address.port)
    ])
    const result = JSON.parse(stdout) as { occupied: number; actual: number }
    expect(result.occupied).toBe(address.port)
    expect(result.actual).not.toBe(address.port)
  } finally {
    await new Promise<void>((resolve, reject) => foreign.close((error) => (error ? reject(error) : resolve())))
  }
})
