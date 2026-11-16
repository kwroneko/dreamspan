// The MCP baseline (spec/MCP.md §12, M0) on a bare connection: every trigger, the checks that
// carry a rule, the unique keys, the cascades, and attribution cleared (never moved) when a
// chat or a rollout goes, under running and closed calls.
import { DatabaseSync } from "node:sqlite"
import { beforeEach, describe, expect, it } from "vitest"
import { baseline } from "../src/db/baseline.ts"
import { storageKinds } from "../src/db/storageKinds.ts"

let db: DatabaseSync
let n = 0
const id = (prefix: string) => `${prefix}${++n}`

const run = (sql: string, ...params: Array<string | number | null>) => db.prepare(sql).run(...params)
const get = <T>(sql: string, ...params: Array<string | number | null>) => db.prepare(sql).get(...params) as T

beforeEach(() => {
  db = new DatabaseSync(":memory:")
  db.exec("PRAGMA foreign_keys = ON")
  for (const statement of baseline) db.exec(statement)
})

const user = (role: "admin" | "user" = "user") => {
  const userId = id("u")
  run(
    `INSERT INTO users (id, handle, display_name, role, created_at) VALUES (?, ?, ?, ?, 1)`,
    userId,
    userId,
    userId,
    role
  )
  return userId
}

const credential = (ownerId: string) => {
  const credentialId = id("k")
  run(
    `INSERT INTO credentials (id, owner_user_id, name, key_enc, key_hint, created_at, updated_at)
      VALUES (?, ?, 'Key', x'00', '…abcd', 1, 1)`,
    credentialId,
    ownerId
  )
  return credentialId
}

interface ConnectionFields {
  readonly transport?: "streamable-http" | "sse" | "stdio"
  readonly key?: string
  readonly share?: "private" | "all" | "chosen"
  readonly credentialId?: string | null
}

const connection = (ownerId: string, fields: ConnectionFields = {}) => {
  const connectionId = id("m")
  const transport = fields.transport ?? "streamable-http"
  run(
    `INSERT INTO mcp_connections (id, owner_user_id, name, key, transport, url, command_json, credential_id,
      share_scope, created_at, updated_at) VALUES (?, ?, 'Server', ?, ?, ?, ?, ?, ?, 1, 1)`,
    connectionId,
    ownerId,
    fields.key ?? connectionId,
    transport,
    transport === "stdio" ? null : "https://mcp.example.test/mcp",
    transport === "stdio" ? '["synthetic-server"]' : null,
    fields.credentialId ?? null,
    fields.share ?? "private"
  )
  return connectionId
}

const use = (connectionId: string, userId: string, offeredKey = id("o")) =>
  run(
    `INSERT INTO mcp_uses (connection_id, user_id, offered_key, updated_at) VALUES (?, ?, ?, 1)`,
    connectionId,
    userId,
    offeredKey
  )

const chat = (ownerId: string) => {
  const chatId = id("c")
  db.exec("BEGIN IMMEDIATE")
  run(
    `INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES (?, ?, 'workshop', 'active', 1)`,
    chatId,
    ownerId
  )
  db.exec("COMMIT")
  return chatId
}

const rollout = (chatId: string) => {
  const rolloutId = id("r")
  run(
    `INSERT INTO rollouts (id, chat_id, kind, status, role, request_class, created_at, updated_at)
      VALUES (?, ?, 'workshop', 'running', 'assistant', 'interactive', 1, 1)`,
    rolloutId,
    chatId
  )
  return rolloutId
}

interface CallFields {
  readonly method?: "initialize" | "tools/list" | "tools/call" | "oauth"
  readonly chatId?: string | null
  readonly rolloutId?: string | null
  readonly toolCallId?: string | null
  readonly status?: string
}

