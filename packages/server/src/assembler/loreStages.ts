// Lorebook reads and keyword activation, in the reader worker's registered pipeline.
import { Effect } from "effect"
import { matchLorebooks } from "./lorebook.ts"
import { estimateTokens } from "./st.ts"
import { cardFields } from "./macros.ts"
import { AssemblySources, type AssemblerStage, need } from "./pipeline.ts"
import type { LorebookInput, LoreRecord } from "./types.ts"

/** A separate stream: probability never consumes the macros' random draws. */
const randomFor = (input: string) => {
  let seed = 2166136261
  for (let i = 0; i < input.length; i++) seed = Math.imul(seed ^ input.charCodeAt(i), 16777619)
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let n = Math.imul(seed ^ (seed >>> 15), seed | 1)
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61)
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296
  }
}

export const lorebooksStage: AssemblerStage = {
  id: "lorebooks",
  run: (assembly) =>
    Effect.gen(function* () {
      const sources = yield* AssemblySources
      const cast = need(assembly, "cast")
      const attached = yield* sources.lorebooks(need(assembly, "state").lorebooks)
      const embedded: Array<LorebookInput> = [...cast.characters, ...cast.personas].flatMap((card) =>
        card.doc.character_book
          ? [
              {
                id: `card:${card.entity}`,
                entity: card.entity,
                revision: card.revision,
                doc: card.doc.character_book,
                card
              }
            ]
          : []
      )
      assembly.lorebooks = [...attached, ...embedded]
      assembly.loreScanDepth = assembly.lorebooks.reduce(
        (depth, book) =>
          book.doc.entries.reduce(
            (depth, entry) =>
              entry.enabled
                ? Math.min(1000, Math.max(depth, entry.delay ? 1000 : (entry.scan_depth ?? book.doc.scan_depth ?? 2)))
                : depth,
            depth
          ),
        0
      )
      return assembly
    })
}

export const loreActivationStage: AssemblerStage = {
  id: "lore-activation",
  run: (assembly) =>
    Effect.sync(() => {
      const inputs = need(assembly, "lorebooks")
      if (!inputs.length) {
        assembly.lore = []
        return assembly
      }
      const env = need(assembly, "macros")
      const cast = need(assembly, "cast")
      const books = inputs.map((book) => {
        const options = book.card
          ? { names: { char: book.card.doc.name }, card: cardFields(book.card, cast.personas[0]) }
          : {}
        return {
          id: book.id,
          document: {
            ...book.doc,
            entries: book.doc.entries.map((entry) => {
              if (entry.placement_override)
                assembly.issues.push({
                  kind: "lorebook_issue",
                  message: `${book.id} #${entry.uid}: placement_override is unsupported; the layout's lore placement applies.`
                })
              if (!entry.enabled) return entry
              const id = `lore:${book.id}:${entry.uid}`
              return {
                ...entry,
                keys: entry.keys.map((key, i) => env.preview(`${id}:key:${i}`, key, options)),
                secondary_keys: entry.secondary_keys.map((key, i) => env.preview(`${id}:secondary:${i}`, key, options)),
                content: env.preview(`${id}:content`, entry.content, options)
              }
            })
          }
        }
      })
      const messages = need(assembly, "projected")
        .toReversed()
        .map((p) => {
          const text = assembly.scripted?.get(p.entry.versionId)?.text ?? env.text(p.piece)
          return `${p.name}: ${text}`
        })
      const char = cast.characters[0]
      const preview = (field: string, text: string) => env.preview(`lore:scan:${field}`, text)
      const samplers = need(assembly, "preset").doc.samplers
      const context =
        Math.min(samplers.openai_max_context, assembly.model?.context ?? Infinity) - samplers.openai_max_tokens
      const scan = {
        messages,
        trigger: cast.type,
        descriptions: {
          persona_description: preview("persona", cast.personas[0]?.doc.description ?? ""),
          character_description: preview("description", char?.doc.description ?? ""),
          character_personality: preview("personality", char?.doc.personality ?? ""),
          scenario: preview("scenario", char?.doc.scenario ?? ""),
          creator_notes: preview("creator_notes", char?.doc.creator_notes ?? ""),
          character_depth_prompt: preview(
            "depth_prompt",
            assembly.notes?.find((n) => n.first && "card" in n.doc.owner && n.doc.owner.card === char?.entity)?.doc
              .content ?? ""
          )
        }
      }
      const result =
        assembly.request.loreFallback ??
        matchLorebooks(
          books,
          scan,
          { budget: Math.max(1, Math.round(context * 0.25)), scanDepth: 2, wholeWords: true, recursive: true },
          randomFor(
            JSON.stringify([
              need(assembly, "target"),
              assembly.request.now,
              inputs.map((b) => [b.id, b.revision]),
              [...cast.characters, ...cast.personas].map((c) => c.revision),
              need(assembly, "history").map((e) => [e.versionId, e.content])
            ])
          ),
          estimateTokens
        )
      if (!result.replayable) assembly.loreFallback = result
      const record = (book: string, uid: number, activation: LoreRecord, text: string) => {
        const input = inputs.find((b) => b.id === book)!
        return env.verbatim(
          `lore:${book}:${uid}`,
          { kind: "lorebook", book, revision: input.revision, uid, activation },
          text
        )
      }
      assembly.lore = result.activated.map((a) => ({
        entry: a.entry,
        piece: record(a.book, a.entry.uid, { status: "activated", step: a.step, why: a.why }, a.entry.content)
      }))
      for (const s of result.skipped)
        record(s.book, s.entry.uid, { status: "skipped", step: s.step, reason: s.reason }, "")
      for (const issue of result.issues)
        assembly.issues.push({
          kind: "lorebook_issue",
          message: `${issue.book} #${issue.uid}${issue.key ? ` (${issue.key})` : ""}: ${issue.detail}${issue.count > 1 ? ` (${issue.count} entries/keys)` : ""}`
        })
      if (result.skipped.some((s) => s.reason === "budget"))
        assembly.issues.push({
          kind: "lorebook_issue",
          message: "Lorebook token allowance reached; entries were left out."
        })
      return assembly
    })
}
