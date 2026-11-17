// The sandbox's only way out (spec/FILES-AND-ENVIRONMENT.md §3.5): an HTTP proxy on a Unix
// socket bound into the sandbox, which has no network of its own. It reaches public addresses
// only. A name is resolved here, once, and the address that passed the check is the one dialled,
// so a name that resolves to loopback, the LAN, a metadata address or this host itself is refused
// (no rebinding between the check and the connection). Nothing about requests is logged.
import { lookup } from "node:dns/promises"
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http"
import { connect, isIP, type Socket } from "node:net"
import { networkInterfaces } from "node:os"
import { rm } from "node:fs/promises"
import { makeRegistry } from "@rp/shared/registry.ts"
import { isPublicMediaAddress } from "../net/externalMedia.ts"

export type Resolve = (host: string) => Promise<ReadonlyArray<string>>

const defaultResolve: Resolve = (host) =>
  lookup(host, { all: true, verbatim: true }).then((found) => found.map((entry) => entry.address))

/** This host's own addresses: a public one would reach the app itself. */
const ownAddresses = () =>
  new Set(
    Object.values(networkInterfaces())
      .flatMap((list) => list ?? [])
      .map((entry) => entry.address.toLowerCase())
  )

const bare = (host: string) => (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host)

/** Whether a command may reach this address: public, and not one of this host's. */
export const sandboxMayReach = (address: string, own: ReadonlySet<string> = ownAddresses()) =>
  isPublicMediaAddress(address) && !own.has(address.toLowerCase())

/** The addresses of `host` a command may reach, in the resolver's order; empty: refused. */
export const reachableAddresses = async (host: string, resolve: Resolve = defaultResolve) => {
  const name = bare(host).toLowerCase()
  if (name === "" || name === "localhost" || name.endsWith(".localhost")) return []
  const own = ownAddresses()
  const found = isIP(name) ? [name] : await resolve(name).catch(() => [])
  return found.filter((address) => sandboxMayReach(address, own))
}

export interface SandboxProxy {
  readonly socketPath: string
  /** Stops accepting and cuts every connection still open. */
  readonly close: () => Promise<void>
}

export interface SandboxNetwork {
  readonly id: string
  /** User-facing: what commands can reach. */
  readonly explanation: string
  readonly open: (socketPath: string) => Promise<SandboxProxy>
}

const REFUSED = "Only public internet addresses can be reached from commands.\n"
const PORT_REFUSED = "Commands can open HTTPS (port 443) and HTTP (port 80) tunnels only.\n"

/**
 * The ports a CONNECT tunnel may reach: HTTPS and HTTP. Any other port would be raw TCP from the
 * server's address (SSH, SMTP, scanning), which the tool's description says commands don't have.
 */
export const CONNECT_PORTS: ReadonlySet<number> = new Set([443, 80])
/**
 * Connections one command may hold open through its proxy at once. Each costs the server's
 * process two descriptors; unbounded, a command could exhaust them for every account.
 */
export const PROXY_MAX_CONNECTIONS = 256

/** A public-only proxy (HTTP CONNECT and plain HTTP with absolute URLs) on a Unix socket. */
const openPublicProxy = async (socketPath: string, resolve: Resolve = defaultResolve): Promise<SandboxProxy> => {
  const sockets = new Set<Socket>()
  const track = (socket: Socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  }
  const server = createServer()
  server.maxConnections = PROXY_MAX_CONNECTIONS
  server.on("connection", track)
  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on("error", () => client.destroy())
    const target = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(req.url ?? "")
    const port = Number(target?.[2])
    if (!target || port < 1 || port > 65535) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n")
      return
    }
    if (!CONNECT_PORTS.has(port)) {
      client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${PORT_REFUSED}`)
      return
    }
    void reachableAddresses(target[1]!, resolve).then((addresses) => {
      const address = addresses[0]
      if (address === undefined) {
        client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${REFUSED}`)
        return
      }
      const upstream = connect({ host: address, port })
      track(upstream)
      let connected = false
      upstream.once("connect", () => {
        connected = true
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        if (head.length) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      upstream.on("error", () => {
        if (!connected) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
        else client.destroy()
      })
      client.on("close", () => upstream.destroy())
    })
  })
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    let url: URL
    try {
      url = new URL(req.url ?? "")
    } catch {
      res.writeHead(400).end()
      return
    }
    if (url.protocol !== "http:") {
      res.writeHead(400).end()
      return
    }
    void reachableAddresses(url.hostname, resolve).then((addresses) => {
      const address = addresses[0]
      if (address === undefined) {
        res.writeHead(403, { "content-type": "text/plain" }).end(REFUSED)
        return
      }
      const headers = { ...req.headers }
      delete headers["proxy-connection"]
      delete headers["proxy-authorization"]
      const upstream = httpRequest(
        {
          host: address,
          port: url.port === "" ? 80 : Number(url.port),
          method: req.method,
          path: url.pathname + url.search,
          headers,
          setHost: false,
          // No shared pool: a command's sockets close with its requests, not later.
          agent: false
        },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers)
          answer.pipe(res)
        }
      )
      upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()))
      req.pipe(upstream)
    })
  })
  await rm(socketPath, { force: true })
  await new Promise<void>((done, fail) => {
    server.once("error", fail)
    server.listen(socketPath, () => done())
  })
  return {
    socketPath,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => done())
      }).then(() => rm(socketPath, { force: true }))
  }
}

/** The network policies commands can run under (§3.3: `sandboxNetwork`, separately replaceable). */
export const sandboxNetworks = makeRegistry<SandboxNetwork>([
  {
    id: "public",
    explanation: "Commands can use the internet. They can't reach this server, your other devices or other accounts.",
    open: (socketPath) => openPublicProxy(socketPath)
  }
])

/**
 * Runs inside the sandbox (as its first process): listens on 127.0.0.1:<port>, where the
 * proxy variables point, and carries each connection to the proxy's socket.
 */
export const BRIDGE_SOURCE = `import { createServer, connect } from "node:net"
const [socketPath, port] = process.argv.slice(2)
const server = createServer((client) => {
  const upstream = connect(socketPath)
  client.pipe(upstream); upstream.pipe(client)
  client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy())
})
server.listen(Number(port), "127.0.0.1", () => process.stdout.write("ready\\n"))
`
