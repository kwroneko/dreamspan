// A chat branch as a SillyTavern chat file (JSONL), the reverse of stChat.ts: a header line,
// then one line per message with every swipe, which swipe is shown, each swipe's dates and
// recorded generation, its reasoning, and whether it's hidden from the context. Shapes from
// ST's public source (`public/global.d.ts`, `script.js`: `saveReply`, `syncMesToSwipe`).
// Pure: the reads are chatExport.ts's.
import type { PathEntry, Version } from "@rp/shared/chat.ts"
import { stReasoningExtra } from "./stChat.ts"

/** Who a message is from, as ST names it. */
export interface StSpeaker {
  readonly name: string
  readonly user: boolean
}

/** ST's humanized date ("2026-11-14@15h04m05s"), as it stamps chat files and headers. */
export const stStamp = (at: number) => {
  const date = new Date(at)
  const two = (n: number) => String(n).padStart(2, "0")
  return (
    `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}` +
    `@${two(date.getUTCHours())}h${two(date.getUTCMinutes())}m${two(date.getUTCSeconds())}s`
  )
}

/** A name a file can carry on any system: no path separators or reserved characters. */
export const fileStem = (name: string, fallback: string) => {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 150)
  return cleaned === "" ? fallback : cleaned
}

export const stHeader = (input: {
  readonly userName: string
  readonly characterName: string
  readonly createdAt: number
  /** The file this one branches from, without `.jsonl`; null for a chat's first. */
  readonly mainChat: string | null
}) =>
  JSON.stringify({
    user_name: input.userName,
    character_name: input.characterName,
    create_date: stStamp(input.createdAt),
    chat_metadata: input.mainChat === null ? {} : { main_chat: input.mainChat }
  })

/** What ST keeps in `extra` about a version's generation (stChat.ts `stGenerationOf`). */
const generationExtra = (version: Version) => {
  const ref = version.modelRef
  const [api, model] =
    ref !== undefined
      ? [ref.provider, ref.model]
      : version.model !== null && version.model.includes(" · ")
        ? [version.model.slice(0, version.model.indexOf(" · ")), version.model.slice(version.model.indexOf(" · ") + 3)]
        : [undefined, version.model ?? undefined]
  const recorded = version.recorded
  return {
    ...(api ? { api } : {}),
    ...(model ? { model } : {}),
    ...(recorded?.tokens !== undefined ? { token_count: recorded.tokens } : {}),
    ...(recorded?.firstTokenMs !== undefined ? { time_to_first_token: recorded.firstTokenMs } : {}),
    ...(recorded?.reasoningMs !== undefined ? { reasoning_duration: recorded.reasoningMs } : {})
  }
}

const iso = (at: number) => new Date(at).toISOString()

/** A version's dates: when it was sent, and when its generation started and finished. */
const dates = (version: Version) => {
  const recorded = version.recorded
  return {
    send_date: iso(version.createdAt),
    ...(recorded?.startedAt !== undefined && recorded.finishedAt !== undefined
      ? { gen_started: iso(recorded.startedAt), gen_finished: iso(recorded.finishedAt) }
      : {})
  }
}

/** Text with a greeting's names filled in, as ST stores a greeting once it's in a chat. */
const shownText = (text: string, version: Version, speaker: StSpeaker, userName: string) =>
  version.macroMode === "template"
    ? text.replace(/\{\{char\}\}/gi, speaker.name).replace(/\{\{user\}\}/gi, userName)
    : text

/** The versions ST can hold: written ones; a failed or unfinished generation has no text to give. */
const exportedVersions = (entry: PathEntry, versions: ReadonlyArray<Version>) => {
  const kept = versions.filter(
    (version) => version.id === entry.version.id || (version.status !== "failed" && version.status !== "generating")
  )
  return kept.some((version) => version.id === entry.version.id) ? kept : [entry.version]
}

/**
 * One message as an ST line: the shown version's text and generation on the message, every
 * version in `swipes` and `swipe_info`. `versions` are the message's as its fork shows them;
 * one version needs no swipe fields, as ST writes a message never swiped.
 */
export const stLine = (entry: PathEntry, versions: ReadonlyArray<Version>, speaker: StSpeaker, userName: string) => {
  const all = exportedVersions(entry, versions)
  const shown = all.findIndex((version) => version.id === entry.version.id)
  const of = (version: Version) => {
    const { mes, extra } = stReasoningExtra(version)
    return { mes: shownText(mes, version, speaker, userName), extra: { ...extra, ...generationExtra(version) } }
  }
  const selected = of(entry.version)
  return JSON.stringify({
    name: speaker.name,
    is_user: speaker.user,
    is_system: entry.contextExcluded,
    ...dates(entry.version),
    mes: selected.mes,
    extra: selected.extra,
    ...(all.length > 1
      ? {
          swipe_id: shown,
          swipes: all.map((version) => of(version).mes),
          swipe_info: all.map((version) => ({ ...dates(version), extra: of(version).extra }))
        }
      : {})
  })
}

/** The plain-text form: who said what, as the branch shows it. */
export const textLine = (entry: PathEntry, speaker: StSpeaker, userName: string) =>
  `${speaker.name}: ${shownText(entry.version.content, entry.version, speaker, userName)}`
