// A local MCP server for tests (spec/MCP.md §14 M1): the SDK's own server over both remote
// transports, Streamable HTTP at /mcp and the older HTTP+SSE at /sse, with tools a test sets
// and every HTTP request and JSON-RPC method recorded. Never a third-party server.
import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { FakeAuthServer } from "./fakeAuthServer.ts"

interface FakeMcpRequest {
  readonly httpMethod: string
  readonly path: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  /** The JSON-RPC methods the request carried (none for a stream's GET). */
  readonly methods: ReadonlyArray<string>
}

export interface FakeMcpState {
  /** What `tools/list` answers, as the server sends it (invalid entries included). */
  tools: Array<Record<string, unknown>>
  /** Tools per `tools/list` page; 0 for one page. */
  pageSize: number
  /** Requests without `Authorization: Bearer <key>` get a 401. */
  key: string | null
  /**
   * Signing in with this authorization server (spec/MCP.md §2.4): the server publishes its
   * protected-resource metadata naming it, and answers only tokens it issued, else 401.
   */
  auth: FakeAuthServer | null
  /** Which transports answer; the other paths answer 404. */
  streamable: boolean
  /** Streamable HTTP served without session IDs. */
  stateless: boolean
  sse: boolean
  /** `tools/list` never answers. */
  hangList: boolean
  /** Every request gets this status, its body naming the request's Authorization header. */
  failStatus: number | null
  /** A transport failure for a tools/call POST, if the callback returns one. */
  failCall: (() => { status: number; body: string } | null) | null
  /** Every request is redirected here. */
  redirect: string | null
  /** The instructions `initialize` answers with. */
  instructions: string | null
  /**
   * What `tools/call` answers; absent: the tool's name and arguments as text. `signal` aborts
   * when the client cancels the call.
   */
  call:
    | ((
        name: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
        /** Reports progress to the client, when it asked for it. */
        progress: (progress: number, total?: number, message?: string) => Promise<void>
      ) => Promise<Record<string, unknown>>)
    | null
}

export interface FakeMcpServer {
  readonly url: string
  readonly streamableUrl: string
  readonly sseUrl: string
  readonly state: FakeMcpState
  readonly requests: () => ReadonlyArray<FakeMcpRequest>
  /** The JSON-RPC methods received, in order. */
  readonly methods: () => ReadonlyArray<string>
  readonly reset: () => void
  /** The server forgets every Streamable HTTP session, as after a restart: their ids get 404. */
  readonly dropSessions: () => void
  /** Sends `notifications/tools/list_changed` on every open session. */
  readonly toolsChanged: () => Promise<void>
  readonly close: () => Promise<void>
}

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })

const methodsOf = (body: unknown): Array<string> =>
  (Array.isArray(body) ? body : [body]).flatMap((message) =>
    typeof message === "object" && message !== null && typeof (message as { method?: unknown }).method === "string"
      ? [(message as { method: string }).method]
      : []
  )

