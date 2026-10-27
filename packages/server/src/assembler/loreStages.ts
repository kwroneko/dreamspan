import { modelName } from "@rp/shared/cardNames.ts"
// Lorebook reads and keyword activation, in the reader worker's registered pipeline.
import { Effect } from "effect"
import { matchLorebooks } from "./lorebook.ts"
import { loreAllowance, loreBudget } from "./budget.ts"
import { estimateTokens } from "./st.ts"
import { cardFields } from "./macros.ts"
import { AssemblySources, type AssemblerStage, need } from "./pipeline.ts"
import { type LorebookInput, type LoreRecord, noteCard } from "./types.ts"
import { configurationOf, previousStart } from "./cutState.ts"

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
      // The chat's own books, then the user's global ones the chat didn't turn off.
      const globals = (yield* sources.globalLorebooks).filter(
        (ref) => !state.lorebooks.includes(ref) && state.globalLorebooks[ref] !== false
      )
      const attached = yield* sources.lorebooks([...state.lorebooks, ...globals])
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
      // Due notes with `scan_lore`, whole and expanded, as ST's `addInject` scans its extension
      // prompts: whatever their placement and the scan depth. A card's is expanded as it's sent
      // (`noteText`): `{{char}}` bound to the card, without card fields.
      const injections = (assembly.notes ?? []).flatMap((note) => {
        if (note.doc.scan_lore !== true || note.doc.kind === "imported_summary") return []
        const owner = [...cast.characters, ...cast.personas].find((c) => c.entity === noteCard(note.doc))
        const text = env.preview(
          `lore:scan:note:${note.entity}`,
          note.doc.content.trim(),
          owner ? { sharedWork, withoutCard: true, names: { char: modelName(owner.doc) } } : { sharedWork }
        )
        return [{ text, scan: true, name: note.doc.title || "Untitled note" }]
      })
      const scan = {
        injections,
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
            ...(need(assembly, "mode").loreBelowHistory ? { hardBudget: loreAllowance(assembly) } : {}),
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
      const lore: Array<NonNullable<typeof assembly.lore>[number]> = result.activated.map((a) => ({
        entry: a.entry,
        piece: record(a.book, a.entry.uid, { status: "activated", step: a.step, why: a.why }, a.entry.content),
        book: a.book,
        revision: inputs.find((b) => b.id === a.book)!.revision
      }))
      // Entries pinned above the history stay while its start holds (DESIGN §1.3), matched or
      // not; composition lets them go if the start moves this turn. A changed configuration
      // (a book switched or edited, the preset, the setting) re-evaluates everything.
      const prior = previousStart(assembly)?.state
      const pins =
        !need(assembly, "mode").loreBelowHistory && prior?.configuration === configurationOf(assembly)
          ? (prior.pinnedLore ?? [])
          : []
      for (const pin of pins) {
        if (lore.some((e) => e.book === pin.book && e.entry.uid === pin.uid)) continue
        const book = inputs.find((b) => b.id === pin.book && b.revision === pin.revision)
        const entry = book?.doc.entries.find((e) => e.uid === pin.uid && e.enabled)
        if (!book || !entry) continue
        const content = env.preview(`lore:${book.id}:${entry.uid}:content`, entry.content, optionsFor(book))
        lore.push({
          entry: { ...entry, content },
          piece: record(book.id, entry.uid, { status: "activated", step: 0, why: { kind: "pinned" } }, content),
          book: book.id,
          revision: book.revision,
          pinnedOnly: true
        })
      }
      // A pin takes the place activation would give it, so the pinned blocks stay byte for byte.
      const rank = new Map(
        books
          .flatMap((book) => book.document.entries.map((entry) => ({ key: `${book.id}:${entry.uid}`, entry })))
          .toSorted((a, b) => b.entry.order - a.entry.order)
          .map(({ key }, i) => [key, i])
      )
      const rankOf = (e: (typeof lore)[number]) => rank.get(`${e.book}:${e.entry.uid}`) ?? rank.size
      if (lore.some((e) => e.pinnedOnly)) lore.sort((a, b) => rankOf(a) - rankOf(b))
      assembly.lore = lore
      for (const s of result.skipped)
        if (!lore.some((e) => e.pinnedOnly && e.book === s.book && e.entry.uid === s.entry.uid))
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