const call = (ownerId: string, connectionId: string, fields: CallFields = {}) => {
  const callId = id("x")
  const method = fields.method ?? "tools/call"
  const status = fields.status ?? "running"
  run(
    `INSERT INTO mcp_calls (id, owner_user_id, connection_id, connection_revision, method, tool, purpose, chat_id,
      rollout_id, tool_call_id, status, started_at, ended_at) VALUES (?, ?, ?, 0, ?, ?, 'workshop', ?, ?, ?, ?, 10, ?)`,
    callId,
    ownerId,
    connectionId,
    method,
    method === "tools/call" ? "search" : null,
    fields.chatId ?? null,
    fields.rolloutId ?? null,
    fields.toolCallId ?? null,
    status,
    status === "running" ? null : 20
  )
  return callId
}

const callRow = (callId: string) =>
  get<{ chat_id: string | null; rollout_id: string | null; tool_call_id: string | null; status: string }>(
    `SELECT chat_id, rollout_id, tool_call_id, status FROM mcp_calls WHERE id = ?`,
    callId
  )

describe("MCP baseline (spec/MCP.md §12)", () => {
  it("registers the storage kinds MCP writes into existing tables", () => {
    expect(storageKinds.get("rollout_effects.kind")?.values).toContain("mcp.call")
    expect(storageKinds.get("bin_items.kind")?.values).toContain("mcp_connection")
  })

  it("keeps a connection's identity, owner and key fixed, and everything else editable", () => {
    const owner = user()
    const other = user()
    const m = connection(owner, { key: "github" })
    for (const change of [`id = 'moved'`, `owner_user_id = '${other}'`, `key = 'gitlab'`, `created_at = 99`])
      expect(() => run(`UPDATE mcp_connections SET ${change} WHERE id = ?`, m)).toThrow(/never changes identity/)
    run(
      `UPDATE mcp_connections SET name = 'Renamed', about = 'Issues', row_version = 2, cache_revision = 1 WHERE id = ?`,
      m
    )
    // Writing the same values again isn't a change.
    run(`UPDATE mcp_connections SET key = 'github', owner_user_id = ? WHERE id = ?`, owner, m)
  })

  it("checks the key's shape and keeps it unique per owner among unpurged connections", () => {
    const owner = user()
    for (const key of ["", "GitHub", "1github", "git-hub", "a".repeat(25)])
      expect(() => connection(owner, { key })).toThrow(/CHECK constraint/)
    const first = connection(owner, { key: "github" })
    expect(() => connection(owner, { key: "github" })).toThrow(/UNIQUE/)
    connection(user(), { key: "github" })
    run(`UPDATE mcp_connections SET url = NULL, purged_at = 5 WHERE id = ?`, first)
    connection(owner, { key: "github" })
  })

  it("uses only its owner's credentials, on insert and on update, and clears one deleted", () => {
    const owner = user()
    const other = user()
    expect(() => connection(owner, { credentialId: credential(other) })).toThrow(/owner's credentials/)
    const own = credential(owner)
    const m = connection(owner, { credentialId: own })
    expect(() => run(`UPDATE mcp_connections SET credential_id = ? WHERE id = ?`, credential(other), m)).toThrow(
      /owner's credentials/
    )
    run(`DELETE FROM credentials WHERE id = ?`, own)
    expect(get<{ credential_id: string | null }>(`SELECT credential_id FROM mcp_connections WHERE id = ?`, m)).toEqual({
      credential_id: null
    })
  })

  it("lets only an admin own a local program, on insert and on update", () => {
    const admin = user("admin")
    const plain = user()
    connection(admin, { transport: "stdio" })
    expect(() => connection(plain, { transport: "stdio" })).toThrow(/only an admin can add a local program/)
    const m = connection(plain)
    expect(() =>
      run(`UPDATE mcp_connections SET transport = 'stdio', url = NULL, command_json = '["x"]' WHERE id = ?`, m)
    ).toThrow(/only an admin can add a local program/)
    // An admin's program stays editable; a purged one keeps nothing to run.
    const program = connection(admin, { transport: "stdio" })
    run(`UPDATE mcp_connections SET command_json = '["y", "--flag"]' WHERE id = ?`, program)
    run(`UPDATE users SET role = 'user' WHERE id = ?`, admin)
    expect(() => run(`UPDATE mcp_connections SET command_json = '["z"]' WHERE id = ?`, program)).toThrow(
      /only an admin/
    )
    run(`UPDATE mcp_connections SET command_json = NULL, env_enc = NULL, purged_at = 9 WHERE id = ?`, program)
  })

  it("ties the transport to its address and keeps a program's settings apart from a server's", () => {
    const admin = user("admin")
    const insert = (transport: string, url: string | null, command: string | null, extra = "") =>
      run(
        `INSERT INTO mcp_connections (id, owner_user_id, name, key, transport, url, command_json, created_at, updated_at${extra ? ", " + extra.split("=")[0] : ""})
          VALUES (?, ?, 'S', ?, ?, ?, ?, 1, 1${extra ? ", " + extra.split("=")[1] : ""})`,
        id("m"),
        admin,
        id("k"),
        transport,
        url,
        command
      )
    expect(() => insert("stdio", "https://a.test", '["x"]')).toThrow(/CHECK/)
    expect(() => insert("stdio", null, null)).toThrow(/CHECK/)
    expect(() => insert("sse", null, null)).toThrow(/CHECK/)
    expect(() => insert("sse", "https://a.test", '"x"')).toThrow(/CHECK/)
    expect(() => insert("sse", "https://a.test", null, "env_names_json='[\"A\"]'")).toThrow(/CHECK/)
    expect(() => insert("stdio", null, '["x"]', "proxy_mode='direct'")).toThrow(/CHECK/)
    expect(() => insert("sse", "https://a.test", null, "proxy_mode='custom'")).toThrow(/CHECK/)
    insert("sse", "https://a.test", null, "proxy_mode='direct'")
    const m = connection(admin)
    expect(() => run(`UPDATE mcp_connections SET purged_at = 3 WHERE id = ?`, m)).toThrow(/CHECK/)
    run(`UPDATE mcp_connections SET url = NULL, purged_at = 3 WHERE id = ?`, m)
  })

  it("lets only an admin share a connection, on insert and on update", () => {
    const admin = user("admin")
    const plain = user()
    expect(() => connection(plain, { share: "all" })).toThrow(/only an admin can share/)
    const m = connection(plain)
    expect(() => run(`UPDATE mcp_connections SET share_scope = 'chosen' WHERE id = ?`, m)).toThrow(
      /only an admin can share/
    )
    run(`UPDATE mcp_connections SET share_scope = 'private' WHERE id = ?`, m)
    const shared = connection(admin, { share: "chosen" })
    run(`UPDATE mcp_connections SET share_scope = 'all' WHERE id = ?`, shared)
  })

  it("never shares a connection with its owner, and drops shares with the connection or the user", () => {
    const admin = user("admin")
    const guest = user()
    const m = connection(admin, { share: "chosen" })
    expect(() =>
      run(`INSERT INTO mcp_connection_shares (connection_id, user_id, created_at) VALUES (?, ?, 1)`, m, admin)
    ).toThrow(/not shared with its owner/)
    run(`INSERT INTO mcp_connection_shares (connection_id, user_id, created_at) VALUES (?, ?, 1)`, m, guest)
    const count = () => get<{ n: number }>(`SELECT count(*) AS n FROM mcp_connection_shares`).n
    expect(count()).toBe(1)
    run(`DELETE FROM users WHERE id = ?`, guest)
    expect(count()).toBe(0)
    run(`INSERT INTO mcp_connection_shares (connection_id, user_id, created_at) VALUES (?, ?, 1)`, m, user())
    run(`DELETE FROM mcp_connections WHERE id = ?`, m)
    expect(count()).toBe(0)
  })

  it("admits a use only for a connection its user owns or was given, never a purged one", () => {
    const admin = user("admin")
    const guest = user()
    const own = connection(admin)
    use(own, admin)
    expect(() => use(own, guest)).toThrow(/a connection its user may use/)
    const everyone = connection(admin, { share: "all" })
    use(everyone, guest)
    const chosen = connection(admin, { share: "chosen" })
    expect(() => use(chosen, guest)).toThrow(/a connection its user may use/)
    run(`INSERT INTO mcp_connection_shares (connection_id, user_id, created_at) VALUES (?, ?, 1)`, chosen, guest)
    use(chosen, guest)
    const gone = connection(admin)
    run(`UPDATE mcp_connections SET url = NULL, purged_at = 2 WHERE id = ?`, gone)
    expect(() => use(gone, admin)).toThrow(/a connection its user may use/)
  })

  it("keeps a use's key fixed and unique per user, and its sign-in whole", () => {
    const admin = user("admin")
    const a = connection(admin)
    const b = connection(admin)
    use(a, admin, "github")
    expect(() => use(b, admin, "github")).toThrow(/UNIQUE/)
    expect(() => use(b, admin, "Git")).toThrow(/CHECK/)
    use(b, admin, "github2")
    for (const change of [`offered_key = 'other'`, `user_id = '${user()}'`, `connection_id = '${b}'`])
      expect(() => run(`UPDATE mcp_uses SET ${change} WHERE connection_id = ? AND user_id = ?`, a, admin)).toThrow(
        /never changes identity or key/
      )
    run(
      `UPDATE mcp_uses SET stories = 1, workshops = 1, tools_json = '{"search":{"on":false}}', reviewed_revision = 3,
        row_version = 2 WHERE connection_id = ? AND user_id = ?`,
      a,
      admin
    )
    expect(() =>
      run(`UPDATE mcp_uses SET oauth_enc = x'01' WHERE connection_id = ? AND user_id = ?`, a, admin)
    ).toThrow(/CHECK/)
    expect(() =>
      run(`UPDATE mcp_uses SET oauth_expires_at = 5 WHERE connection_id = ? AND user_id = ?`, a, admin)
    ).toThrow(/CHECK/)
    run(
      `UPDATE mcp_uses SET oauth_enc = x'01', oauth_origin = 'https://mcp.example.test', oauth_expires_at = 5
        WHERE connection_id = ? AND user_id = ?`,
      a,
      admin
    )
    run(`DELETE FROM mcp_connections WHERE id = ?`, b)
    expect(get<{ n: number }>(`SELECT count(*) AS n FROM mcp_uses WHERE connection_id = ?`, b).n).toBe(0)
  })

  it("records a call only for a connection its user may use, attributed only to their own chat", () => {
    const admin = user("admin")
    const guest = user()
    const m = connection(admin, { share: "all" })
    call(admin, m, { method: "tools/list" })
    expect(() => call(guest, m)).toThrow(/a connection its user may use/)
    use(m, guest)
    call(guest, m)
    const theirs = chat(admin)
    expect(() => call(guest, m, { chatId: theirs })).toThrow(/only to its user's chat/)
    call(guest, m, { chatId: chat(guest) })
    // Only a tool call names a tool, a rollout or a tool call.
    expect(() => call(admin, m, { method: "initialize", rolloutId: rollout(theirs) })).toThrow(/CHECK/)
    expect(() =>
      run(
        `INSERT INTO mcp_calls (id, owner_user_id, connection_id, connection_revision, method, purpose, status, started_at)
          VALUES ('bad', ?, ?, 0, 'tools/call', 'story', 'running', 1)`,
        admin,
        m
      )
    ).toThrow(/CHECK/)
    // Running has no end; closed has one.
    const open = call(admin, m, { method: "oauth" })
    expect(() => run(`UPDATE mcp_calls SET ended_at = 5 WHERE id = ?`, open)).toThrow(/CHECK/)
    expect(() => run(`UPDATE mcp_calls SET status = 'complete' WHERE id = ?`, open)).toThrow(/CHECK/)
  })

  it("never changes a call's identity, and lets its rollout only be cleared", () => {
    const admin = user("admin")
    const m = connection(admin)
    const c = chat(admin)
    const r = rollout(c)
    const x = call(admin, m, { chatId: c, rolloutId: r, toolCallId: "t1" })
    for (const change of [
      `id = 'y'`,
      `owner_user_id = '${user()}'`,
      `connection_id = '${connection(admin)}'`,
      `connection_revision = 4`,
      `method = 'oauth', tool = NULL, rollout_id = NULL, tool_call_id = NULL`,
      `tool = 'other'`,
      `purpose = 'story'`,
      `rollout_id = '${rollout(c)}'`,
      `tool_call_id = 't2'`,
      `attempt = 2`,
      `started_at = 11`
    ])
      expect(() => run(`UPDATE mcp_calls SET ${change} WHERE id = ?`, x)).toThrow(/identity never changes/)
    run(`UPDATE mcp_calls SET rollout_id = NULL WHERE id = ?`, x)
    expect(callRow(x).rollout_id).toBeNull()
  })

  it("keeps a closed call as a record", () => {
    const admin = user("admin")
    const m = connection(admin)
    const x = call(admin, m)
    run(`UPDATE mcp_calls SET sent_bytes = 10 WHERE id = ?`, x)
    run(`UPDATE mcp_calls SET status = 'complete', ended_at = 30, received_bytes = 20 WHERE id = ?`, x)
    for (const change of [
      `status = 'error'`,
      `ended_at = 31`,
      `sent_bytes = 11`,
      `received_bytes = 21`,
      `error = 'late'`
    ])
      expect(() => run(`UPDATE mcp_calls SET ${change} WHERE id = ?`, x)).toThrow(/a closed MCP call is a record/)
    // Startup's interruption closes a running one.
    const y = call(admin, m)
    run(`UPDATE mcp_calls SET status = 'interrupted', ended_at = 40 WHERE id = ?`, y)
    expect(callRow(y).status).toBe("interrupted")
  })

  it("clears a call's chat and rollout when either goes, running or closed, and keeps the row", () => {
    const admin = user("admin")
    const m = connection(admin)
    const c = chat(admin)
    const running = call(admin, m, { chatId: c, rolloutId: rollout(c), toolCallId: "t1" })
    const closed = call(admin, m, { chatId: c, rolloutId: rollout(c), toolCallId: "t2", status: "complete" })
    // A rollout deleted on its own clears only the rollout.
    const other = chat(admin)
    const lone = rollout(other)
    const alone = call(admin, m, { chatId: other, rolloutId: lone, toolCallId: "t3", status: "failed" })
    run(`DELETE FROM rollouts WHERE id = ?`, lone)
    expect(callRow(alone)).toEqual({ chat_id: other, rollout_id: null, tool_call_id: "t3", status: "failed" })

    run(`DELETE FROM chats WHERE id = ?`, c)
    expect(callRow(running)).toEqual({ chat_id: null, rollout_id: null, tool_call_id: "t1", status: "running" })
    expect(callRow(closed)).toEqual({ chat_id: null, rollout_id: null, tool_call_id: "t2", status: "complete" })
    // The cleared running call still closes, and the connection can't go while calls name it.
    run(`UPDATE mcp_calls SET status = 'interrupted', ended_at = 50 WHERE id = ?`, running)
    expect(() => run(`DELETE FROM mcp_connections WHERE id = ?`, m)).toThrow(/FOREIGN KEY/)
  })

  it("keeps a user with connections or calls", () => {
    const plain = user()
    connection(plain)
    expect(() => run(`DELETE FROM users WHERE id = ?`, plain)).toThrow(/FOREIGN KEY/)
  })
})
