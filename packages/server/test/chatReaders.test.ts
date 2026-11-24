// A pending chat (the new-chat page's, before its first turn; DESIGN §2.1) affects nothing until it
// is committed, so every reader that reaches across a user's chats leaves it out with the one
// predicate in src/db/listedChats.ts. This scans the server's sources for SQL that reaches chats
// (or the tables that cross them: card membership, participation, message search, pins) and fails
// on a new one that doesn't say how it treats pending chats:
// - it uses `listed(…)`, `listedSql(…)`, `listedOr(…)`, `committed(…)`/`committedSql(…)`, or reads
//   only `status = 'active'` chats;
// - it carries `chat:includes-pending: <why>` (a comment in the SQL or on the line), for a reader
//   that must see them (one that keeps a pending chat's media alive, say);
// - or it is counted in SCOPED below: it reads one chat by its id (the chat's own page sees its
//   pending chat), or reaches chats only through rows a pending chat never has (rollouts, summary
//   jobs, import records, pins). A new one raises its file's count, after checking which it is.
// The SQL found is the template or string around the match, so a predicate built elsewhere and
// spliced in (`ELIGIBLE`, say) doesn't count: name the helper in the statement itself.
// test/draftInvisible.test.ts checks the outputs themselves.
import { assert, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../src", import.meta.url))
const sources = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })

/** Schema files: their triggers and views are checked by the schema's own tests. */
const schema = (file: string) => /(^|\/)(baseline|migration\w*|listedChats)\.ts$/.test(file)

const reaches =
  /\b(?:FROM|JOIN)\s+chats\b|\bcard_chat_membership\b|\bversion_participants\b|\bversions_fts\b|\bchat_pins\b/g
