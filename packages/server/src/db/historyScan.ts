// A VM deadline interrupts even a single catastrophic RegExp.exec. This module is used
// only by the reader worker; neither SQL nor regular expressions run on the main thread.
import { runInNewContext } from "node:vm"
import { HistoryRejected, type HistorySearch } from "@dreamspan/shared/historyApi.ts"
import { Effect } from "effect"

/** `timeout`: milliseconds the scan of `texts` may take before it's refused. */
export const scanHistory = (
  texts: ReadonlyArray<string>,
  search: Pick<HistorySearch, "pairs" | "matchCase" | "wholeWord" | "regex" | "preserveCase">,
  timeout = 150
) =>
  Effect.try({
    try: () =>
      runInNewContext(
        String.raw`
    const escape = text => text.split('').map(c => '\\^$.*+?()[]{}|'.includes(c) ? '\\' + c : c).join('');
    const expressions = search.pairs.map(pair => {
      if (!pair.find) throw new Error('Find cannot be empty.');
      const source = search.regex ? pair.find : escape(pair.find);
      const flags = search.matchCase ? 'g' : 'gi';
      try {
        return new RegExp(search.wholeWord ? '(?<![\\p{L}\\p{N}_])(?:' + source + ')(?![\\p{L}\\p{N}_])' : source, flags + 'u');
      } catch {
        // Match the editor's fallback for escapes only accepted outside Unicode mode.
        return new RegExp(search.wholeWord ? '(?<!\\w)(?:' + source + ')(?!\\w)' : source, flags);
      }
    });
    const results = texts.map(before => {

      let matches = [];
      search.pairs.forEach((pair, index) => {
        const expression = expressions[index];
        const input = before;
        let count = 0;
        input.replace(expression, (...args) => {
          if (++count > 2000) throw new Error('Too many matches in one text; narrow the search.');
          const groups = typeof args.at(-1) === 'object' ? args.pop() : undefined;
          const source = args.pop();
          const start = args.pop();
          const whole = args[0];
          let replacement = search.regex ? pair.replace.replace(/\$(\$|&|\u0060|'|<[^>]+>|\d{1,2})/g, (token, key) => {
            if (key === '$') return '$';
            if (key === '&') return whole;
            if (key === '\u0060') return source.slice(0, start);
            if (key === "'") return source.slice(start + whole.length);
            if (key.startsWith('<')) return groups ? (groups[key.slice(1, -1)] ?? '') : token;
            const n = Number(key);
            if (n > 0 && n < args.length) return args[n] ?? '';
            const first = Number(key[0]);
            return key.length === 2 && first > 0 && first < args.length ? (args[first] ?? '') + key[1] : token;
          }) : pair.replace;
          if (search.preserveCase && whole && whole.toLowerCase() !== whole.toUpperCase()) {
            if (whole === whole.toUpperCase()) replacement = replacement.toUpperCase();
            else if (whole === whole.toLowerCase()) replacement = replacement.toLowerCase();
            else if (whole[0] === whole[0].toUpperCase() && whole.slice(1) === whole.slice(1).toLowerCase()) replacement = replacement ? replacement[0].toUpperCase() + replacement.slice(1).toLowerCase() : '';
          }
          matches.push({ start, end: start + whole.length, replacement });
          return replacement;
        });
      });
      matches.sort((a,b) => a.start-b.start);
      const accepted = [];
      let end = -1;
      for (const match of matches) {
        if (match.start < end) continue;
        accepted.push(match);
        end = Math.max(match.end, match.start + 1);
      }
      let after = '', at = 0;
      for (const match of accepted) {
        after += before.slice(at, match.start) + match.replacement;
        at = match.end;
      }
      after += before.slice(at);
      return { after, matches: accepted };
    });
    results
  `,
        { texts, search },
        { timeout }
      ),
    catch: (error) => new HistoryRejected({ message: error instanceof Error ? error.message : String(error) })
  }) as Effect.Effect<
    Array<{ after: string; matches: Array<{ start: number; end: number; replacement: string }> }>,
    HistoryRejected
  >
