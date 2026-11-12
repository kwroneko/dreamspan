// Pure document policy shared by approval previews and the writer. Executable changes
// stay off until the user approves them through the ordinary editor controls.
import { canonicalJson } from "@rp/shared/editing.ts"
import type { Doc, EntityKind } from "@rp/shared/library.ts"
import type { PresetDoc } from "@rp/shared/docs/preset.ts"
import type { LorebookDoc } from "@rp/shared/docs/lorebook.ts"

const differs = (a: unknown, b: unknown) => canonicalJson(a) !== canonicalJson(b)
const html = (value: unknown): boolean =>
  typeof value === "string"
    ? /<\/?[a-z][^>]*>|javascript:|on\w+\s*=/i.test(value)
    : Array.isArray(value)
      ? value.some(html)
      : value !== null && typeof value === "object" && Object.values(value).some(html)

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
            (html(prompt) || differs(previous?.unsupported, prompt.unsupported)) &&
            (differs(previous, prompt) ||
              (old.order?.find((p) => p.identifier === prompt.identifier)?.enabled !== true &&
                doc.order.find((p) => p.identifier === prompt.identifier)?.enabled === true))
          )
        })
        .map((p) => p.identifier)
    )
    return {
      ...next,
      regex,
      order: doc.order.map((entry) => (blocked.has(entry.identifier) ? { ...entry, enabled: false } : entry)),
      regex_approved: !changedCode && old.regex_approved === true,
      ...(changedCode || blocked.size ? { html_scripts_approved: false, html_network_approved: false } : {})
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
          html(entry) ||
          differs(previous?.extensions ?? {}, entry.extensions) ||
          differs(previous?.unknown_fields, entry.unknown_fields) ||
          (entry.automation_id !== "" && previous?.automation_id !== entry.automation_id)) &&
          (changedCode || differs(previous, entry))
          ? { ...entry, enabled: false }
          : entry
      })
    }
  }
  return next
}

/** Complete changed fields, rendered as literal text by the existing approval component. */
export const documentDiff = (before: Doc, after: Doc) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => differs(before[field], after[field]))
    .map((field) => ({
      field,
      before:
        typeof before[field] === "string"
          ? (before[field] as string)
          : (JSON.stringify(before[field], null, 2) ?? "(absent)"),
      after:
        typeof after[field] === "string"
          ? (after[field] as string)
          : (JSON.stringify(after[field], null, 2) ?? "(absent)")
    }))
export const executableNotice =
  "New or changed regex and HTML content stays disabled or unapproved. Review and approve it yourself in the editor."
