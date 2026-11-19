import { chromium } from "@playwright/test"
import { pluginFiles as clientPluginFiles } from "../packages/client/e2e/support/plugin.ts"
// Final-image check, against a disposable container started by the deploy gate.
// Usage: IMAGE_SMOKE_PASSWORD=... npm run smoke:image -- http://127.0.0.1:PORT CONTAINER
// The caller must disable card sources and set IMAGE_SMOKE_FLAGS (documented in §1).
// Only the two negative containers below are launched/removed here; the supplied one is untouched.
import { execFile, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, mkdtempSync, rmSync } from "node:fs"
import { crc32, deflateSync } from "node:zlib"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppApi, type AppRpcs } from "../packages/shared/src/api.ts"
import { ImportResult } from "../packages/shared/src/libraryImport.ts"
import { LOCAL_ENCODINGS, type LocalEncoding } from "../packages/server/src/importer/tokenizer.ts"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { RpcClient, type RpcGroup, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import ts from "typescript"

/** Set on the caller's normal launch, to prove these dev-only switches are inert. */
export const IMAGE_SMOKE_FLAGS = {
  FAKE_GENERATOR_TPS: "100",
  FAKE_GENERATOR_TOKENS: "10",
  FAKE_GENERATOR_SEED: "1",
  FAKE_GENERATOR_BURST_MS: "10",
  FAKE_GENERATOR_REASONING: "10",
  FAKE_GENERATOR_SECTION: "10",
  FAKE_GENERATOR_COT: "10",
  DECISION_TIMEOUT_MS: "1"
} as const

const MODELS: Record<LocalEncoding, string> = {
  o200k_base: "gpt-4o",
  cl100k_base: "gpt-4",
  llama3: "llama-3",
  "mistral-v3": "mistral-7b-v0.3",
  qwen2: "qwen2.5",
  qwen3: "qwen3",
  "deepseek-v3": "deepseek-v3",
  "deepseek-v4": "deepseek-v4",
  "deepseek-api": "deepseek-flash",
  gemma2: "gemma-2"
}
const requireThat = (ok: unknown, reason: string): void => {
  if (!ok) throw new Error(reason)
}

export const syntheticCard = (name: string) => ({
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name,
    description: "Synthetic image smoke fixture.",
    personality: "Brief.",
    scenario: "A test.",
    first_mes: "Hello from the smoke fixture.",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: [],
    creator: "smoke",
    character_version: "1",
    extensions: {}
  }
})

/** Generate a valid, decodable 1×1 PNG with a CCv2 text chunk, without a new dependency. */
export const syntheticPng = (card: unknown): Buffer => {
  const chunk = (type: string, data = Buffer.alloc(0)) => {
    const bytes = Buffer.alloc(data.length + 12)
    bytes.writeUInt32BE(data.length)
    bytes.write(type, 4)
    data.copy(bytes, 8)
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4)
    return bytes
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
    chunk("IDAT", deflateSync(Buffer.from([0, 128]))),
    chunk("tEXt", Buffer.from(`chara\0${Buffer.from(JSON.stringify(card)).toString("base64")}`)),
    chunk("IEND")
  ])
}

/** Parse actual imports, so SQL/prose containing “from” cannot become a module name. */
export const bundleExternals = (code: string): string[] => {
  const found = new Set<string>()
  const add = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node) && !node.text.startsWith(".") && !node.text.startsWith("/"))
      found.add(node.text)
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier)
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      add(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile("worker.mjs", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS))
  return [...found].sort()
}

