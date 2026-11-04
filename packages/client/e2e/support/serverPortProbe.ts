// A fresh process lets the test deterministically occupy the first random port.
import assert from "node:assert/strict"

const occupied = Number(process.argv[2])
Math.random = () => (occupied - 20001 + 0.25) / 12000
const { startServer } = await import("./server.ts")
const server = await startServer()
try {
  assert.notEqual(server.port, occupied, "the harness must not borrow another server's health response")
  assert.equal((await fetch(`${server.url}/healthz`)).status, 200)
  console.log(JSON.stringify({ occupied, actual: server.port }))
} finally {
  await server.stop()
}
