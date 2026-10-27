import { modelName } from "@rp/shared/cardNames.ts"
// Lorebook reads and keyword activation, in the reader worker's registered pipeline.
import { Effect } from "effect"
import { matchLorebooks } from "./lorebook.ts"
import { loreAllowance, loreBudget } from "./budget.ts"
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
      const state = need(assembly, "state")
      const attached = yield* sources.lorebooks(state.lorebooks)
      const embedded: Array<LorebookInput> = [...cast.characters, ...cast.personas].flatMap((card) =>
        card.doc.character_book &&
        // Turned off for this chat: an ST import of a card whose book ST never imported.
        state.embeddedLorebooks[card.entity] !== false &&
        !attached.some(
          (book) =>
            state.lorebookBindings[card.entity] === book.id ||
            (state.lorebookBindings[card.entity] === undefined &&
              typeof book.sourceName === "string" &&
              book.sourceName !== "" &&
              card.doc.extensions.world === book.sourceName)
        )
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
      assembly.loreMessageCount = assembly.lorebooks.length
        ? yield* sources.messageCount(need(assembly, "target").parentSlotId)
        : 0
      assembly.loreScanDepth = assembly.lorebooks.reduce(
        (depth, book) =>
          book.doc.entries.reduce(
            (depth, entry) =>
              entry.enabled ? Math.min(1000, Math.max(depth, entry.scan_depth ?? book.doc.scan_depth ?? 2)) : depth,
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
      const sharedWork = { remaining: 4_000_000 }
      const optionsFor = (book: LorebookInput) => ({
        sharedWork,
        ...(book.card
          ? { names: { char: modelName(book.card.doc) }, card: cardFields(book.card, cast.personas[0]) }
          : {})
      })
      const books = inputs.map((book) => {
        const options = optionsFor(book)
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
                secondary_keys: entry.secondary_keys.map((key, i) => env.preview(`${id}:secondary:${i}`, key, options))
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
      const preview = (field: string, text: string) => env.preview(`lore:scan:${field}`, text, { sharedWork })
      const scan = {
        messages,
        messageCount: need(assembly, "loreMessageCount"),
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
      const beforeIssues = assembly.issues.length
      const beforeFrozen = new Set(Object.keys(assembly.frozen))
      const fallback = assembly.request.loreFallback
      if (fallback?.previewEffects) {
        Object.assign(assembly.frozen, fallback.previewEffects.frozen)
        assembly.issues.push(...fallback.previewEffects.issues)
      }
      const result =
        assembly.request.loreFallback ??
        matchLorebooks(
          books,
          scan,
          {
            budget: loreBudget(assembly),
            ...(!need(assembly, "mode").st ? { hardBudget: loreAllowance(assembly) } : {}),
            scanDepth: 2,
            wholeWords: true,
            recursive: true
          },
          randomFor(
            JSON.stringify([
              need(assembly, "target"),
              assembly.request.now,
              inputs.map((b) => [b.id, b.revision]),
              [...cast.characters, ...cast.personas].map((c) => c.revision),
              need(assembly, "history").map((e) => [e.versionId, e.content])
            ])
          ),
          estimateTokens,
          ({ book, entry }) => {
            if (!sharedWork.remaining) return undefined
            const text = env.preview(
              `lore:${book}:${entry.uid}:content`,
              entry.content,
              optionsFor(inputs.find((b) => b.id === book)!)
            )
            return sharedWork.remaining ? text : undefined
          }
        )
      if (!fallback && !sharedWork.remaining)
        assembly.issues.push({
          kind: "lorebook_issue",
          message:
            "Lorebook preview work limit reached (4,000,000 units shared by keys, descriptions and candidate content)."
        })
      if (!result.replayable)
        assembly.loreFallback = fallback ?? {
          ...result,
          previewEffects: {
            frozen: Object.fromEntries(Object.entries(assembly.frozen).filter(([key]) => !beforeFrozen.has(key))),
            issues: assembly.issues.slice(beforeIssues)
          }
        }
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
          message:
            "Lorebook token allowance reached; entries were left out. In our layouts this also cuts ignore_budget overflow."
        })
      return assembly
    })
}
