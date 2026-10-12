// Isolate only the built-in SDK adapters. No process-wide environment or fetch mutation.
// The tiny Google adaptation is checked against the exact pinned upstream source.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { build } from "rolldown"

const root = new URL("../../../node_modules/", import.meta.url)
const versions = {
  "@earendil-works/pi-ai": "1.0.3",
  openai: "7.19.0",
  "@anthropic-ai/sdk": "0.129.0",
  "@google/genai": "2.21.0"
}
const hashes: Record<string, string> = {
  "openai/internal/utils/env.mjs": "080ff45b23b69c5a2d5ea48905af3f8a6c6b88057228e0d4dfcc3fb2b6f4c15e",
  "@anthropic-ai/sdk/internal/utils/env.mjs": "19e11e6f23b90c8c4c5e1f7aa050ac83d8b6728d8aecf4f3591ed6b25524f508",
  "@earendil-works/pi-ai/dist/utils/provider-env.js":
    "e1f64c60f0fde39a3a649e541d8248a85fdeefe414ff8b4dddf5f1be962d47e6",
  "@earendil-works/pi-ai/dist/api/google-generative-ai.js":
    "3a19fb56e96e60751a27a19f891264a3ab471cf4973307308ffdc8f8d2669397",
  "@google/genai/dist/node/index.mjs": "a5775355f9271057cd1e089dd2bce71c5996a88d49da9cd0ed6f183e5905cdb8"
}
const replace = (code: string, before: string, after: string) => {
  if (code.split(before).length !== 2) throw new Error(`SDK adaptation no longer matches: ${before}`)
  return code.replace(before, after)
}
export const buildProviders = async () => {
  for (const [name, version] of Object.entries(versions)) {
    if (JSON.parse(readFileSync(new URL(`${name}/package.json`, root), "utf8")).version !== version)
      throw new Error(`Audit ${name}'s environment defaults and transport before upgrading`)
  }
  await build({
    input: fileURLToPath(new URL("../src/providers/sdkEntry.ts", import.meta.url)),
    platform: "node",
    transform: { define: { "process.env": "({})", "globalThis.process.env": "({})" } },
    plugins: [
      {
        name: "explicit-provider-configuration",
        resolveId(id, importer) {
          if (id === "node:process" || id === "process")
            return importer === "\0sdk-process" ? { id: "node:process", external: true } : "\0sdk-process"
        },
        load(id) {
          if (id === "\0sdk-process")
            return 'import process from "node:process"; export * from "node:process"; export const env = {}; export default { ...process, env };'
        },
        transform(code, id) {
          const relative = id.split("/node_modules/").at(-1)!
          if (relative in hashes && createHash("sha256").update(code).digest("hex") !== hashes[relative])
            throw new Error(`Audit changed SDK source: ${relative}`)
          if (relative === "openai/internal/utils/env.mjs" || relative === "@anthropic-ai/sdk/internal/utils/env.mjs")
            return "export const readEnv = () => undefined"
          if (relative === "@earendil-works/pi-ai/dist/utils/provider-env.js")
            return "export const getProviderEnvValue = (name, env) => env?.[name]"
          if (relative === "@earendil-works/pi-ai/dist/api/google-generative-ai.js") {
            code = replace(code, "if (options?.fetch && options.fetch !== globalThis.fetch)", "if (!options?.fetch)")
            code = replace(
              code,
              "Custom fetch is not supported by the Google Generative AI adapter",
              "A controlled fetch is required by the Google adapter"
            )
            code = replace(
              code,
              "createClient(model, apiKey, options?.headers)",
              "createClient(model, apiKey, options?.headers, options.fetch)"
            )
            code = replace(
              code,
              "function createClient(model, apiKey, optionsHeaders)",
              "function createClient(model, apiKey, optionsHeaders, fetch)"
            )
            code = replace(
              code,
              "return new GoogleGenAI({\n        apiKey,",
              "return new GoogleGenAI({\n        apiKey, fetch, vertexai: false,"
            )
          }
          if (relative === "@google/genai/dist/node/index.mjs") {
            code = replace(code, "response = await fetch(url,", "response = await this.clientOptions.fetch(url,")
            code = replace(
              code,
              "apiKey: this.apiKey,\n            vertexai: this.vertexai,",
              "apiKey: this.apiKey,\n            fetch: options.fetch,\n            vertexai: this.vertexai,"
            )
            const start = code.indexOf("function getEnv(env) {")
            const end = code.indexOf("function stringToBoolean", start)
            code = code.slice(0, start) + "function getEnv() { return undefined; }\n" + code.slice(end)
            const envStart = code.indexOf("function env() {")
            const envEnd = code.indexOf("/**", envStart)
            code = code.slice(0, envStart) + "function env() { return {}; }\n" + code.slice(envEnd)
          }
          return code.replaceAll("globalThis.process?.env", "({})")
        }
      }
    ],
    output: {
      dir: fileURLToPath(new URL("../dist/providers", import.meta.url)),
      format: "esm",
      entryFileNames: "[name].mjs",
      chunkFileNames: "[name]-[hash].mjs",
      sourcemap: false
    },
    logLevel: "warn"
  })
}
if (import.meta.main) await buildProviders()
