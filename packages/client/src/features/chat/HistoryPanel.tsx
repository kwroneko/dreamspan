import { HistoryDiff, HistoryPreviewContext } from "./historyPreview.tsx"
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { HistoryHit, HistoryRecord, HistorySearch, HistoryCursor } from "@rp/shared/historyApi.ts"
import type { SlotId } from "@rp/shared/chat.ts"
import { Button } from "../../ui/Button.tsx"
import { showToast } from "../../ui/Toast.tsx"
import type { ChatSession, ChatView } from "./session.ts"

type Record = typeof HistoryRecord.Type
const keyOf = (hit: HistoryHit) => `${hit.kind}:${hit.targetId}`
const initial: HistorySearch = {
  pairs: [{ find: "", replace: "" }],
  matchCase: false,
  wholeWord: false,
  regex: false,
  preserveCase: false,
  messages: true,
  swipes: true,
  summaries: true
}

export function HistoryPanel({
  session,
  view,
  onJump,
  onSummaries,
  active
}: {
  session: ChatSession
  view: ChatView
  onJump: (slot: SlotId) => void
  onSummaries: (summary: string) => void
  active: boolean
}) {
  const { publish } = useContext(HistoryPreviewContext)
  const [search, setSearch] = useState(initial)
  const [hits, setHits] = useState<ReadonlyArray<HistoryHit>>([])
  const [records, setRecords] = useState<ReadonlyArray<Record>>([])
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set())
  const [cost, setCost] = useState<{ messages: number; summaries: number; tokens: number } | null>(null)
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [completedSearch, setCompletedSearch] = useState("")
  const [current, setCurrent] = useState(0)
  const group = useRef<string | undefined>(undefined)
  const revision = useRef(0)
  const forkId = view.forkId ?? view.chat?.currentForkId
  const target = forkId ? { chatId: session.id, forkId } : null
  const history = useCallback(async () => {
    if (!forkId) return
    const result = await session.call((c) => c("ListHistoryEdits", { chatId: session.id, forkId }))
    if (result.ok) setRecords(result.value)
    else setError(result.error.message)
  }, [session, forkId])
  useEffect(() => {
    const timer = setTimeout(() => {
      if (active) void history()
    }, 0)
    return () => clearTimeout(timer)
  }, [active, history])
  useEffect(() => {
    const request = ++revision.current

    const timer = setTimeout(async () => {
      if (!forkId || search.pairs.some((p) => !p.find)) {
        setHits([])
        publish([])
        setScanning(false)
        return
      }
      setError("")
      setScanning(true)
      setSkipped(new Set())
      let cursor: typeof HistoryCursor.Type | undefined
      const all: HistoryHit[] = []
      do {
        const result = await session.call((c) =>
          c("PreviewHistory", { chatId: session.id, forkId, search, ...(cursor ? { cursor } : {}) })
        )
        if (revision.current !== request) return
        if (!result.ok) {
          setError(result.error.message)
          setHits([])
          publish([])
          setScanning(false)
          return
        }
        all.push(...result.value.hits)
        cursor = result.value.next ?? undefined
        if (all.length > 10000) {
          setError("Too many results. Narrow the search.")
          setScanning(false)
          return
        }
      } while (cursor)
      setHits(all)
      const raw = all.filter((h) => h.kind === "version_replace" && h.selected)
      const summaries = view.lcm?.layer ?? []
      const firstSummary = summaries.findIndex((s) =>
        all.some((h) => h.kind === "summary_revision" && h.targetId === s.id)
      )
      const firstDepth = firstSummary >= 0 ? 0 : Math.min(...raw.map((h) => h.depth), Number.MAX_SAFE_INTEGER)
      const estimate = await session.call((c) =>
        c("HistoryEditCost", {
          chatId: session.id,
          forkId,
          fromDepth: firstDepth,
          // CacheWarmth.historyStart.depth is the display position (including insertions).
          retainedDepth: view.history?.historyStart?.depth ?? 0,
          summaryIds: firstSummary < 0 ? [] : summaries.slice(firstSummary).map((s) => s.id)
        })
      )
      if (revision.current !== request) return
      setCost(estimate.ok ? estimate.value : null)
      setCurrent(0)
      setCompletedSearch(JSON.stringify(search))
      setScanning(false)
    }, 250)
    return () => {
      clearTimeout(timer)
      if (revision.current === request) revision.current = request + 1
    }
  }, [search, session, forkId, publish, view.lcm, view.history])
  useEffect(() => () => publish([]), [publish])
  const undo = async (record: Record, slotId?: string, itemIds?: ReadonlyArray<number>) => {
    if (!target) return
    setPending(true)
    const result = await session.call((c) =>
      c("UndoHistoryEdit", {
        ...target,
        changesetId: record.id,
        ...(slotId ? { slotId } : {}),
        ...(itemIds ? { itemIds } : {})
      })
    )
    setPending(false)
    if (!result.ok) setError(result.error.message)
    else {
      setError(result.value.conflicts.length ? `${result.value.conflicts.length} later edits were kept.` : "")
      void history()
      setSearch((s) => ({ ...s }))
    }
  }
  const included = useMemo(
    () =>
      hits
        .filter((h) => !skipped.has(keyOf(h)))
        .flatMap((h) => {
          const matches = h.matches.filter((_, i) => !skipped.has(`${keyOf(h)}:${i}`))
          if (!matches.length) return []
          let after = "",
            end = 0
          for (const match of matches) {
            after += h.before.slice(end, match.start) + match.replacement
            end = match.end
          }
          return [{ ...h, matches, after: after + h.before.slice(end) }]
        }),
    [hits, skipped]
  )
  useEffect(() => {
    publish(completedSearch === JSON.stringify(search) ? included : [], active)
  }, [active, completedSearch, search, included, publish])
  const apply = async (one: boolean) => {
    if (!target || JSON.stringify(search) !== completedSearch) return
    let edits = included
    if (one) {
      const matches = included.flatMap((hit) => hit.matches.map((match) => ({ hit, match })))
      const chosen = matches[current % matches.length]
      if (!chosen) return
      const { hit, match } = chosen
      edits = [{ ...hit, after: hit.before.slice(0, match.start) + match.replacement + hit.before.slice(match.end) }]
    }
    setPending(true)
    const result = await session.call((c) =>
      c("ApplyHistoryEdits", {
        title: "Search and replace",
        ...(group.current ? { groupId: group.current } : {}),
        applications: [
          {
            ...target,
            summariesIncluded: !one && search.summaries && skipped.size === 0,
            edits: edits.map(({ kind, targetId, beforeId, before, after }) => ({
              kind,
              targetId,
              beforeId,
              before,
              after
            }))
          }
        ]
      })
    )
    setPending(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    group.current = result.value.groupId
    const recordsRead = await session.call((c) => c("ListHistoryEdits", target))
    if (recordsRead.ok) {
      setRecords(recordsRead.value)
      const record = recordsRead.value.find((r) => r.id === result.value.changesetIds[0])
      showToast({
        title: "History replaced",
        actions: record ? [{ label: "Undo", onClick: () => void undo(record) }] : []
      })
    }
    setSearch((s) => ({ ...s }))
  }
  const counts = (test: (h: HistoryHit) => boolean) => hits.filter(test).reduce((n, h) => n + h.matches.length, 0)
  const openHit = (hit: HistoryHit) => {
    if (hit.kind === "summary_revision") onSummaries(hit.targetId)
    else onJump(hit.slotId as SlotId)
  }
  const step = (back: boolean) => {
    const matches = included.flatMap((hit) => hit.matches.map((match) => ({ hit, match })))
    if (!matches.length) return
    const next = (current + (back ? -1 : 1) + matches.length) % matches.length
    setCurrent(next)
    openHit(matches[next]!.hit)
  }
  return (
    <div className="flex flex-col gap-4 p-3 text-sm">
      <h2 className="font-semibold">Search and replace</h2>
      <p className="text-muted">Only this chat. Forks and other chats keep their history.</p>
      {search.pairs.map((pair, i) => (
        <fieldset key={i} className="flex flex-col gap-2">
          <label>
            Find {i ? i + 1 : ""}
            <input
              aria-label={i ? `Find ${i + 1}` : "Find"}
              className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono"
              value={pair.find}
              onChange={(e) =>
                setSearch({
                  ...search,
                  pairs: search.pairs.map((p, n) => (n === i ? { ...p, find: e.target.value } : p))
                })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  step(e.shiftKey)
                }
              }}
            />
          </label>
          <label>
            Replace with
            <input
              aria-label={i ? `Replace with ${i + 1}` : "Replace with"}
              className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono"
              value={pair.replace}
              onChange={(e) =>
                setSearch({
                  ...search,
                  pairs: search.pairs.map((p, n) => (n === i ? { ...p, replace: e.target.value } : p))
                })
              }
            />
          </label>
        </fieldset>
      ))}
      <Button
        onClick={() => setSearch({ ...search, pairs: [...search.pairs, { find: "", replace: "" }] })}
        disabled={search.pairs.length >= 20}
      >
        ＋ Add pair
      </Button>
      <div className="flex flex-wrap gap-3">
        {(
          [
            ["matchCase", "Aa · Match case"],
            ["wholeWord", "ab · Whole word"],
            ["regex", ".* · Regular expression"],
            ["preserveCase", "Preserve case"],
            ["messages", "Messages"],
            ["swipes", "Swipes"],
            ["summaries", "Summaries"]
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={search[key]}
              onChange={(e) => setSearch({ ...search, [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <p role="status">
        {scanning
          ? "Searching…"
          : `${counts((h) => h.kind === "version_replace" && h.selected)} in messages, ${counts((h) => h.kind === "version_replace" && !h.selected)} in swipes, ${counts((h) => h.kind === "summary_revision")} in summaries`}
      </p>
      <p className="text-muted">
        {cost
          ? `The model will re-read about ${cost.messages} messages and ${cost.summaries} summaries on the next reply (cache: ~${cost.tokens.toLocaleString()} tokens).`
          : "The next reply will use the edited history. Choose a model to see the current context boundary."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={pending || scanning || JSON.stringify(search) !== completedSearch || !included.length || !!error}
          onClick={() => void apply(true)}
        >
          Replace
        </Button>
        <Button
          disabled={pending || scanning || JSON.stringify(search) !== completedSearch || !included.length || !!error}
          onClick={() => void apply(false)}
        >
          Replace all
        </Button>
        <Button onClick={() => step(true)} disabled={!included.length}>
          Previous
        </Button>
        <Button onClick={() => step(false)} disabled={!included.length}>
          Next
        </Button>
      </div>
      {(["Messages", "Swipes", "Summaries"] as const).map((kind) => (
        <section key={kind} className="flex flex-col gap-2">
          <h3 className="font-medium">{kind}</h3>
          {hits
            .filter((h) =>
              kind === "Summaries"
                ? h.kind === "summary_revision"
                : h.kind === "version_replace" && h.selected === (kind === "Messages")
            )
            .map((hit) => (
              <article key={keyOf(hit)} className="rounded-md border border-border p-2">
                <div className="flex items-center justify-between gap-2">
                  <button className="text-accent underline" onClick={() => openHit(hit)}>
                    {hit.level
                      ? `Level ${hit.level} summary, messages ${hit.depth + 1}–${hit.toDepth + 1}`
                      : `Message ${hit.depth + 1}`}
                  </button>
                  <label className="flex gap-1">
                    <input
                      type="checkbox"
                      checked={skipped.has(keyOf(hit))}
                      onChange={(e) =>
                        setSkipped((old) => {
                          const next = new Set(old)
                          if (e.target.checked) next.add(keyOf(hit))
                          else next.delete(keyOf(hit))
                          return next
                        })
                      }
                    />
                    Skip
                  </label>
                </div>
                <div className="my-2 flex flex-col gap-1">
                  {hit.matches.map((match, i) => (
                    <label key={i} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        aria-label={`Skip match ${i + 1} in message ${hit.depth + 1}`}
                        checked={skipped.has(`${keyOf(hit)}:${i}`)}
                        onChange={(e) =>
                          setSkipped((old) => {
                            const next = new Set(old)
                            const key = `${keyOf(hit)}:${i}`
                            if (e.target.checked) next.add(key)
                            else next.delete(key)
                            return next
                          })
                        }
                      />
                      <span>
                        Skip “{hit.before.slice(match.start, match.end)}” → “{match.replacement}”
                      </span>
                    </label>
                  ))}
                </div>
                <div className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
                  <HistoryDiff hit={included.find((h) => keyOf(h) === keyOf(hit)) ?? { ...hit, matches: [] }} />
                </div>
              </article>
            ))}
        </section>
      ))}
      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">History edits</h2>
        {!records.length && <p className="text-muted">No history edits yet.</p>}
        {records.map((record) => (
          <article key={record.id} className="rounded-md border border-border p-2">
            <div className="font-medium">{record.title}</div>
            <p className="text-muted">
              {record.inherited ? `Made in ${record.madeInName} · ` : ""}
              {record.status}
            </p>
            <Button disabled={pending || record.status === "undone"} onClick={() => void undo(record)}>
              Undo all
            </Button>
            {record.items.map((item) => (
              <details key={item.id} className="mt-2">
                <summary>
                  {item.kind === "summary_revision" ? "Summary" : "Message"} ·{" "}
                  {item.applied ? "applied" : "undone or changed"}
                </summary>
                <div className="my-2 whitespace-pre-wrap break-words font-mono text-xs">
                  <del>{item.before}</del> → <ins>{item.after}</ins>
                </div>
                <Button
                  disabled={pending || !item.applied}
                  onClick={() =>
                    void (item.kind === "version_replace" && item.slotId
                      ? undo(record, item.slotId)
                      : undo(record, undefined, [item.id]))
                  }
                >
                  {item.kind === "summary_revision"
                    ? "Undo this summary"
                    : item.kind === "state_event"
                      ? "Undo this state change"
                      : "Undo this message and covering summaries"}
                </Button>
              </details>
            ))}
          </article>
        ))}
      </section>
    </div>
  )
}