const covered = /\blisted(?:Sql|Or)?\(|\bcommitted(?:Sql)?\(|\bstatus\s*=\s*'active'|chat:includes-pending:\s*\S/

/** The template or string the match is in, as far as the nearest backticks. */
const statementAt = (text: string, at: number) => {
  const start = text.lastIndexOf("`", at)
  const end = text.indexOf("`", at)
  return start < 0 || end < 0 ? text.slice(Math.max(0, at - 400), at + 400) : text.slice(start, end)
}
const lineAt = (text: string, at: number) =>
  text.slice(text.lastIndexOf("\n", at) + 1, (text.indexOf("\n", at) + 1 || text.length + 1) - 1)

const SCOPED: Readonly<Record<string, number>> = {
  "db/agentHistoryReads.ts": 1,
  "db/agentHistoryShared.ts": 3,
  "db/agentHistoryWrites.ts": 2,
  "db/agentReads.ts": 22,
  "db/assemblyReads.ts": 7,
  "db/assemblySources.ts": 4,
  "db/awayMarks.ts": 1,
  "db/bin.ts": 22,
  "db/binForks.ts": 2,
  "db/chatKindPolicy.ts": 6,
  "db/chatSetupReads.ts": 6,
  "db/chatSetupWrites.ts": 4,
  "db/composerImages.ts": 2,
  "db/composerLibrary.ts": 1,
  "db/decisions.ts": 4,
  "db/editorReads.ts": 2,
  "db/editorWrites.ts": 1,
  "db/externalMedia.ts": 1,
  "db/fileVersions.ts": 1,
  "db/forkLabels.ts": 1,
  "db/forkNotes.ts": 2,
  "db/forks.ts": 1,
  "db/forkState.ts": 3,
  "db/forkSummaries.ts": 5,
  "db/generationWrites.ts": 3,
  "db/graphWrites.ts": 9,
  "db/historyChanges.ts": 3,
  "db/historyReads.ts": 3,
  "db/historyShared.ts": 1,
  "db/historyStages.ts": 1,
  "db/historyStart.ts": 1,
  "db/inspectorReads.ts": 4,
  "db/libraryAttachments.ts": 1,
  "db/lcmBackfill.ts": 5,
  "db/lcmCoverage.ts": 2,
  "db/lcmEnableReads.ts": 3,
  "db/lcmEnableWrites.ts": 3,
  "db/lcmFactStore.ts": 1,
  "db/lcmFork.ts": 1,
  "db/lcmLayer.ts": 4,
  "db/lcmMaintain.ts": 2,
  "db/lcmModelBudget.ts": 1,
  "db/lcmPath.ts": 1,
  "db/lcmPlanning.ts": 3,
  "db/lcmQueue.ts": 1,
  "db/lcmReads.ts": 3,
  "db/lcmUiReads.ts": 2,
  "db/lcmUiWrites.ts": 1,
  "db/lcmWrites.ts": 1,
  "db/libraryWrites.ts": 1,
  "db/mcpReads.ts": 1,
  "db/mcpSchema.ts": 1,
  "db/mcpWrites.ts": 1,
  "db/merges.ts": 3,
  "db/messageSearch.ts": 1,
  "db/noteAt.ts": 1,
  "db/noteHistory.ts": 1,
  "db/operationPolicies.ts": 2,
  "db/participation.ts": 1,
  "db/queueRows.ts": 1,
  "db/reads.ts": 8,
  "db/revisionNumbers.ts": 1,
  "db/rolloutEffects.ts": 3,
  "db/rolloutWrites.ts": 2,
  "db/shellEpoch.ts": 1,
  "db/shellQueries.ts": 2,
  "db/shellReads.ts": 4,
  "db/shellWrites.ts": 7,
  "db/snippets.ts": 1,
  "db/stArrival.ts": 2,
  "db/stateMarks.ts": 1,
  "db/stateRead.ts": 2,
  "db/stateRefs.ts": 4,
  "db/stImportPlanReads.ts": 3,
  "db/stImportPlanStamp.ts": 1,
  "db/stImportReads.ts": 1,
  "db/stImportWrites.ts": 5,
  "db/storyWriteScope.ts": 1,
  "db/subagentResume.ts": 2,
  "db/subagents.ts": 6,
  "db/subagentSettings.ts": 2,
  "db/summaryValidity.ts": 5,
  "db/tableRebuild.ts": 1,
  "db/threadReads.ts": 2,
  "db/threadWrites.ts": 1,
  "db/workshopAttach.ts": 3,
  "db/workshopEffects.ts": 3,
  "db/workshopForks.ts": 1,
  "db/workshopGrants.ts": 6,
  "db/workshopPairing.ts": 2,
  "db/workshopTranscript.ts": 1,
  "db/workshopWrites.ts": 2,
  "db/writes.ts": 12
}

it("every reader across a user's chats says how it treats pending chats", () => {
  const found: Record<string, number> = {}
  for (const path of sources(root)) {
    const file = relative(root, path)
    if (schema(file)) continue
    const text = readFileSync(path, "utf8")
    for (const match of text.matchAll(reaches)) {
      if (covered.test(statementAt(text, match.index)) || covered.test(lineAt(text, match.index))) continue
      found[file] = (found[file] ?? 0) + 1
    }
  }
  const sorted = Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)))
  assert.deepStrictEqual(
    sorted,
    SCOPED,
    "A reader reaches across chats without saying how it treats pending chats (see this file's header). " +
      `The counts found now: ${JSON.stringify(sorted, null, 2)}`
  )
})

/**
 * A chat's status changes in one place, so a pending chat is committed by the write that makes
 * its first turn and by nothing else (db/pendingChats.ts); and only that module and the bin's
 * purge delete a chat row (a pending chat is never in the bin: its writes refuse it).
 */
it("only pendingChats.ts changes a chat's status, and only it and the bin delete chats", () => {
  const status: Array<string> = []
  const deletes: Array<string> = []
  for (const path of sources(root)) {
    const file = relative(root, path)
    if (schema(file)) continue
    const text = readFileSync(path, "utf8")
    for (const match of text.matchAll(/\bUPDATE\s+chats\s+SET\b/g)) {
      if (/\bstatus\s*=/.test(statementAt(text, match.index))) status.push(file)
    }
    for (const _ of text.matchAll(/\bDELETE\s+FROM\s+chats\b/g)) deletes.push(file)
  }
  assert.deepStrictEqual([...new Set(status)], ["db/pendingChats.ts"])
  assert.deepStrictEqual([...new Set(deletes)].sort(), ["db/bin.ts", "db/pendingChats.ts"])
})
