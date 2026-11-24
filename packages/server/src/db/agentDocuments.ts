// Pure document policy shared by approval previews and the writer. Executable changes
// stay off until the user approves them through the ordinary editor controls.
import {
  canonicalJson,
  keepsRegexApproval,
  validateDoc,
  withHtmlApprovals,
  withoutGrantedAgentEdits
} from "@dreamspan/shared/editing.ts"
import type { Doc, EntityKind } from "@dreamspan/shared/library.ts"
import type { PresetDoc } from "@dreamspan/shared/docs/preset.ts"
import type { LorebookDoc } from "@dreamspan/shared/docs/lorebook.ts"

const differs = (a: unknown, b: unknown) => canonicalJson(a) !== canonicalJson(b)
const opaque = (value: unknown) => value !== null && typeof value === "object" && Object.keys(value).length > 0
const html = (value: unknown): boolean =>
  typeof value === "string"
    ? /<\/?[a-z][^>]*>|javascript:|on\w+\s*=/i.test(value)
    : Array.isArray(value)
      ? value.some(html)
      : value !== null && typeof value === "object" && Object.values(value).some(html)

/** An imported or merged document can keep existing grants and approvals. */
export const guarded = (kind: EntityKind, head: Doc, next: Doc): Doc => {
  const granted = withoutGrantedAgentEdits(kind, head, next)
  if (kind !== "preset" && kind !== "card") return granted
  const doc = withHtmlApprovals(head, granted)
  return doc.regex_approved === true && !keepsRegexApproval(head, doc) ? { ...doc, regex_approved: false } : doc
}

export const safeAgentDocument = (kind: EntityKind, before: Doc, next: Doc): Doc => {
  if (kind === "preset") {
    const doc = next as unknown as PresetDoc
    const old = before as unknown as Partial<PresetDoc>
    const regex = doc.regex.map((script) => {
      const previous = old.regex?.find((r) => r.id === script.id)
      return differs(previous, script) ? { ...script, disabled: true } : script
    })
    const changedCode =
      differs(old.regex, doc.regex) || ["extensions", "unsupported"].some((key) => differs(before[key], next[key]))
    const blocked = new Set(
      doc.prompts
        .filter((prompt) => {
          const previous = old.prompts?.find((p) => p.identifier === prompt.identifier)
          // Turning previously disabled executable text on is itself an executable change.
          return (
            (html(prompt) || opaque(prompt.unsupported) || differs(previous?.unsupported, prompt.unsupported)) &&
            (differs(previous, prompt) ||
              (old.order?.find((p) => p.identifier === prompt.identifier)?.enabled !== true &&
                doc.order.find((p) => p.identifier === prompt.identifier)?.enabled === true))
          )
        })
        .map((p) => p.identifier)
    )
    const changedPanelText = ["prompts", "order", "utility_prompts", "prefill", "reply_sections", "lorebooks"].some(
      (key) => differs(before[key], next[key])
    )
    const keepPanels = !changedCode && !changedPanelText && blocked.size === 0
    const approved: Record<string, unknown> = { ...next }
    for (const key of ["html_scripts_approved", "html_network_approved"] as const) {
      delete approved[key]
      if (old[key] !== undefined || next[key] !== undefined || changedCode || blocked.size)
        approved[key] = keepPanels && old[key] === true
    }
    return {
      ...approved,
      regex,
      order: doc.order.map((entry) => (blocked.has(entry.identifier) ? { ...entry, enabled: false } : entry)),
      regex_approved: !changedCode && old.regex_approved === true
    }
  }
  if (kind === "lorebook") {
    const doc = next as unknown as LorebookDoc
    const old = before as unknown as Partial<LorebookDoc>
    const changedCode = ["extensions", "unknown_fields"].some((key) => differs(before[key] ?? {}, next[key] ?? {}))
    return {
      ...next,
      entries: doc.entries.map((entry) => {
        const previous = old.entries?.find((e) => e.uid === entry.uid)
        return (changedCode ||
          entry.use_regex ||
          [...entry.keys, ...entry.secondary_keys].some(
            (key) => (key.trim().startsWith("/") && key.trim() !== "//") || key.includes("{{")
          ) ||
          opaque(doc.extensions) ||
          opaque(doc.unknown_fields) ||
          opaque(entry.extensions) ||
          opaque(entry.unknown_fields) ||
          html(entry) ||
          differs(previous?.extensions ?? {}, entry.extensions) ||
          differs(previous?.unknown_fields, entry.unknown_fields) ||
          entry.automation_id !== "") &&
          (changedCode || differs(previous, entry))
          ? { ...entry, enabled: false }
          : entry
      })
    }
  }
  return next
}

/** The validated document an agent edit will save, also used by its approval preview. */
export const validateAgentDocument = (kind: EntityKind, head: Doc, next: Doc) => {
  const valid = validateDoc(kind, guarded(kind, head, next))
  return valid.ok ? { ...valid, doc: safeAgentDocument(kind, head, valid.doc) } : valid
}

/** List each changed element/setting separately; retain every value for the full diff. */
export const documentDiff = (before: Doc, after: Doc) => {
  const changes: Array<{ field: string; before: string; after: string }> = []
  const shown = (value: unknown) => (typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "(absent)"))
  const record = (field: string, a: unknown, b: unknown) => changes.push({ field, before: shown(a), after: shown(b) })
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
  const visit = (field: string, a: unknown, b: unknown): void => {
    if (!differs(a, b)) return
    if (Array.isArray(a) || Array.isArray(b)) {
      const left = a === undefined ? [] : a
      const right = b === undefined ? [] : b
      if (Array.isArray(left) && Array.isArray(right)) {
        const all = [...left, ...right]
        const identity = ["identifier", "uid", "id"].find(
          (key) =>
            all.length > 0 && all.every((item) => object(item) && ["string", "number"].includes(typeof item[key]))
        )
        if (
          identity &&
          [left, right].every((items) => new Set(items.map((item) => item[identity])).size === items.length)
        ) {
          const old = new Map(left.map((item) => [item[identity], item]))
          const next = new Map(right.map((item) => [item[identity], item]))
          for (const id of new Set([...old.keys(), ...next.keys()])) {
            const path = `${field}[${JSON.stringify(id)}]`
            if (!old.has(id) || !next.has(id)) record(path, old.get(id), next.get(id))
            else visit(path, old.get(id), next.get(id))
          }
          const priorOrder = left.map((item) => item[identity])
          const nextOrder = right.map((item) => item[identity])
          if (differs(priorOrder, nextOrder)) record(`${field}: order`, priorOrder, nextOrder)
          return
        }
      }
    }
    if (object(a) && object(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const path = !field
          ? key
          : /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(key)
            ? `${field}.${key}`
            : `${field}[${JSON.stringify(key)}]`
        visit(path, a[key], b[key])
      }
    } else record(field, a, b)
  }
  visit("", before, after)
  return changes
}

/** Counts stay visible even when a long comparison is folded. */
export const documentChangeRows = (changes: ReturnType<typeof documentDiff>) => [
  {
    label: "Changes",
    value:
      `${changes.length} changed fields; ` +
      ["prompts", "entries", "regex"]
        .map((group) => {
          const ids = new Set(
            changes
              .filter((c) => c.field.startsWith(`${group}[`))
              .map((c) => /^.*?\[("(?:\\.|[^"\\])*"|-?\d+)\]/.exec(c.field)?.[1])
          )
          return `${ids.size} ${group === "regex" ? "regex scripts" : group}`
        })
        .join(", ")
  }
]
export const executableNotice =
  "New or changed regex and HTML content stays disabled or unapproved. Review and approve it yourself in the editor."