export const startFakeMcpServer = async (initial: Partial<FakeMcpState> = {}): Promise<FakeMcpServer> => {
  const state: FakeMcpState = {
    tools: [],
    pageSize: 0,
    key: null,
    auth: null,
    streamable: true,
    stateless: false,
    sse: true,
    hangList: false,
    failStatus: null,
    failCall: null,
    redirect: null,
    instructions: null,
    call: null,
    ...initial
  }
  const recorded: Array<FakeMcpRequest> = []
  let base = ""
  const servers = new Set<Server>()

  const mcpServer = () => {
    const server = new Server(
      { name: "fake-mcp", title: "Fake MCP", version: "1.2.3" },
      {
        capabilities: { tools: { listChanged: true } },
        ...(state.instructions ? { instructions: state.instructions } : {})
      }
    )
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      if (state.hangList) await new Promise(() => undefined)
      const start = Number(request.params?.cursor ?? 0)
      const size = state.pageSize > 0 ? state.pageSize : state.tools.length
      const page = state.tools.slice(start, start + size)
      const next = start + size < state.tools.length ? String(start + size) : undefined
      return { tools: page, ...(next === undefined ? {} : { nextCursor: next }) } as never
    })
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
      state.call
        ? ((await state.call(
            request.params.name,
            request.params.arguments ?? {},
            extra.signal,
            async (progress, total, message) => {
              const token = request.params._meta?.progressToken
              if (token === undefined) return
              await extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken: token,
                  progress,
                  ...(total === undefined ? {} : { total }),
                  ...(message === undefined ? {} : { message })
                }
              })
            }
          )) as never)
        : {
            content: [
              { type: "text", text: `${request.params.name} ${JSON.stringify(request.params.arguments ?? {})}` }
            ]
          }
    )
    servers.add(server)
    server.onclose = () => void servers.delete(server)
    return server
  }

  const streamable = new Map<string, StreamableHTTPServerTransport>()
  const sse = new Map<string, SSEServerTransport>()

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://fake")
    const raw = request.method === "POST" ? await readBody(request) : ""
    let body: unknown
    try {
      body = raw === "" ? undefined : JSON.parse(raw)
    } catch {
      body = undefined
    }
    recorded.push({
      httpMethod: request.method ?? "",
      path: url.pathname + url.search,
      headers: request.headers,
      methods: methodsOf(body)
    })
    if (state.redirect !== null) {
      response.writeHead(307, { location: state.redirect }).end()
      return
    }
    if (state.failStatus !== null) {
      response
        .writeHead(state.failStatus, { "content-type": "text/plain" })
        .end(`refused; you sent ${request.headers.authorization ?? "nothing"}`)
      return
    }
    if (state.auth !== null && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      const resource = `${base}${url.pathname.slice("/.well-known/oauth-protected-resource".length)}`
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify({ resource, authorization_servers: [state.auth.url], bearer_methods_supported: ["header"] })
        )
      return
    }
    if (state.auth !== null) {
      const presented = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1]
      if (presented === undefined || !state.auth.valid(presented)) {
        response
          .writeHead(401, {
            "content-type": "text/plain",
            "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource${url.pathname}"`
          })
          .end("unauthorized")
        return
      }
    }
    if (state.key !== null && request.headers.authorization !== `Bearer ${state.key}`) {
      response.writeHead(401, { "content-type": "text/plain" }).end("unauthorized")
      return
    }
    if (url.pathname === "/mcp" && state.streamable) {
      if (state.stateless && request.method === "GET") {
        response.writeHead(405).end()
        return
      }
      const failure = methodsOf(body).includes("tools/call") ? state.failCall?.() : null
      if (failure) {
        response.writeHead(failure.status).end(failure.body)
        return
      }
      const id = request.headers["mcp-session-id"]
      let transport = typeof id === "string" ? streamable.get(id) : undefined
      if (!transport) {
        if (typeof id === "string") {
          response.writeHead(404).end("session not found")
          return
        }
        const fresh = new StreamableHTTPServerTransport({
          ...(state.stateless ? {} : { sessionIdGenerator: () => randomUUID() }),
          onsessioninitialized: (session) => void streamable.set(session, fresh)
        })
        await mcpServer().connect(fresh)
        transport = fresh
      }
      await transport.handleRequest(request, response, body)
      return
    }
    if (url.pathname === "/sse" && request.method === "GET" && state.sse) {
      const transport = new SSEServerTransport("/messages", response)
      sse.set(transport.sessionId, transport)
      response.on("close", () => sse.delete(transport.sessionId))
      await mcpServer().connect(transport)
      return
    }
    if (url.pathname === "/messages" && request.method === "POST" && state.sse) {
      const transport = sse.get(url.searchParams.get("sessionId") ?? "")
      if (!transport) {
        response.writeHead(404).end("no such session")
        return
      }
      await transport.handlePostMessage(request, response, body)
      return
    }
    response.writeHead(404, { "content-type": "text/plain" }).end("not found")
  }

  const http = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500).end(String(error))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const { port } = http.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
  return {
    url: base,
    streamableUrl: `${base}/mcp`,
    sseUrl: `${base}/sse`,
    state,
    requests: () => recorded,
    methods: () => recorded.flatMap((entry) => entry.methods),
    reset: () => void recorded.splice(0),
    dropSessions: () => streamable.clear(),
    toolsChanged: async () => {
      for (const server of servers) await server.sendToolListChanged().catch(() => undefined)
    },
    close: async () => {
      for (const transport of streamable.values()) await transport.close().catch(() => undefined)
      for (const transport of sse.values()) await transport.close().catch(() => undefined)
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  }
}

/** A tool as a server lists it. */
export const fakeTool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `Does ${name}.`,
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  ...extra
})
