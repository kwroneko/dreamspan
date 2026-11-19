// Synthetic vectors verified against public ST 1.19.0; see spec/ST-WORLD-INFO.md.
import type { LorebookEntry } from "@dreamspan/shared/docs/lorebook.ts"
import type { matchLorebooks } from "../../src/assembler/lorebook.ts"
type Input = Parameters<typeof matchLorebooks>
interface Case {
  id: string
  title: string
  entries: ReadonlyArray<Partial<LorebookEntry>>
  messages: ReadonlyArray<string>
  expected: ReadonlyArray<number>
  stExpected: ReadonlyArray<number>
  difference?: string
  settings?: Partial<Input[2]>
  descriptions?: Input[1]["descriptions"]
  injections?: Input[1]["injections"]
  trigger?: string
  random?: number
  effects?: Partial<Record<"sticky" | "cooldown", Record<string, { start: number; end: number }>>>
  speaker?: Input[1]["speaker"]
  dryRun?: boolean
}
export const activationCases: ReadonlyArray<Case> = [
  {
    id: "K01",
    title: "Plain substring",
    entries: [{ keys: ["cat"] }],
    messages: ["concatenate"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "K02",
    title: "Plain metacharacters are literal",
    entries: [{ keys: ["c.t"] }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  { id: "K03", title: "Empty primary list", entries: [{ keys: [] }], messages: ["cat"], expected: [], stExpected: [] },
  {
    id: "K04",
    title: "Any primary key",
    entries: [{ keys: ["dog", "cat"] }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "K05",
    title: "Empty string primary",
    entries: [{ keys: [""] }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "K06",
    title: "Whitespace primary becomes empty but original is truthy",
    entries: [{ keys: ["   "] }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "K07",
    title: "Key trimmed",
    entries: [{ keys: [" cat "] }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "K08",
    title: "Default case insensitive",
    entries: [{ keys: ["CAT"] }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "K09",
    title: "Entry case sensitive",
    entries: [{ keys: ["CAT"], case_sensitive: true }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "K10",
    title: "Entry false overrides global true",
    entries: [{ keys: ["CAT"], case_sensitive: false }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0],
    settings: { caseSensitive: true }
  },
  {
    id: "K11",
    title: "Entry null inherits global true",
    entries: [{ keys: ["CAT"] }],
    messages: ["cat"],
    expected: [],
    stExpected: [],
    settings: { caseSensitive: true }
  },
  {
    id: "K12",
    title: "Non ASCII lowercase",
    entries: [{ keys: ["ÉCOLE"] }],
    messages: ["école"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "R01",
    title: "Regex without i ignores plaintext case default",
    entries: [{ keys: ["/CAT/"] }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "R02",
    title: "Regex i overrides entry case sensitivity",
    entries: [{ keys: ["/CAT/i"], case_sensitive: true }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "R03",
    title: "Regex ignores whole words",
    entries: [{ keys: ["/cat/"], match_whole_words: true }],
    messages: ["concatenate"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "R04",
    title: "Regex g reconstructed for every call",
    entries: [{ keys: ["/cat/g"] }, { keys: ["/cat/g"] }],
    messages: ["cat"],
    expected: [0, 1],
    stExpected: [0, 1]
  },
  {
    id: "R05",
    title: "Regex m sees message-line sentinel",
    entries: [{ keys: ["/^\u0001cat$/m"] }],
    messages: ["other", "cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "R06",
    title: "Regex s spans message separators",
    entries: [{ keys: ["/cat.*dog/s"] }],
    messages: ["cat", "dog"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "R07",
    title: "Regex without s cannot span newline",
    entries: [{ keys: ["/cat.*dog/"] }],
    messages: ["cat", "dog"],
    expected: [],
    stExpected: []
  },
  {
    id: "R08",
    title: "Regex u Unicode property",
    entries: [{ keys: ["/\\p{L}+/u"] }],
    messages: ["東京"],
    expected: [],
    stExpected: [0],
    difference: "Unicode property regexes are refused by the safe engine and reported."
  },
  {
    id: "R09",
    title: "Regex y cannot skip initial sentinel",
    entries: [{ keys: ["/cat/y"] }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "R10",
    title: "Regex y with initial sentinel",
    entries: [{ keys: ["/\u0001cat/y"] }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "R11",
    title: "Invalid pattern falls back literal",
    entries: [{ keys: ["/[/"] }],
    messages: ["/[/"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "R12",
    title: "Invalid pattern does not become partial regex",
    entries: [{ keys: ["/[/"] }],
    messages: ["["],
    expected: [],
    stExpected: []
  },
  {
    id: "R13",
    title: "Unsupported d flag falls back literal",
    entries: [{ keys: ["/cat/d"] }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "R14",
    title: "Duplicate flags fall back literal",
    entries: [{ keys: ["/cat/ii"] }],
    messages: ["/cat/ii"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "R15",
    title: "Empty pattern not regex",
    entries: [{ keys: ["//"] }],
    messages: ["anything"],
    expected: [],
    stExpected: []
  },
  {
    id: "R16",
    title: "Unescaped inner slash not regex",
    entries: [{ keys: ["/a/b/"] }],
    messages: ["a/b"],
    expected: [],
    stExpected: []
  },
  {
    id: "R17",
    title: "Escaped inner slash is regex",
    entries: [{ keys: ["/a\\/b/"] }],
    messages: ["a/b"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "R18",
    title: "use_regex true has no effect",
    entries: [{ keys: ["c.t"], use_regex: true }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "R19",
    title: "use_regex false has no effect",
    entries: [{ keys: ["/c.t/"], use_regex: false }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "R20",
    title: "Regex anchor sees sentinel",
    entries: [{ keys: ["/^cat$/"] }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "R21",
    title: "Regex can match empty buffer",
    entries: [{ keys: ["/^$/"], scan_depth: 0 }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "W01",
    title: "Whole word rejects embedded ASCII",
    entries: [{ keys: ["cat"], match_whole_words: true }],
    messages: ["concatenate"],
    expected: [],
    stExpected: []
  },
  {
    id: "W02",
    title: "Whole word permits punctuation",
    entries: [{ keys: ["cat"], match_whole_words: true }],
    messages: ["(cat)!"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "W03",
    title: "Underscore counts as word char",
    entries: [{ keys: ["cat"], match_whole_words: true }],
    messages: ["_cat_"],
    expected: [],
    stExpected: []
  },
  {
    id: "W04",
    title: "Hyphen counts as nonword",
    entries: [{ keys: ["cat"], match_whole_words: true }],
    messages: ["a-cat-b"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "W05",
    title: "Multiword bypasses word boundaries",
    entries: [{ keys: ["red fox"], match_whole_words: true }],
    messages: ["tired foxes"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "W06",
    title: "Multiword does not normalize spaces",
    entries: [{ keys: ["red fox"], match_whole_words: true }],
    messages: ["red  fox"],
    expected: [],
    stExpected: []
  },
  {
    id: "W07",
    title: "Punctuation key needs surrounding boundaries",
    entries: [{ keys: ["C++"], match_whole_words: true }],
    messages: ["C++x"],
    expected: [],
    stExpected: []
  },
  {
    id: "W08",
    title: "Punctuation key matches at end",
    entries: [{ keys: ["C++"], match_whole_words: true }],
    messages: ["C++"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "W09",
    title: "Non ASCII neighbors are nonword",
    entries: [{ keys: ["cat"], match_whole_words: true }],
    messages: ["écaté"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "W10",
    title: "Non ASCII key inside non ASCII text",
    entries: [{ keys: ["東京"], match_whole_words: true }],
    messages: ["東京都"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "W11",
    title: "Non ASCII key next to ASCII word",
    entries: [{ keys: ["東京"], match_whole_words: true }],
    messages: ["a東京b"],
    expected: [],
    stExpected: []
  },
  {
    id: "W12",
    title: "Whole key is punctuation",
    entries: [{ keys: ["!"], match_whole_words: true }],
    messages: ["a!b"],
    expected: [],
    stExpected: []
  },
  {
    id: "W13",
    title: "Entry false overrides global whole words",
    entries: [{ keys: ["cat"], match_whole_words: false }],
    messages: ["concatenate"],
    expected: [0],
    stExpected: [0],
    settings: { wholeWords: true }
  },
  {
    id: "W14",
    title: "Null inherits global whole words",
    entries: [{ keys: ["cat"] }],
    messages: ["concatenate"],
    expected: [],
    stExpected: [],
    settings: { wholeWords: true }
  },
  {
    id: "S0none",
    title: "and_any: none secondary match",
    entries: [{ keys: ["cat"], secondary_keys: ["red", "blue"], selective_logic: "and_any" }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "S0one",
    title: "and_any: one secondary match",
    entries: [{ keys: ["cat"], secondary_keys: ["red", "blue"], selective_logic: "and_any" }],
    messages: ["cat red"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "S0all",
    title: "and_any: all secondary match",
    entries: [{ keys: ["cat"], secondary_keys: ["red", "blue"], selective_logic: "and_any" }],
    messages: ["cat red blue"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "S1none",
    title: "not_all: none secondary match",
    entries: [{ keys: ["cat"], secondary_keys: ["red", "blue"], selective_logic: "not_all" }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "S1one",
    title: "not_all: one secondary match",
    entries: [{ keys: ["cat"], secondary_keys: ["red", "blue"], selective_logic: "not_all" }],
    messages: ["cat red"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "S1all",
    title: "not_all: all secondary match",
    entries: [{ keys: ["cat"], secondary_keys: ["red", "blue"], selective_logic: "not_all" }],
    messages: ["cat red blue"],
    expected: [],
    stExpected: []
  },
  {
    id: "S2none",
    title: "not_any: none secondary match",
    entries: [{ keys: ["cat"], secondary_keys: ["red", "blue"], selective_logic: "not_any" }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "S2one",
    title: "not_any: one secondary match",
    entries: [{ keys: ["cat"], secondary_keys: ["red", "blue"], selective_logic: "not_any" }],
    messages: ["cat red"],
    expected: [],
    stExpected: []
  },
  {
    id: "S2all",
    title: "not_any: all secondary match",
    entries: [{ keys: ["cat"], secondary_keys: ["red", "blue"], selective_logic: "not_any" }],
    messages: ["cat red blue"],
    expected: [],
    stExpected: []
  },
  {
    id: "S3none",
    title: "and_all: none secondary match",
    entries: [{ keys: ["cat"], secondary_keys: ["red", "blue"], selective_logic: "and_all" }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "S3one",
    title: "and_all: one secondary match",
    entries: [{ keys: ["cat"], secondary_keys: ["red", "blue"], selective_logic: "and_all" }],
    messages: ["cat red"],
    expected: [],
    stExpected: []
  },
  {
    id: "S3all",
    title: "and_all: all secondary match",
    entries: [{ keys: ["cat"], secondary_keys: ["red", "blue"], selective_logic: "and_all" }],
    messages: ["cat red blue"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "S13",
    title: "Primary always required",
    entries: [{ keys: ["cat"], secondary_keys: ["red"], selective_logic: "and_all" }],
    messages: ["red"],
    expected: [],
    stExpected: []
  },
  {
    id: "S14",
    title: "selective false ignores secondary",
    entries: [{ keys: ["cat"], secondary_keys: ["red"], selective: false }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "S15",
    title: "Empty secondary ignores logic",
    entries: [{ keys: ["cat"], secondary_keys: [], selective_logic: "not_any" }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "S16",
    title: "Secondary regex flags",
    entries: [{ keys: ["cat"], secondary_keys: ["/RED/i"] }],
    messages: ["cat red"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "S17",
    title: "Empty secondary string counts nonmatch",
    entries: [{ keys: ["cat"], secondary_keys: [""], selective_logic: "not_all" }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "D01",
    title: "Depth one excludes previous message",
    entries: [{ keys: ["cat"] }],
    messages: ["dog", "cat"],
    expected: [],
    stExpected: [],
    settings: { scanDepth: 1 }
  },
  {
    id: "D02",
    title: "Depth two includes previous message",
    entries: [{ keys: ["cat"] }],
    messages: ["dog", "cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "D03",
    title: "Depth two excludes third message",
    entries: [{ keys: ["cat"] }],
    messages: ["dog", "bird", "cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "D04",
    title: "Entry depth overrides global smaller",
    entries: [{ keys: ["cat"], scan_depth: 3 }],
    messages: ["dog", "bird", "cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "D05",
    title: "Entry depth overrides global larger",
    entries: [{ keys: ["cat"], scan_depth: 1 }],
    messages: ["dog", "cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "D06",
    title: "Depth zero yields empty buffer",
    entries: [{ keys: ["cat"], scan_depth: 0 }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "D07",
    title: "Plain phrase cannot cross messages",
    entries: [{ keys: ["red fox"] }],
    messages: ["red", "fox"],
    expected: [],
    stExpected: []
  },
  {
    id: "D08",
    title: "Description opt in",
    entries: [{ keys: ["cat"], match_character_description: true }],
    messages: ["dog"],
    expected: [0],
    stExpected: [0],
    descriptions: { character_description: "cat" }
  },
  {
    id: "D09",
    title: "Description not implicitly scanned",
    entries: [{ keys: ["cat"] }],
    messages: ["dog"],
    expected: [],
    stExpected: [],
    descriptions: { character_description: "cat" }
  },
  {
    id: "D10",
    title: "Zero depth suppresses opted in description",
    entries: [{ keys: ["cat"], scan_depth: 0, match_character_description: true }],
    messages: ["dog"],
    expected: [],
    stExpected: [],
    descriptions: { character_description: "cat" }
  },
  {
    id: "D11",
    title: "matchPersonaDescription opt in",
    entries: [{ keys: ["cat"], match_persona_description: true }],
    messages: ["dog"],
    expected: [0],
    stExpected: [0],
    descriptions: { persona_description: "cat" }
  },
  {
    id: "D12",
    title: "matchCharacterPersonality opt in",
    entries: [{ keys: ["cat"], match_character_personality: true }],
    messages: ["dog"],
    expected: [0],
    stExpected: [0],
    descriptions: { character_personality: "cat" }
  },
  {
    id: "D13",
    title: "matchCharacterDepthPrompt opt in",
    entries: [{ keys: ["cat"], match_character_depth_prompt: true }],
    messages: ["dog"],
    expected: [0],
    stExpected: [0],
    descriptions: { character_depth_prompt: "cat" }
  },
  {
    id: "D14",
    title: "matchScenario opt in",
    entries: [{ keys: ["cat"], match_scenario: true }],
    messages: ["dog"],
    expected: [0],
    stExpected: [0],
    descriptions: { scenario: "cat" }
  },
  {
    id: "D15",
    title: "matchCreatorNotes opt in",
    entries: [{ keys: ["cat"], match_creator_notes: true }],
    messages: ["dog"],
    expected: [0],
    stExpected: [0],
    descriptions: { creator_notes: "cat" }
  },
  {
    id: "D16",
    title: "Scannable injected prompt",
    entries: [{ keys: ["cat"] }],
    messages: ["dog"],
    expected: [0],
    stExpected: [0],
    injections: [{ text: "cat", scan: true }]
  },
  {
    id: "D17",
    title: "Non scannable injected prompt",
    entries: [{ keys: ["cat"] }],
    messages: ["dog"],
    expected: [],
    stExpected: [],
    injections: [{ text: "cat", scan: false }]
  },
  {
    id: "D18",
    title: "Prepared name included",
    entries: [{ keys: ["Alice"] }],
    messages: ["Alice: hello"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "D19",
    title: "Prepared name omitted",
    entries: [{ keys: ["Alice"] }],
    messages: ["hello"],
    expected: [],
    stExpected: []
  },
  {
    id: "D20",
    title: "Buffer clamps beyond 1000",
    entries: [{ keys: ["cat"], scan_depth: 1001 }],
    messages: [...Array<string>(1000).fill("dog"), "cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "D21",
    title: "Min activation widens depth",
    entries: [{ keys: ["cat"] }],
    messages: ["dog", "cat"],
    expected: [],
    stExpected: [0],
    difference: "Minimum activation depth expansion is deferred.",
    settings: { scanDepth: 1 }
  },
  {
    id: "D22",
    title: "Min activation fixed entry depth never widens",
    entries: [{ keys: ["cat"], scan_depth: 1 }],
    messages: ["dog", "cat"],
    expected: [],
    stExpected: [],
    difference: "Minimum activation depth expansion is deferred.",
    settings: { scanDepth: 1 }
  },
  {
    id: "D23",
    title: "Min max uses > and admits max+1",
    entries: [{ keys: ["cat"] }],
    messages: ["dog", "bird", "cat"],
    expected: [],
    stExpected: [0],
    difference: "Minimum activation depth expansion is deferred.",
    settings: { scanDepth: 1 }
  },
  {
    id: "C01",
    title: "Constant needs no keys",
    entries: [{ constant: true }],
    messages: ["dog"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "C02",
    title: "Disabled wins over constant",
    entries: [{ constant: true, enabled: false }],
    messages: ["dog"],
    expected: [],
    stExpected: []
  },
  {
    id: "C03",
    title: "Constant ignores secondary",
    entries: [{ constant: true, secondary_keys: ["cat"] }],
    messages: ["dog"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "C04",
    title: "Empty content still in activation set",
    entries: [{ keys: ["cat"], content: "" }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "P01",
    title: "Probability 100",
    entries: [{ keys: ["cat"], probability: 100 }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0],
    random: 0.999
  },
  {
    id: "P02",
    title: "Probability zero positive RNG",
    entries: [{ keys: ["cat"], probability: 0 }],
    messages: ["cat"],
    expected: [],
    stExpected: [],
    random: 0.5
  },
  {
    id: "P03",
    title: "Probability zero exact zero RNG",
    entries: [{ keys: ["cat"], probability: 0 }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0],
    random: 0
  },
  {
    id: "P04",
    title: "useProbability false bypasses zero",
    entries: [{ keys: ["cat"], probability: 0, use_probability: false }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "P05",
    title: "Constant still subject to probability",
    entries: [{ constant: true, probability: 0 }],
    messages: ["dog"],
    expected: [],
    stExpected: [],
    random: 0.5
  },
  {
    id: "P06",
    title: "Probability comparison inclusive",
    entries: [{ keys: ["cat"], probability: 50 }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0],
    random: 0.5
  },
  {
    id: "Q01",
    title: "Recursion off",
    entries: [
      { keys: ["cat"], content: "dragon" },
      { keys: ["dragon"], content: "castle" },
      { keys: ["castle"], content: "end" }
    ],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "Q02",
    title: "Recursion on chain",
    entries: [
      { keys: ["cat"], content: "dragon" },
      { keys: ["dragon"], content: "castle" },
      { keys: ["castle"], content: "end" }
    ],
    messages: ["cat"],
    expected: [0, 1, 2],
    stExpected: [0, 1, 2],
    settings: { recursive: true }
  },
  {
    id: "Q03",
    title: "preventRecursion stops contribution",
    entries: [{ keys: ["cat"], content: "dragon", prevent_recursion: true }, { keys: ["dragon"] }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0],
    settings: { recursive: true }
  },
  {
    id: "Q04",
    title: "excludeRecursion stops recursive match",
    entries: [
      { keys: ["cat"], content: "dragon" },
      { keys: ["dragon"], exclude_recursion: true }
    ],
    messages: ["cat"],
    expected: [0],
    stExpected: [0],
    settings: { recursive: true }
  },
  {
    id: "Q05",
    title: "excludeRecursion still allows initial",
    entries: [{ keys: ["cat"], exclude_recursion: true }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0],
    settings: { recursive: true }
  },
  {
    id: "Q06",
    title: "Delayed entry activates on recursion",
    entries: [
      { keys: ["cat"], content: "dragon" },
      { keys: ["dragon"], delay_until_recursion: true }
    ],
    messages: ["cat"],
    expected: [0, 1],
    stExpected: [0, 1],
    settings: { recursive: true }
  },
  {
    id: "Q07",
    title: "Single delayed level alone does not force recursion",
    entries: [{ keys: ["cat"], delay_until_recursion: true }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "Q08",
    title: "Two delayed levels force recursion even if global off",
    entries: [
      { keys: ["cat"], delay_until_recursion: 1 },
      { keys: ["cat"], delay_until_recursion: 2 }
    ],
    messages: ["cat"],
    expected: [],
    stExpected: [0, 1],
    difference: "Delayed entries never force recursion when it is disabled."
  },
  {
    id: "Q09",
    title: "Max steps 1 includes initial only",
    entries: [
      { keys: ["cat"], content: "dragon" },
      { keys: ["dragon"], content: "castle" },
      { keys: ["castle"], content: "end" }
    ],
    messages: ["cat"],
    expected: [0],
    stExpected: [0],
    settings: { recursive: true, maxSteps: 1 }
  },
  {
    id: "Q10",
    title: "Max steps 2 includes one recursive pass",
    entries: [
      { keys: ["cat"], content: "dragon" },
      { keys: ["dragon"], content: "castle" },
      { keys: ["castle"], content: "end" }
    ],
    messages: ["cat"],
    expected: [0, 1],
    stExpected: [0, 1],
    settings: { recursive: true, maxSteps: 2 }
  },
  {
    id: "Q11",
    title: "Constant content can trigger recursive entry",
    entries: [{ constant: true, content: "dragon" }, { keys: ["dragon"] }],
    messages: ["dog"],
    expected: [0, 1],
    stExpected: [0, 1],
    settings: { recursive: true }
  },
  {
    id: "Q12",
    title: "Recursive cycles activate each entry once",
    entries: [
      { keys: ["cat"], content: "dragon" },
      { keys: ["dragon"], content: "cat" }
    ],
    messages: ["cat"],
    expected: [0, 1],
    stExpected: [0, 1],
    settings: { recursive: true }
  },
  {
    id: "T01",
    title: "Delay blocks before message count",
    entries: [{ keys: ["cat"], delay: 2 }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "T02",
    title: "Delay opens at message count",
    entries: [{ keys: ["cat"], delay: 2 }],
    messages: ["cat", "dog"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "T03",
    effects: { sticky: { "0": { start: 1, end: 4 } } },
    title: "Existing sticky bypasses missing key",
    entries: [{ keys: ["cat"], sticky: 3 }],
    messages: ["dog", "dog"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "T04",
    effects: { sticky: { "0": { start: 1, end: 2 } } },
    title: "Sticky expires at end",
    entries: [{ keys: ["cat"], sticky: 3 }],
    messages: ["dog", "dog"],
    expected: [],
    stExpected: []
  },
  {
    id: "T05",
    effects: { cooldown: { "0": { start: 1, end: 4 } } },
    title: "Existing cooldown blocks key",
    entries: [{ keys: ["cat"], cooldown: 3 }],
    messages: ["cat", "dog"],
    expected: [],
    stExpected: []
  },
  {
    id: "T06",
    effects: { cooldown: { "0": { start: 1, end: 2 } } },
    title: "Cooldown expires at end",
    entries: [{ keys: ["cat"], cooldown: 3 }],
    messages: ["cat", "dog"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "T07",
    effects: { sticky: { "0": { start: 1, end: 4 } } },
    title: "Same count unprotected sticky discarded",
    entries: [{ keys: ["cat"], sticky: 3 }],
    messages: ["dog"],
    expected: [],
    stExpected: []
  },
  {
    id: "T08",
    effects: { sticky: { "0": { start: 1, end: 4 } } },
    title: "Sticky bypasses probability zero",
    entries: [{ keys: ["cat"], sticky: 3, probability: 0 }],
    messages: ["dog", "dog"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "T09",
    effects: { sticky: { "0": { start: 1, end: 4 } } },
    title: "Disabled still blocks sticky",
    entries: [{ keys: ["cat"], sticky: 3, enabled: false }],
    messages: ["dog", "dog"],
    expected: [],
    stExpected: []
  },
  {
    id: "T10",
    effects: { sticky: { "0": { start: 1, end: 2 } } },
    title: "Sticky ending starts protected cooldown",
    entries: [{ keys: ["cat"], sticky: 1, cooldown: 3 }],
    messages: ["cat", "dog"],
    expected: [],
    stExpected: []
  },
  {
    id: "T11",
    dryRun: true,
    effects: { sticky: { "0": { start: 1, end: 4 } } },
    title: "Dry run ignores sticky",
    entries: [{ keys: ["cat"], sticky: 3 }],
    messages: ["dog", "dog"],
    expected: [],
    stExpected: []
  },
  {
    id: "G01",
    title: "Equal group weights first half",
    entries: [
      { keys: ["cat"], group: "g" },
      { keys: ["cat"], group: "g" }
    ],
    messages: ["cat"],
    expected: [0],
    stExpected: [0],
    difference: "Groups choose deterministically by scoring, override, order and input tie; weights/RNG are deferred.",
    random: 0.25
  },
  {
    id: "G02",
    title: "Equal group weights second half",
    entries: [
      { keys: ["cat"], group: "g" },
      { keys: ["cat"], group: "g" }
    ],
    messages: ["cat"],
    expected: [0],
    stExpected: [1],
    difference: "Groups choose deterministically by scoring, override, order and input tie; weights/RNG are deferred.",
    random: 0.75
  },
  {
    id: "G03",
    title: "Override takes priority",
    entries: [
      { keys: ["cat"], group: "g" },
      { keys: ["cat"], group: "g", group_override: true }
    ],
    messages: ["cat"],
    expected: [1],
    stExpected: [1]
  },
  {
    id: "G04",
    title: "Higher order wins override",
    entries: [
      { keys: ["cat"], group: "g", group_override: true, order: 10 },
      { keys: ["cat"], group: "g", group_override: true, order: 20 }
    ],
    messages: ["cat"],
    expected: [1],
    stExpected: [1]
  },
  {
    id: "G05",
    title: "Group score keeps highest",
    entries: [
      { keys: ["cat"], group: "g", use_group_scoring: true },
      { keys: ["cat", "dragon"], group: "g", use_group_scoring: true }
    ],
    messages: ["cat dragon"],
    expected: [1],
    stExpected: [1]
  },
  {
    id: "G06",
    title: "Group weights 1:3",
    entries: [
      { keys: ["cat"], group: "g", group_weight: 1 },
      { keys: ["cat"], group: "g", group_weight: 3 }
    ],
    messages: ["cat"],
    expected: [0],
    stExpected: [1],
    difference: "Groups choose deterministically by scoring, override, order and input tie; weights/RNG are deferred.",
    random: 0.5
  },
  {
    id: "G07",
    title: "All zero weights first wins at zero",
    entries: [
      { keys: ["cat"], group: "g", group_weight: 0 },
      { keys: ["cat"], group: "g", group_weight: 0 }
    ],
    messages: ["cat"],
    expected: [0],
    stExpected: [0],
    difference: "Groups choose deterministically by scoring, override, order and input tie; weights/RNG are deferred.",
    random: 0.75
  },
  {
    id: "G08",
    title: "Group selection before probability no fallback",
    entries: [
      { keys: ["cat"], group: "g", probability: 0 },
      { keys: ["cat"], group: "g" }
    ],
    messages: ["cat"],
    expected: [],
    stExpected: [],
    difference: "Groups choose deterministically by scoring, override, order and input tie; weights/RNG are deferred.",
    random: 0.25
  },
  {
    id: "G09",
    effects: { sticky: { "0": { start: 1, end: 4 } }, cooldown: { "0": { start: 1, end: 4 } } },
    title: "Sticky and cooldown same entry removed by group filter",
    entries: [
      { keys: ["cat"], group: "g", sticky: 3, cooldown: 3 },
      { keys: ["cat"], group: "g" }
    ],
    messages: ["cat", "dog"],
    expected: [],
    stExpected: []
  },
  {
    id: "F01",
    speaker: { entity: "alice", name: "alice" },
    title: "Name inclusion exact avatar stem",
    entries: [{ keys: ["cat"], character_filter: { is_exclude: false, names: ["alice"], tags: [] } }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "F02",
    speaker: { entity: "alice", name: "alice" },
    title: "Name inclusion case sensitive",
    entries: [{ keys: ["cat"], character_filter: { is_exclude: false, names: ["Alice"], tags: [] } }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "F03",
    speaker: { entity: "alice", name: "alice" },
    title: "Name exclusion",
    entries: [{ keys: ["cat"], character_filter: { is_exclude: true, names: ["alice"], tags: [] } }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "F04",
    speaker: { entity: "alice", name: "alice", tags: ["t1"] },
    title: "Tag inclusion intersection",
    entries: [{ keys: ["cat"], character_filter: { is_exclude: false, names: [], tags: ["t1"] } }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "F05",
    speaker: { entity: "alice", name: "alice", tags: [] },
    title: "Tag inclusion empty mapped array",
    entries: [{ keys: ["cat"], character_filter: { is_exclude: false, names: [], tags: ["t1"] } }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "F06",
    speaker: { entity: "alice", name: "alice" },
    title: "Tag inclusion no mapped array bypass",
    entries: [{ keys: ["cat"], character_filter: { is_exclude: false, names: [], tags: ["t1"] } }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "F07",
    title: "Generation trigger excludes constant",
    entries: [{ constant: true, triggers: ["swipe"] }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "F08",
    title: "Generation trigger matches",
    entries: [{ keys: ["cat"], triggers: ["swipe"] }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0],
    trigger: "swipe"
  },
  {
    id: "B01",
    title: "Below budget admits",
    entries: [{ keys: ["cat"], content: "abc" }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0],
    settings: { budget: 5 }
  },
  {
    id: "B02",
    title: "Exact budget rejects whole entry",
    entries: [{ keys: ["cat"], content: "abc" }],
    messages: ["cat"],
    expected: [],
    stExpected: [],
    settings: { budget: 4 }
  },
  {
    id: "B03",
    title: "Overflow blocks later small entries",
    entries: [
      { keys: ["cat"], content: "abcdef", order: 200 },
      { keys: ["cat"], content: "x", order: 100 }
    ],
    messages: ["cat"],
    expected: [],
    stExpected: [],
    settings: { budget: 5 }
  },
  {
    id: "B04",
    title: "Higher order admitted first",
    entries: [
      { keys: ["cat"], content: "aa", order: 100 },
      { keys: ["cat"], content: "aa", order: 200 }
    ],
    messages: ["cat"],
    expected: [1],
    stExpected: [1],
    settings: { budget: 5 }
  },
  {
    id: "B05",
    title: "Ignore budget survives overflow",
    entries: [
      { keys: ["cat"], content: "abcdef", order: 200 },
      { keys: ["cat"], content: "x", order: 100, ignore_budget: true }
    ],
    messages: ["cat"],
    expected: [1],
    stExpected: [1],
    settings: { budget: 5 }
  },
  {
    id: "B06",
    title: "Ignored content still charged later",
    entries: [
      { keys: ["cat"], content: "abcdef", order: 200, ignore_budget: true },
      { keys: ["cat"], content: "x", order: 100 }
    ],
    messages: ["cat"],
    expected: [0],
    stExpected: [0],
    settings: { budget: 5 }
  },
  {
    id: "B07",
    title: "Stable same order selection",
    entries: [
      { keys: ["cat"], content: "aa" },
      { keys: ["cat"], content: "aa" }
    ],
    messages: ["cat"],
    expected: [0],
    stExpected: [0],
    settings: { budget: 5 }
  },
  {
    id: "B08",
    title: "Zero percent budget becomes one",
    entries: [{ keys: ["cat"], content: "" }],
    messages: ["cat"],
    expected: [],
    stExpected: [],
    difference: "Caller supplies the absolute allowance (1 here); percentage resolution belongs to integration.",
    settings: { budget: 1 }
  },
  {
    id: "B09",
    title: "Prevent recursion content undercounts later budget",
    entries: [
      { keys: ["cat"], content: "aaa", prevent_recursion: true },
      { keys: ["cat"], content: "dragon", order: 90 },
      { keys: ["dragon"], content: "aaaa", order: 80 }
    ],
    messages: ["cat"],
    expected: [0, 1],
    stExpected: [0, 1, 2],
    difference: "All admitted content stays charged across passes, including prevent_recursion.",
    settings: { recursive: true, budget: 13 }
  },
  {
    id: "O01",
    title: "Emission reverses descending order",
    entries: [
      { keys: ["cat"], content: "high", order: 200 },
      { keys: ["cat"], content: "low", order: 100 }
    ],
    messages: ["cat"],
    expected: [0, 1],
    stExpected: [0, 1],
    difference: "Matcher returns descending order; ST before-character block reversal is outside this slice."
  },
  {
    id: "O02",
    title: "Chat tier precedes higher order global",
    entries: [
      { keys: ["cat"], content: "aa", order: 1 },
      { keys: ["cat"], content: "aa", order: 999 }
    ],
    messages: ["cat"],
    expected: [1],
    stExpected: [0],
    difference: "Source tiers are deferred; admission uses descending order across all input books.",
    settings: { budget: 5 }
  },
  {
    id: "X01",
    title: "Activate decorator with no keys",
    entries: [{ content: "@@activate\nhello" }],
    messages: ["dog"],
    expected: [],
    stExpected: [0],
    difference: "Content decorators are deferred and reported."
  },
  {
    id: "X02",
    title: "Dont activate decorator blocks constant",
    entries: [{ content: "@@dont_activate\nhello", constant: true }],
    messages: ["dog"],
    expected: [0],
    stExpected: [],
    difference: "Content decorators are deferred and reported."
  },
  {
    id: "X03",
    title: "Disabled blocks activate decorator",
    entries: [{ content: "@@activate\nhello", enabled: false }],
    messages: ["dog"],
    expected: [],
    stExpected: [],
    difference: "Content decorators are deferred and reported."
  },
  {
    id: "G10",
    title: "Scoring counts duplicate key slots",
    entries: [
      { keys: ["cat"], group: "g", use_group_scoring: true },
      { keys: ["cat", "cat"], group: "g", use_group_scoring: true }
    ],
    messages: ["cat"],
    expected: [1],
    stExpected: [1]
  },
  {
    id: "G11",
    title: "Per entry scoring false survives lower score",
    entries: [
      { keys: ["cat"], group: "g", use_group_scoring: false },
      { keys: ["cat", "dragon"], group: "g", use_group_scoring: true }
    ],
    messages: ["cat dragon"],
    expected: [0],
    stExpected: [0],
    difference: "Groups choose deterministically by scoring, override, order and input tie; weights/RNG are deferred.",
    random: 0.25
  },
  {
    id: "G12",
    title: "AND ANY score includes secondary even when selective false",
    entries: [
      { keys: ["cat"], group: "g", use_group_scoring: true },
      { keys: ["cat"], group: "g", use_group_scoring: true, selective: false, secondary_keys: ["dragon"] }
    ],
    messages: ["cat dragon"],
    expected: [1],
    stExpected: [1]
  },
  {
    id: "G13",
    title: "Global scoring default applies to null entry",
    entries: [
      { keys: ["cat"], group: "g" },
      { keys: ["cat", "dragon"], group: "g" }
    ],
    messages: ["cat dragon"],
    expected: [1],
    stExpected: [1],
    settings: { groupScoring: true }
  },
  {
    id: "D24",
    title: "MAX depth last accepted message",
    entries: [{ keys: ["cat"], scan_depth: 1000 }],
    messages: [...Array<string>(999).fill("dog"), "cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "K13",
    title: "Whitespace key with whole words",
    entries: [{ keys: ["   "], match_whole_words: true }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "W15",
    title: "Punctuation key separated by spaces",
    entries: [{ keys: ["!"], match_whole_words: true }],
    messages: ["a ! b"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "T12",
    effects: { sticky: { "0": { start: 1, end: 4 } }, cooldown: { "0": { start: 1, end: 4 } } },
    title: "Sticky plus cooldown outside group still active",
    entries: [{ keys: ["cat"], sticky: 3, cooldown: 3 }],
    messages: ["dog", "dog"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "F09",
    speaker: { entity: "alice", name: "alice", tags: [] },
    title: "Names and tags must both pass",
    entries: [{ keys: ["cat"], character_filter: { is_exclude: false, names: ["alice"], tags: ["t1"] } }],
    messages: ["cat"],
    expected: [],
    stExpected: []
  },
  {
    id: "R22",
    title: "Whitespace around regex is trimmed",
    entries: [{ keys: [" /CAT/i "] }],
    messages: ["cat"],
    expected: [0],
    stExpected: [0]
  },
  {
    id: "O03",
    title: "Equal order emission reverses stable ties",
    entries: [
      { keys: ["cat"], content: "first" },
      { keys: ["cat"], content: "second" }
    ],
    messages: ["cat"],
    expected: [0, 1],
    stExpected: [0, 1],
    difference: "Stable ties stay in input order; ST block emission is outside this slice."
  },
  {
    id: "G14",
    title: "Overlapping groups repeated removal drops unrelated entry",
    entries: [
      { keys: ["cat"], group: "a,b" },
      { keys: ["cat"], group: "a" },
      { keys: ["cat"], group: "b" },
      { keys: ["cat"] }
    ],
    messages: ["cat"],
    expected: [0, 1, 2, 3],
    stExpected: [1, 2],
    difference: "Overlapping groups are deferred: the full group string is one name; unrelated entries survive.",
    random: 0.75
  },
  {
    id: "G15",
    title: "Multigroup prior winner does not exclude later single groups",
    entries: [
      { keys: ["cat"], group: "a,b", content: "dragon" },
      { keys: ["dragon"], group: "a" },
      { keys: ["dragon"], group: "b" }
    ],
    messages: ["cat"],
    expected: [0, 1, 2],
    stExpected: [0, 1, 2],
    difference: "Overlapping groups are deferred: the full group string is one name; unrelated entries survive.",
    settings: { recursive: true }
  },
  {
    id: "G16",
    title: "Single group prior winner excludes later member",
    entries: [
      { keys: ["cat"], group: "g", content: "dragon" },
      { keys: ["dragon"], group: "g" }
    ],
    messages: ["cat"],
    expected: [0],
    stExpected: [0],
    settings: { recursive: true }
  },
  {
    id: "G17",
    title: "Group scoring runs before override",
    entries: [
      { keys: ["cat"], group: "g", group_override: true, use_group_scoring: true },
      { keys: ["cat", "dragon"], group: "g", use_group_scoring: true }
    ],
    messages: ["cat dragon"],
    expected: [1],
    stExpected: [1]
  },
  {
    id: "T13",
    title: "Delay still suppresses sticky",
    entries: [{ keys: ["cat"], sticky: 3, delay: 3 }],
    messages: ["dog", "dog"],
    effects: { sticky: { "0": { start: 1, end: 4 } } },
    expected: [],
    stExpected: []
  },
  {
    id: "T14",
    title: "Sticky bypasses delay until recursion",
    entries: [{ keys: ["cat"], sticky: 3, delay_until_recursion: 4, probability: 0 }],
    messages: ["dog", "dog"],
    effects: { sticky: { "0": { start: 1, end: 4 } } },
    expected: [0],
    stExpected: [0]
  },
  {
    id: "T15",
    title: "Sticky displaces a higher order group override",
    entries: [
      { keys: ["cat"], sticky: 3, group: "g" },
      { keys: ["dog"], group: "g", order: 200, group_override: true }
    ],
    messages: ["dog", "dog"],
    effects: { sticky: { "0": { start: 1, end: 4 } } },
    expected: [0],
    stExpected: [0]
  },
  {
    id: "T16",
    title: "Sticky content triggers recursive entries",
    entries: [{ keys: ["cat"], sticky: 3, content: "dragon" }, { keys: ["dragon"] }],
    messages: ["dog", "dog"],
    effects: { sticky: { "0": { start: 1, end: 4 } } },
    settings: { recursive: true },
    expected: [0, 1],
    stExpected: [0, 1]
  },
  {
    id: "F10",
    title: "Tag exclusion rejects intersection",
    entries: [{ keys: ["cat"], character_filter: { is_exclude: true, names: [], tags: ["t1"] } }],
    messages: ["cat"],
    speaker: { entity: "alice", name: "alice", tags: ["t1"] },
    expected: [],
    stExpected: []
  }
]
