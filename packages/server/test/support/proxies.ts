// Minimal local proxies for tests: an HTTP CONNECT proxy and a SOCKS5 proxy, each
// counting the tunnels it opened, so a test can prove traffic went through it.
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http"
import { type AddressInfo, connect, createServer as createTcpServer, type Socket } from "node:net"

export interface TestProxy {
  readonly url: string
  readonly tunnels: () => ReadonlyArray<string>
  readonly close: () => Promise<void>
}

const closeServer = (server: Server | ReturnType<typeof createTcpServer>, sockets: Set<Socket>) =>
  new Promise<void>((resolve) => {
    for (const socket of sockets) socket.destroy()
    server.close(() => resolve())
  })

const track = (sockets: Set<Socket>, socket: Socket) => {
  sockets.add(socket)
  socket.on("close", () => sockets.delete(socket))
}

export const startHttpProxy = (): Promise<TestProxy> =>
  new Promise((resolve) => {
    const tunnels: Array<string> = []
    const sockets = new Set<Socket>()
    // Plain http:// targets arrive as absolute-URI requests; https:// ones as CONNECT.
    const server = createHttpServer((req, res) => {
      const target = new URL(req.url ?? "")
      tunnels.push(target.host)
      const upstream = httpRequest(target, { method: req.method, headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      })
      upstream.on("error", () => res.writeHead(502).end())
      req.pipe(upstream)
    })
    server.on("connection", (socket) => track(sockets, socket))
    server.on("connect", (req, client: Socket, head) => {
      tunnels.push(req.url ?? "")
      const [host, port] = (req.url ?? "").split(":")
      const upstream = connect(Number(port), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      track(sockets, upstream)
      upstream.on("error", () => client.destroy())
      client.on("error", () => upstream.destroy())
    })
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        tunnels: () => tunnels,
        close: () => closeServer(server, sockets)
      })
    })
  })

/** SOCKS5 with optional username/password auth (RFC 1928, RFC 1929); CONNECT only. */
export const startSocks5Proxy = (auth?: { username: string; password: string }): Promise<TestProxy> =>
  new Promise((resolve) => {
    const tunnels: Array<string> = []
    const sockets = new Set<Socket>()
    const server = createTcpServer((client) => {
      track(sockets, client)
      client.on("error", () => client.destroy())
      let stage: "greeting" | "auth" | "request" = "greeting"
      let buffer = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        if (stage === "greeting") {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return
          const methods = [...buffer.subarray(2, 2 + buffer[1]!)]
          buffer = buffer.subarray(2 + buffer[1]!)
          const method = auth ? 0x02 : 0x00
          if (!methods.includes(method)) return void client.end(Buffer.from([0x05, 0xff]))
          client.write(Buffer.from([0x05, method]))
          stage = auth ? "auth" : "request"
        }
        if (stage === "auth") {
          if (buffer.length < 2) return
          const ulen = buffer[1]!
          if (buffer.length < 3 + ulen) return
          const plen = buffer[2 + ulen]!
          if (buffer.length < 3 + ulen + plen) return
          const username = buffer.subarray(2, 2 + ulen).toString()
          const password = buffer.subarray(3 + ulen, 3 + ulen + plen).toString()
          buffer = buffer.subarray(3 + ulen + plen)
          const ok = username === auth!.username && password === auth!.password
          client.write(Buffer.from([0x01, ok ? 0x00 : 0x01]))
          if (!ok) return void client.end()
          stage = "request"
        }
        if (stage === "request") {
          if (buffer.length < 5) return
          const atyp = buffer[3]!
          let host: string
          let offset: number
          if (atyp === 0x01) {
            if (buffer.length < 10) return
            host = [...buffer.subarray(4, 8)].join(".")
            offset = 8
          } else if (atyp === 0x03) {
            const len = buffer[4]!
            if (buffer.length < 7 + len) return
            host = buffer.subarray(5, 5 + len).toString()
            offset = 5 + len
          } else {
            return void client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          }
          const port = buffer.readUInt16BE(offset)
          const rest = buffer.subarray(offset + 2)
          client.off("data", onData)
          tunnels.push(`${host}:${port}`)
          const upstream = connect(port, host, () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            if (rest.length > 0) upstream.write(rest)
            upstream.pipe(client)
            client.pipe(upstream)
          })
          track(sockets, upstream)
          upstream.on("error", () => client.destroy())
        }
      }
      client.on("data", onData)
    })
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      const credentials = auth ? `${auth.username}:${auth.password}@` : ""
      resolve({
        url: `socks5://${credentials}127.0.0.1:${port}`,
        tunnels: () => tunnels,
        close: () => closeServer(server, sockets)
      })
    })
  })

/** A plain HTTP server answering every request with `respond`, counting requests. */
export const startTarget = (
  respond: (
    req: import("node:http").IncomingMessage,
    body: string
  ) => {
    status?: number
    headers?: Record<string, string>
    json: unknown
  }
) =>
  new Promise<{ url: string; requests: () => number; close: () => Promise<void> }>((resolve) => {
    let count = 0
    const sockets = new Set<Socket>()
    const server = createHttpServer((req, res) => {
      count++
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", () => {
        const answer = respond(req, body)
        res
          .writeHead(answer.status ?? 200, { "content-type": "application/json", ...answer.headers })
          .end(JSON.stringify(answer.json))
      })
    })
    server.on("connection", (socket) => track(sockets, socket))
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${port}`, requests: () => count, close: () => closeServer(server, sockets) })
    })
  })
