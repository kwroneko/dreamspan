import { expect, it } from "vitest"
import { Agent } from "undici"
import { makeDispatcherPool } from "../src/net/dispatcherPool.ts"

it("caps distinct route pools, reuses hot entries and evicts idle entries", async () => {
  let time = 0
  let created = 0
  const agents: Agent[] = []
  const create = () => {
    created++
    const agent = new Agent()
    agents.push(agent)
    return agent
  }
  const pool = makeDispatcherPool(2, 100, () => time)
  const a = pool.get("a", create)
  expect(pool.get("a", create)).toBe(a)
  time++
  pool.get("b", create)
  time++
  pool.get("c", create)
  expect(created).toBe(3)
  await new Promise((done) => setImmediate(done))
  expect(agents[0]!.closed).toBe(true)
  time += 100
  pool.get("d", create)
  await pool.close()
  expect(agents.every((agent) => agent.closed)).toBe(true)
})

it("does not evict active response bodies when the route cap is reached", async () => {
  const { createServer } = await import("node:http")
  const { fetch } = await import("undici")
  let finish!: () => void
  const server = createServer((_request, response) => {
    response.writeHead(200).write("started")
    finish = () => response.end("finished")
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing address")
  const pool = makeDispatcherPool(1)
  try {
    const dispatcher = pool.get("a", () => new Agent())
    const response = await fetch(`http://127.0.0.1:${address.port}`, { dispatcher })
    expect(() => pool.get("b", () => new Agent())).toThrow("Too many active")
    expect(pool.get("a", () => new Agent())).toBe(dispatcher)
    finish()
    expect(await response.text()).toBe("startedfinished")
    expect(() => pool.get("b", () => new Agent())).not.toThrow()
  } finally {
    await pool.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
})
