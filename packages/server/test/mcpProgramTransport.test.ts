// A local program's transport and its limits (spec/MCP.md §2.2), without the sandbox: a fake
// process over pipes. Whatever the program writes, nothing throws out of the stream listeners
// (an uncaught throw there would end the whole server): a message over the limit stops the
// program by its process and ends the call waiting on it; a bad line or a failing handler is
// reported, and reading goes on. Its error output is shown with its owner's secrets scrubbed.
import { assert, describe, it } from "@effect/vitest"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import { PassThrough } from "node:stream"
import {
  LineBuffer,
  MessageTooLong,
  OutputRing,
  PROGRAM_MESSAGE_LIMIT,
  programEnvProblem,
  ProgramTransport
} from "../src/mcp/stdio.ts"
import type { SandboxProcess } from "../src/sandbox/registry.ts"

const fakeProcess = () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let finish: (end: { exitCode: number | null; memoryCapped: boolean }) => void = () => undefined
  const exited = new Promise<{ exitCode: number | null; memoryCapped: boolean }>((resolve) => (finish = resolve))
  const kills: Array<number> = []
  const process: SandboxProcess = {
    pid: 4242,
    stdin,
    stdout,
    stderr,
    exited,
    kill: () => {
      kills.push(4242)
      finish({ exitCode: null, memoryCapped: false })
    }
  }
  return { process, stdout, stderr, kills, finish }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe("a local program's transport", () => {
  it("a message over the limit stops the program and ends its call, and nothing throws", async () => {
    const fake = fakeProcess()
    const ring = new OutputRing()
    const transport = new ProgramTransport(async () => fake.process, ring)
    const errors: Array<Error> = []
    const messages: Array<JSONRPCMessage> = []
    let closed = false
    transport.onerror = (error) => errors.push(error)
    transport.onmessage = (message) => messages.push(message)
    transport.onclose = () => (closed = true)
    await transport.start()
    fake.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`)
    // Over the limit, in pieces and with no newline, as a large tool result would come.
    const piece = Buffer.alloc(1024 * 1024, "x")
    for (let sent = 0; sent <= PROGRAM_MESSAGE_LIMIT; sent += piece.length) fake.stdout.write(piece)
    await tick()
    await tick()
    assert.lengthOf(messages, 1)
    assert.deepStrictEqual(fake.kills, [4242])
    assert.isNotNull(transport.ended)
    assert.include(transport.ended!.message, "longer than 8 MB")
    assert.isTrue(closed)
    assert.isFalse(ring.running)
    assert.include(ring.text(), "longer than 8 MB")
    // A call sent after it ended is refused at once.
    const refused = await transport.send({ jsonrpc: "2.0", id: 2, method: "ping" }).then(
      () => null,
      (error: Error) => error
    )
    assert.strictEqual(refused?.name, "ProgramEnded")
  })

  it("a bad line and a failing handler are reported, and reading goes on", async () => {
    const fake = fakeProcess()
    const transport = new ProgramTransport(async () => fake.process, new OutputRing())
    const errors: Array<Error> = []
    const messages: Array<JSONRPCMessage> = []
    transport.onerror = (error) => {
      errors.push(error)
      throw new Error("the error handler failed too")
    }
    transport.onmessage = (message) => {
      messages.push(message)
      if (messages.length === 1) throw new Error("the handler failed")
    }
    await transport.start()
    fake.stdout.write("not json\n\n")
    fake.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\r\n`)
    fake.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} })}\n`)
    await tick()
    assert.lengthOf(messages, 2)
    assert.lengthOf(errors, 2)
    assert.isNull(transport.ended)
    assert.lengthOf(fake.kills, 0)
    fake.finish({ exitCode: 0, memoryCapped: false })
  })

  it("lines are split across chunks, and one line never grows past the limit", () => {
    const lines = new LineBuffer(10)
    assert.deepStrictEqual(lines.push(Buffer.from("ab")), [])
    assert.deepStrictEqual(lines.push(Buffer.from("c\nde\r\nf")), ["abc", "de"])
    assert.deepStrictEqual(lines.push(Buffer.from("\n")), ["f"])
    assert.throws(() => lines.push(Buffer.from("x".repeat(11))), MessageTooLong)
    assert.deepStrictEqual(lines.push(Buffer.from("ok\n")), ["ok"])
  })
})

describe("a local program's error output", () => {
  it("shows its owner's variables' values scrubbed, and never half a line cut at the start", () => {
    const ring = new OutputRing()
    ring.keepSecrets(["ghp-secret-token-value"])
    ring.line("config: token=ghp-secret-token-value")
    assert.notInclude(ring.text(), "ghp-secret-token-value")
    assert.include(ring.text(), "token=[redacted]")
    // Replaced values stay scrubbed in what was written before.
    ring.keepSecrets(["another-secret"])
    assert.notInclude(ring.text(), "ghp-secret-token-value")
    // Past the 64 KiB kept, the cut line goes whole.
    const cut = new OutputRing()
    cut.keepSecrets(["ABCDEFGHIJ"])
    cut.push(Buffer.from(`ABCDEFGHIJ${"y".repeat(64 * 1024 - 5)}\nnext line\n`))
    assert.strictEqual(cut.text(), "next line\n")
  })
})

describe("a local program's variables", () => {
  it("can't be ones that change how the shell, the linker or a runtime starts", () => {
    for (const name of [
      "BASH_ENV",
      "ENV",
      "SHELLOPTS",
      "BASHOPTS",
      "BASH_FUNC_x",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "ld_preload",
      "DYLD_INSERT_LIBRARIES",
      "NODE_OPTIONS",
      "PYTHONSTARTUP",
      "PERL5OPT",
      "RUBYOPT",
      "JAVA_TOOL_OPTIONS",
      "PATH",
      "HOME",
      "LANG",
      "__RPV_X",
      "1BAD",
      "has-dash"
    ])
      assert.isNotNull(programEnvProblem(name), name)
    for (const name of ["NOTES_TOKEN", "GITHUB_TOKEN", "DEBUG", "NODE_ENV", "PYTHONPATH"])
      assert.isNull(programEnvProblem(name), name)
  })
})
