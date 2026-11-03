// Exercise the stock ST algorithm, substituting only its entry source and metadata.
import type { Browser } from "@playwright/test"
import { activationCases } from "../support/lorebookCases.ts"
import { loreBook, loreEntry } from "../support/loreFixtures.ts"
import { matchLorebooks } from "../../src/assembler/lorebook.ts"
import { loreEffectsAt, loreIdentity, loreEntryKey } from "../../src/assembler/loreTiming.ts"
import { exportLorebook } from "../../src/formats/worldInfo.ts"
import type { FixtureSet } from "./fixtures.ts"
import { openPage } from "./st.ts"
import type { Section } from "./report.ts"

const hook = `
export async function rpLoreTimingGate(input) {
  const originalSource = getSortedEntries;
  const originalRandom = Math.random;
  const ctx = getContext();
  const filename = getCharaFilename();
  const tagKey = getTagKeyForEntity(this_chid);
  const oldTags = { ...ctx.tagMap };
  try {
    world_info_depth = 2;
    world_info_recursive = !!input.recursive;
    world_info_case_sensitive = false;
    world_info_match_whole_words = false;
    world_info_use_group_scoring = false;
    world_info_budget = 25;
    world_info_budget_cap = 0;
    world_info_min_activations = 0;
    world_info_max_recursion_steps = 0;
    for (const key of Object.keys(ctx.tagMap)) delete ctx.tagMap[key];
    if (tagKey) ctx.tagMap[tagKey] = input.tags;
    const entries = input.entries.map((entry) => ({ ...entry, world: 'timed-gate', hash: entry.uid + 1, decorators: [],
      characterFilter: entry.characterFilter && { ...entry.characterFilter, names: entry.characterFilter.names.map((name) => name === 'alice' ? filename : name) }
    }));
    getSortedEntries = async () => entries;
    chat_metadata.timedWorldInfo = { sticky: {}, cooldown: {} };
    for (const type of ['sticky', 'cooldown']) {
      for (const [uid, effect] of Object.entries(input.effects[type] || {})) {
        chat_metadata.timedWorldInfo[type]['timed-gate.' + uid] = { ...effect, hash: Number(uid) + 1, protected: false };
      }
    }
    Math.random = () => 0.5;
    const result = await checkWorldInfo(input.messages, 100000, input.dryRun, { trigger: 'normal' });
    return [...result.allActivatedEntries].map((entry) => entry.uid).sort((a,b) => a-b);
  } finally {
    getSortedEntries = originalSource;
    Math.random = originalRandom;
    for (const key of Object.keys(ctx.tagMap)) delete ctx.tagMap[key];
    Object.assign(ctx.tagMap, oldTags);
  }
}
`

export const compareLoreTiming = async (
  browser: Browser,
  url: string,
  fixtures: FixtureSet
): Promise<ReadonlyArray<Section>> => {
  const page = await openPage(browser, url, { readOnly: true, worldInfoHook: hook })
  const cases = activationCases.filter(
    (c) => c.id.startsWith("T") || (c.id.startsWith("F") && c.id !== "F07" && c.id !== "F08") || c.id === "G09"
  )
  const differences: Array<string> = []
  try {
    await page.evaluate(async (character) => {
      const ctx = (
        globalThis as unknown as {
          SillyTavern: {
            getContext: () => {
              characters: Array<{ name: string }>
              selectCharacterById: (id: number) => Promise<void>
            }
          }
        }
      ).SillyTavern.getContext()
      const index = ctx.characters.findIndex((card) => card.name === character)
      if (index < 0) throw new Error("missing fixture character")
      await ctx.selectCharacterById(index)
    }, fixtures.chats[0]!.card)
    for (const c of cases) {
      const entries = c.entries.map((fields, uid) => loreEntry({ content: `Gate entry ${uid}`, ...fields }, uid))
      const book = loreBook(entries)
      const exported = JSON.parse(new TextDecoder().decode(exportLorebook(book.document)))
      const st = await page.evaluate(
        async (input) => {
          const path = "/scripts/world-info.js"
          const module = await import(/* @vite-ignore */ path)
          return (await module.rpLoreTimingGate(input)) as Array<number>
        },
        {
          entries: Object.values(exported.entries),
          messages: c.messages,
          effects: c.effects ?? {},
          tags: c.speaker?.tags ?? null,
          dryRun: c.dryRun ?? false,
          recursive: c.settings?.recursive ?? false
        }
      )
      const effects = new Map(
        entries.map((entry) => {
          const sticky = c.effects?.sticky?.[String(entry.uid)]
          const cooldown = c.effects?.cooldown?.[String(entry.uid)]
          const key = loreIdentity(book.id, entry)
          const timers = loreEffectsAt({
            count: c.messages.length,
            activations:
              c.effects && !c.dryRun
                ? [
                    {
                      id: c.id,
                      at: sticky?.start ?? cooldown?.start ?? 0,
                      entries: [
                        {
                          key,
                          sticky: sticky ? sticky.end - sticky.start : 0,
                          cooldown: cooldown ? cooldown.end - cooldown.start : (entry.cooldown ?? 0)
                        }
                      ]
                    }
                  ]
                : []
          })
          return [loreEntryKey(book.id, entry), timers.get(key) ?? { sticky: false, cooldown: false }] as const
        })
      )
      const ours = matchLorebooks(
        [book],
        { messages: c.messages, effects, ...(c.speaker ? { speaker: c.speaker } : {}) },
        { budget: 25000, wholeWords: false, recursive: c.settings?.recursive ?? false },
        () => 0.5,
        (text) => text.length
      )
        .activated.map((a) => a.entry.uid)
        .sort((a, b) => a - b)
      if (JSON.stringify(st) !== JSON.stringify(ours) || JSON.stringify(st) !== JSON.stringify(c.stExpected))
        differences.push(
          `${c.id} ${c.title}: ST ${JSON.stringify(st)}, ours ${JSON.stringify(ours)}, expected ${JSON.stringify(c.stExpected)}`
        )
    }
  } finally {
    await page.context().close()
  }
  return [
    {
      title: "Sticky, cooldown and character filters against stock ST",
      notes: [
        `${cases.length} fixtures; actual checkWorldInfo and WorldInfoTimedEffects, synthetic entry source and metadata`
      ],
      differences
    }
  ]
}
