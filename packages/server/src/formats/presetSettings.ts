// Three explicit import surfaces for the three things bundled in an ST preset file.
import { promptPreset } from "@rp/shared/docs/preset.ts"
import { ModelSettings, StSettingsImport } from "@rp/shared/modelSettings.ts"
import { ImportReport, ReportBuilder, shownList } from "@rp/shared/importReport.ts"
import { Predicate, Schema } from "effect"
import { exportStPreset, importStPreset, MAX_PRESET_BYTES } from "./preset.ts"
import { defaultLimits, FormatError, parseJson } from "./safety.ts"

export const importPromptPreset = (input: string | Uint8Array) => {
  const legacy = importStPreset(input)
  const ignored = new ReportBuilder()
  ignored.add(
    "info",
    "preset.model_settings_ignored",
    "Model settings were ignored: samplers, context and response length, reasoning, streaming, caching, routing and wire formatting. Import those onto a model separately."
  )
  return {
    document: legacy.document ? promptPreset(legacy.document) : null,
    report: new ImportReport({
      format: legacy.report.format,
      issues: [...legacy.report.issues, ...ignored.build(legacy.report.format).issues]
    })
  }
}

const sources: Readonly<Record<string, string>> = {
  openai: "openai-chat",
  custom: "openai-chat",
  claude: "anthropic",
  anthropic: "anthropic",
  openrouter: "openrouter",
  deepseek: "deepseek",
  makersuite: "google",
  google: "google"
}

export const importStSettings = (input: string, surface: "model" | "connection"): StSettingsImport => {
  const r = new ReportBuilder()
  let parsed: unknown
  try {
    parsed = parseJson(new TextEncoder().encode(input), MAX_PRESET_BYTES, defaultLimits, r)
  } catch (error) {
    if (!(error instanceof FormatError)) throw error
    r.add("error", error.code, error.message)
    return { report: r.build("st-settings"), model: null, connection: null }
  }
  if (!Predicate.isObject(parsed) || Array.isArray(parsed)) {
    r.add("error", "preset.unrecognized", "Expected an ST preset JSON object.")
    return { report: r.build("st-settings"), model: null, connection: null }
  }
  const file = parsed as Record<string, unknown>
  const used = new Set<string>()
  let model: ModelSettings | null = null
  let connection: StSettingsImport["connection"] = null
  if (surface === "model") {
    const legacy = importStPreset(input)
    if (!legacy.document) return { report: legacy.report, model: null, connection: null }
    const samplers = Object.fromEntries(
      Object.entries(legacy.document.samplers).filter(([key]) => {
        if (!Object.hasOwn(file, key)) return false
        used.add(key)
        return true
      })
    )
    const raw: Record<string, unknown> = { ...(Object.keys(samplers).length ? { samplers } : {}) }
    for (const [st, key, value] of [
      ["names_behavior", "names_behavior", legacy.document.names_behavior],
      ["squash_system_messages", "squash", legacy.document.squash],
      ["custom_prompt_post_processing", "postprocess", legacy.document.postprocess],
      ["use_sysprompt", "use_sysprompt", legacy.document.use_sysprompt],
      ["stream_openai", "stream", file.stream_openai],
      ["stop", "stop", file.stop],
      ["logit_bias", "logit_bias", file.logit_bias],
      ["openrouter_providers", "routing", { order: file.openrouter_providers }]
    ] as const)
      if (Object.hasOwn(file, st)) {
        raw[key] = value
        used.add(st)
      }
    const decoded = Schema.decodeUnknownExit(ModelSettings)(raw)
    if (decoded._tag === "Success") model = decoded.value
    else r.add("error", "settings.invalid", "Model settings have invalid values; nothing was imported.")
    for (const issue of legacy.report.issues)
      if (issue.code === "preset.invalid_value") r.add(issue.level, issue.code, issue.message, issue.path)
  } else {
    const source = typeof file.chat_completion_source === "string" ? file.chat_completion_source : "custom"
    const kind = sources[source]
    if (!kind)
      r.add("error", "connection.unsupported", "This ST API type is unsupported; choose a connection type manually.")
    else {
      used.add("chat_completion_source")
      const urlKey = source === "custom" ? "custom_url" : "reverse_proxy"
      const baseUrl = typeof file[urlKey] === "string" && file[urlKey] !== "" ? file[urlKey] : null
      const modelKey =
        source === "claude" ? "claude_model" : source === "makersuite" ? "google_model" : `${source}_model`
      const name = typeof file[modelKey] === "string" ? file[modelKey] : null
      used.add(urlKey)
      used.add(modelKey)
      if (baseUrl && !/^https?:\/\/[^\s]+$/.test(baseUrl))
        r.add("error", "connection.url", "The connection URL must be an HTTP or HTTPS URL.")
      else if (
        baseUrl &&
        (() => {
          try {
            const u = new URL(baseUrl)
            return !!(u.username || u.password)
          } catch {
            return true
          }
        })()
      )
        r.add("error", "connection.url", "URLs containing credentials are not imported.")
      else connection = { kind, baseUrl, model: name }
    }
  }
  const ignored = Object.keys(file).filter((key) => !used.has(key))
  r.add(
    "info",
    "settings.ignored",
    `Ignored ${ignored.length} fields: ${shownList(ignored)}. Prompt content, unrelated settings and all keys and passwords are never applied by this surface.`
  )
  return { report: r.build("st-settings"), model, connection }
}

/** Prompt exports carry only the prompt portion of an ST preset. */
export const exportPromptPreset = (doc: import("@rp/shared/docs/preset.ts").LegacyPresetDoc) => {
  const output = exportStPreset(doc)
  const keys = new Set([
    ...Object.keys(doc.samplers),
    "names_behavior",
    "squash_system_messages",
    "custom_prompt_post_processing",
    "use_sysprompt",
    "stream_openai",
    "stop",
    "stopping_strings",
    "logit_bias"
  ])
  return Object.fromEntries(Object.entries(output).filter(([key]) => !keys.has(key)))
}