/** No loader path or stack may escape the image's expected startup refusal. */
export const checkRefusal = (code: number, output: string, setting: string) => {
  requireThat(code !== 0 && code !== 125 && code !== 126 && code !== 127, "expected application startup failure")
  requireThat(
    output.includes(`${setting}=`) && output.includes("needs the development files"),
    "missing plain startup message"
  )
  requireThat(
    !/^\s*at\s|file:\/\/|(?:^|[\s"'(])\/(?:[\w.-]+\/)+|ERR_MODULE|Listening on/m.test(output),
    "startup exposed a path or stack, or listened"
  )
}

// Executed inside the supplied container, with no writes and no application database access.
const IMAGE_FILES = String.raw`
const fs = require('node:fs'), path = require('node:path');
const assert = (ok, reason) => { if (!ok) throw Error(reason) };
for (const p of ['src/dev','test','tests','e2e','scripts']) {
  assert(!fs.existsSync(p), 'unexpected root directory ' + p);
  for (const pkg of ['server','client','shared']) assert(!fs.existsSync('packages/'+pkg+'/'+p), 'unexpected package directory '+p);
}
const workers = 'packages/server/dist/workers/';
for (const name of ['writer','reader','formats']) assert(fs.statSync(workers+name+'.mjs').size > 0, 'missing worker '+name);
for (const root of ['packages/server/src/importer/tokenizers/',workers+'tokenizers/']) {
  for (const file of TOKENIZER_FILES) assert(fs.existsSync(root+file) && fs.statSync(root+file).size > 0, 'missing tokenizer data/licence '+file);
}
const { createRequire } = require('node:module');
const externals = BUNDLE_EXTERNALS;
for (const name of ['writer','reader','formats']) {
  const resolve = createRequire(path.resolve(workers+name+'.mjs')).resolve;
  for (const external of externals) { try { resolve(external); } catch { throw Error("cannot resolve bundle external " + external); } }
}
const dist = 'packages/client/dist/';
const walk = p => fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(p,e.name)):[path.join(p,e.name)]);
const files = walk(dist);
for (const p of files.filter(p=>/\.(js|css|html)$/.test(p))) {
 const code=fs.readFileSync(p,'utf8');
 assert(!code.includes('__rpPerf') && !code.includes('Development: open diffs with buttons'), 'development client marker');
}
const font = files.find(p=>p.endsWith('.woff2'));
const asset = files.find(p=>/assets\/[^/]+-[\w-]+\.js$/.test(p));
assert(font && asset, 'missing font or hashed asset');
const {builtinPreset}=await import('./packages/server/src/db/assemblySources.ts');
assert(builtinPreset.prompts.length > 0, 'missing built-in preset');
console.log(JSON.stringify({font:'/'+font.slice(dist.length),asset:'/'+asset.slice(dist.length),externals:[...externals]}));
`

const TOKENIZER_FILES = [
  ...LOCAL_ENCODINGS.filter((e) => !["o200k_base", "cl100k_base", "llama3"].includes(e)).map((e) => `${e}.json.gz`),
  "APACHE-LICENSE.txt",
  "DEEPSEEK-V3-LICENSE.txt",
  "DEEPSEEK-V4-LICENSE.txt",
  "GEMMA-TERMS.txt",
  "sources.json",
  "README.md"
]

export const smoke = async (base: string, container: string, password: string) => {
  const started = Date.now()
  let step = "input"
  const names = new Set<string>()
  const dirs: string[] = []
  const remaining = () => Math.max(1, 170_000 - (Date.now() - started))
  const cleanup = () => {
    for (const name of names) {
      try {
        execFileSync("docker", ["rm", "-f", "-v", name], { stdio: "ignore", timeout: 3000 })
      } catch {
        /* --rm may already have removed it */
      }
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }
  const interrupted = () => {
    cleanup()
    process.exit(1)
  }
  process.once("SIGINT", interrupted)
  process.once("SIGTERM", interrupted)
  const watchdog = setTimeout(() => {
    console.error(`FAIL ${step}: image smoke exceeded 175 seconds`)
    interrupted()
  }, 175_000)
  const command = promisify(execFile)
  const docker = async (...args: string[]) => {
    try {
      return await command("docker", args, { timeout: Math.min(30_000, remaining()), maxBuffer: 32 * 1024 * 1024 })
    } catch (error) {
      const failure = error as { stderr?: string }
      const reason = failure.stderr?.match(/IMAGE_FILE_FAILURE: ([^\n]+)/)?.[1]
      if (reason) throw new Error(reason)
      throw error
    }
  }
  const pass = (label: string) => console.log(`PASS ${label}`)
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(new URL(path, base), {
      ...init,
      signal: AbortSignal.timeout(Math.min(15_000, remaining()))
    })
    requireThat(response.ok, `${path.split("?")[0]} returned HTTP ${response.status}`)
    return response
  }
  const served = async (path: string, type: RegExp) => {
    const response = await request(path, { headers: { accept: type.test("text/html") ? "text/html" : "*/*" } })
    requireThat(type.test(response.headers.get("content-type") ?? ""), `${path} has wrong content type`)
    const body = await response.text()
    requireThat(body.length > 0, `${path} is empty`)
    return body
  }
  try {
    requireThat(URL.canParse(base) && new URL(base).hostname === "127.0.0.1", "use a loopback base URL")
    requireThat(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(container) && password, "supply container name and admin password")
    step = "normal launch configuration"
    const inspected = JSON.parse((await docker("inspect", container)).stdout)[0] as {
      Image: string
      Config: { Env: string[] }
      State: { Running: boolean }
    }
    requireThat(inspected.State.Running, "container is not running")
    const env = new Map(inspected.Config.Env.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]))
    requireThat(env.get("FAKE_CARD_SOURCE") === "off", "normal launch must set FAKE_CARD_SOURCE=off")
    for (const key of Object.keys(IMAGE_SMOKE_FLAGS))
      requireThat(env.has(key) && env.get(key) !== "", `normal launch must set ${key}`)
    pass("remote source disabled; every fake-generator and decision-timeout flag set")

    step = "health and build id"
    const health = await request("/healthz")
    requireThat((await health.text()) === "ok" && health.headers.get("x-client-build"), "missing health or build id")
    requireThat(health.headers.get("x-generator-kind") === "provider", "normal launch has no provider generator")
    const build = (await (await request("/build-id.json")).json()) as { buildId: string }
    requireThat(build.buildId === health.headers.get("x-client-build"), "client and health build ids differ")
    pass("health, matching build id, provider generator with dev flags set")

    step = "image files and client markers"
    const externalSets = await Promise.all(
      ["writer", "reader", "formats"].map(async (name) =>
        bundleExternals((await docker("exec", container, "cat", `packages/server/dist/workers/${name}.mjs`)).stdout)
      )
    )
    const externals = [...new Set(externalSets.flat())]
    for (const external of ["sharp", "llama3-tokenizer-js", "tiktoken"])
      requireThat(externals.includes(external), `bundle no longer references expected external ${external}`)
    const manifest = JSON.parse(
      (
        await docker(
          "exec",
          container,
          "node",
          "-e",
          `(async () => { const TOKENIZER_FILES=${JSON.stringify(TOKENIZER_FILES)}, BUNDLE_EXTERNALS=${JSON.stringify(externals)};\n${IMAGE_FILES} })().catch(e => { console.error("IMAGE_FILE_FAILURE: " + e.message); process.exitCode = 1 })`
        )
      ).stdout
    ) as { font: string; asset: string; externals: string[] }
    pass(
      `image exclusions, worker bundles, tokenizer data/licences, bundle externals (${manifest.externals.join(", ")}), built-in preset, no client dev markers`
    )
    step = "client routes and assets"
    const index = await served("/", /text\/html/)
    requireThat(
      (await served("/chats/synthetic-smoke", /text\/html/)) === index,
      "deep link did not serve client index"
    )
    await served("/frame/panel", /text\/html/)
    await served("/frame/bootstrap.js", /(?:application|text)\/javascript/)
    await served(manifest.font, /font\/woff2/)
    await served(manifest.asset, /(?:application|text)\/javascript/)
    pass("client index, deep link, panel bootstrap, font and hashed JS content types")

    step = "first run login"
    const login = await request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "admin", password })
    })
    requireThat(login.status === 204, "admin login did not return 204")
    const cookie = login.headers.get("set-cookie")?.split(";")[0]
    requireThat(cookie, "login did not set a session cookie")
    const group: RpcGroup.RpcGroup<AppRpcs> = AppApi
    const program = Effect.gen(function* () {
      const protocol = yield* Layer.build(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(Socket.layerWebSocket(`${base.replace(/^http/, "ws")}/rpc`)),
          Layer.provide(
            Layer.succeed(Socket.WebSocketConstructor)(
              (url) => new WebSocket(url, { headers: { cookie } } as unknown as string[])
            )
          ),
          Layer.provide(RpcSerialization.layerJson)
        )
      )
      const api = yield* RpcClient.make(group).pipe(Effect.provide(protocol))
      const user = yield* api.Whoami()
      requireThat(user.handle === "admin" && user.role === "admin", "first-run admin was not initialized")
      const defaults = yield* api.GetGenerationDefaults()
      requireThat(defaults.model === null && defaults.preset === null, "expected a fresh synthetic data directory")
      pass("admin login and baseline/default settings initialized")
      step = "plugins: empty instance and explicit synthetic enable/check"
      requireThat((yield* api.ListPlugins()).length === 0, "fresh image unexpectedly has plugins")
      pass("no-plugins startup")
      const pluginFiles = (id: string, broken: boolean) => ({
        "dreamspan-plugin.json": JSON.stringify({
          id,
          name: "Synthetic image plugin",
          api: 1,
          server: "index.ts",
          worker: null,
          client: null,
          surfaces: [],
          overrides: [],
          replaces: [],
          network: false,
          base: null
        }),
        "index.ts": broken
          ? 'throw new Error("synthetic broken plugin");'
          : 'import {Effect, type Activate} from "@dreamspan/plugin-api/server"; export const activate: Activate = () => Effect.void;'
      })
      for (const broken of [false, true]) {
        const id = broken ? "image-broken" : "image-tiny"
        const commit = yield* api.CreatePlugin({ scope: "instance", id, files: pluginFiles(id, broken) })
        const report = yield* api.EnablePlugin({ scope: "instance", id, commit, consent: true })
        requireThat(report.ok === !broken, `synthetic plugin ${id} had the wrong check result`)
        const view = yield* api.GetPlugin({ scope: "instance", id })
        requireThat(
          broken ? view.pin === null && view.report?.ok === false : view.pin?.commit === commit,
          "plugin state/report mismatch"
        )
      }
      requireThat((yield* api.Whoami()).id === user.id, "broken plugin disturbed the server")
      pass("one synthetic plugin enabled; broken plugin off with a visible report")
      step = "editable built-ins use exact shipped client/server/shared sources"
      const builtins = yield* api.ListBuiltinParts()
      for (const [registry, id, pluginId] of [
        ["noticeChannels", "notifications.completion-sound", "image-sound-copy"],
        ["rolloutTools", "set_presence", "image-presence-copy"],
        ["macros", "reverse", "image-reverse-copy"]
      ] as const) {
        requireThat(
          builtins.some((part) => part.registry === registry && part.id === id && part.copyable),
          "shipped built-in missing"
        )
        const made = yield* api.CopyBuiltin({ registry, id, pluginId })
        requireThat(made.report.ok, "shipped built-in copy failed its production check")
        const detail = yield* api.GetPlugin(made)
        requireThat(
          detail.pin === null && detail.original?.available && !detail.original.changed,
          "copy must be inert with exact shipped provenance"
        )
      }
      for (const path of [
        "/packages/client/src/features/completionSoundPart.tsx",
        "/src/features/completionSoundPart.tsx"
      ]) {
        for (const headers of [{}, { cookie: cookie! }]) {
          const response = yield* Effect.promise(() => fetch(new URL(path, base), { headers }))
          const text = yield* Effect.promise(() => response.text())
          requireThat(
            !text.includes("export const completionSound") && !text.includes("function CompletionSoundSettings"),
            "shipped source was served"
          )
        }
      }
      pass("three inert built-in copies checked against shipped sources; source URLs expose no executable modules")
      step = "browser client plugins in the production image"
      for (const broken of [false, true]) {
        const id = broken ? "image-client-broken" : "image-client"
        const source = broken
          ? 'throw new Error("synthetic client import"); export const activate = () => undefined;'
          : 'import {type Activate} from "@dreamspan/plugin-api/client"; export const activate: Activate = host => { host.registries.appBanners!.register({id:"image.client",order:0,component:()=> <p>Synthetic client works</p>}) };'
        const commit = yield* api.CreatePlugin({
          scope: "instance",
          id,
          files: clientPluginFiles(id, source, ["appBanners"])
        })
        requireThat(
          (yield* api.EnablePlugin({ scope: "instance", id, commit, consent: true })).ok,
          "client plugin did not build in production"
        )
      }
      yield* Effect.tryPromise(async () => {
        const browser = await chromium.launch({ headless: true })
        try {
          const context = await browser.newContext()
          const [name, ...value] = cookie!.split("=")
          await context.addCookies([{ name: name!, value: value.join("="), url: base }])
          const page = await context.newPage()
          await page.goto(new URL("/settings/account", base).href)
          await page.getByText("Synthetic client works", { exact: true }).waitFor()
          await page.getByText("image-client-broken failed and is off here.", { exact: true }).waitFor()
          await page.getByRole("heading", { name: "Account", level: 1, exact: true }).waitFor()
        } finally {
          await browser.close()
        }
      })
      pass("production browser loads one client plugin and recovers from a broken module")
      step = "synthetic PNG and JSON card import, media and chat"
      for (const extension of ["png", "json"]) {
        const card = syntheticCard(`Image smoke ${extension} ${randomUUID()}`)
        const bytes = extension === "png" ? syntheticPng(card) : Buffer.from(JSON.stringify(card))
        const imported = yield* Effect.promise(async () =>
          Schema.decodeUnknownSync(ImportResult)(
            await (
              await request(`/library/import?name=smoke.${extension}`, {
                method: "POST",
                headers: { cookie: cookie!, "content-type": "application/octet-stream" },
                body: bytes
              })
            ).json()
          )
        )
        requireThat(imported.library?.created, `${extension} card was not imported`)
        const entityId = imported.library!.ref.entityId
        const chat = yield* api.CreateChat({ title: `Synthetic ${extension} smoke` })
        const cast = yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId } })
        requireThat(cast.participants.includes(entityId), "imported card not attached to chat")
        if (extension === "png") {
          const media = cast.cards.find((c) => c.entityId === entityId)?.avatarMediaId
          requireThat(media, "PNG card has no media")
          for (const suffix of ["", "&w=192"])
            yield* Effect.promise(async () => {
              const response = await request(`/library/media?id=${media}${suffix}`, { headers: { cookie: cookie! } })
              requireThat(
                /^image\/(png|webp)/.test(response.headers.get("content-type") ?? "") &&
                  (await response.arrayBuffer()).byteLength > 0,
                "missing media or thumbnail"
              )
            })
        }
      }
      pass("synthetic PNG/JSON imports, thumbnail/media, chats with attached cards; no generation")
      step = "workshop seeds and attachments"
      const workshop = yield* api.CreateWorkshop({ title: "Synthetic smoke workshop" })
      const cast = yield* api.GetCast({ chatId: workshop.id, slotId: workshop.activeLeafSlotId })
      const cards = yield* api.ListLibrary({ kind: "card" })
      const presets = yield* api.ListLibrary({ kind: "preset" })
      const assistant = cards.find((c) => c.label === "Assistant")
      const preset = presets.find((p) => p.label === "Workshop")
      requireThat(
        assistant && preset && cast.participants.includes(assistant.entityId) && cast.preset === preset.id,
        "Workshop Assistant/preset missing or unattached"
      )
      pass("first workshop seeds Assistant and Workshop preset and attaches both")
      step = "local tokenizers"
      const connection = yield* api.CreateConnection({
        kind: "openai-chat",
        apiKey: null,
        settings: {
          name: "Synthetic local tokenizers",
          baseUrl: "http://127.0.0.1:9/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      for (const encoding of LOCAL_ENCODINGS) {
        step = `tokenizer ${encoding}`
        const model = yield* api.AddUserModel({ connectionId: connection.id, key: MODELS[encoding], overrides: {} })
        yield* api.SetGenerationDefaults({
          defaults: { ...defaults, model: { connection: connection.id, model: model.id } }
        })
        for (const turn of [1, 2]) {
          const count = yield* api.CountTokens({ texts: ["", `Synthetic image smoke ${turn}: Hello 世界!`] })
          requireThat(
            count.tokenizer.exact && count.counts[0] === 0 && Number.isFinite(count.counts[1]) && count.counts[1]! > 0,
            `${encoding} failed or fell back to an approximation`
          )
        }
        pass(`tokenizer ${encoding}, two uncached counts`)
      }
      yield* api.SetGenerationDefaults({ defaults })
      console.log(
        "NOTE format-worker restart not exercised: no supported external restart; counted twice with distinct text"
      )
    })
    const result = await Effect.runPromiseExit(Effect.scoped(program).pipe(Effect.timeout(remaining())))
    if (Exit.isFailure(result)) throw Cause.squash(result.cause)
    for (const setting of ["FAKE_CARD_SOURCE", "FAKE_SAVED_MEDIA"]) {
      step = `negative launch ${setting}`
      const name = `rp-image-smoke-${randomUUID()}`
      names.add(name)
      const dir = mkdtempSync(join(tmpdir(), "rp-image-smoke-negative-"))
      chmodSync(dir, 0o777)
      dirs.push(dir)
      let code = 0,
        output = ""
      try {
        const result = await docker(
          "run",
          "--rm",
          "--name",
          name,
          "--network",
          "none",
          "--mount",
          `type=bind,src=${dir},dst=/data`,
          "-e",
          "FAKE_CARD_SOURCE=off",
          "-e",
          "FAKE_SAVED_MEDIA=off",
          "-e",
          `${setting}=${setting === "FAKE_CARD_SOURCE" ? "fake" : "on"}`,
          inspected.Image
        )
        output = result.stdout + result.stderr
      } catch (error) {
        const failure = error as { code?: unknown; stdout?: string; stderr?: string }
        requireThat(typeof failure.code === "number", "negative launch timed out or could not run docker")
        code = failure.code as number
        output = (failure.stdout ?? "") + (failure.stderr ?? "")
      }
      checkRefusal(code, output, setting)
      pass(`${setting}: plain nonzero startup, no path/stack`)
    }
    pass(`image smoke complete in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  } catch (error) {
    // Never echo RPC causes, container logs, passwords or loader stacks into the gate output.
    const reason =
      error instanceof Error && !error.message.includes("\n") && !/file:\/\/|\bat .+\(/.test(error.message)
        ? error.message
        : "request or container check failed"
    console.error(`FAIL ${step}: ${reason}`)
    process.exitCode = 1
  } finally {
    clearTimeout(watchdog)
    cleanup()
    process.removeListener("SIGINT", interrupted)
    process.removeListener("SIGTERM", interrupted)
  }
}

if (import.meta.main) {
  await smoke(
    process.argv[2] ?? process.env.IMAGE_SMOKE_URL ?? "",
    process.argv[3] ?? process.env.IMAGE_SMOKE_CONTAINER ?? "",
    process.argv[4] ?? process.env.IMAGE_SMOKE_PASSWORD ?? ""
  )
}
