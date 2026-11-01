// Line icons for compact controls. Each is decorative: the control carrying it gives the
// accessible name (and a tooltip), so the icon itself is hidden from assistive technology.

const paths = {
  edit: [
    "M21.17 6.81a2.82 2.82 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z",
    "m15 5 4 4"
  ],
  /** Writes something new: a pen over an empty page, apart from edit's lone pencil. */
  write: [
    "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
    "M18.38 2.62a1 1 0 0 1 3 3l-9.01 9.02a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z"
  ],
  regenerate: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
  /** Deletes the whole of something, every version of a message: the bin with its contents. */
  "trash-all": [
    "M3 6h18",
    "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
    "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
    "M10 11v6",
    "M14 11v6"
  ],
  copy: [
    "M8 10a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2z",
    "M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"
  ],
  /** Copies a text to the clipboard, apart from duplicate's overlapping pages. */
  clipboard: [
    "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2",
    "M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"
  ],
  link: [
    "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
    "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
  ],
  external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  branch: [
    "M6 3v12",
    "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M18 9a9 9 0 0 1-9 9"
  ],
  /** A window with a side column: the chat's side panel. */
  panel: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M15 3v18"],
  /** A window with a column on its left: the app's sidebar. */
  sidebar: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M9 3v18"],
  plus: ["M12 5v14", "M5 12h14"],
  download: ["M12 15V3", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5"],
  keyboard: [
    "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
    "M6 9h.01",
    "M10 9h.01",
    "M14 9h.01",
    "M18 9h.01",
    "M7 15h10"
  ],
  layers: [
    "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z",
    "m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65",
    "m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"
  ],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  /** A line with a plus: a message put in between others. */
  insert: ["M4 6h16", "M4 18h16", "M12 9v6", "M9 12h6"],
  /** A new message before this one: a plus over the line. */
  "insert-above": ["M4 19h16", "M12 4v10", "M7 9h10"],
  /** A new message after this one: a plus under the line. */
  "insert-below": ["M4 5h16", "M12 10v10", "M7 15h10"],
  /** The text as it was before scripts changed it: a page with an arrow back. */
  original: ["M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z", "M14 3v6h6", "m10 12-3 3 3 3", "M7 15h9"],
  duplicate: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  left: ["m15 18-6-6 6-6"],
  right: ["m9 18 6-6-6-6"],
  down: ["m6 9 6 6 6-6"],
  // A pinned chat (filled when pinned); the star is a favourite character's.
  pin: [
    "M12 17v5",
    "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
  ],
  // A sort's direction: the arrow points the way the list runs, the bars from long to short.
  sortDown: ["m3 16 4 4 4-4", "M7 20V4", "M11 4h10", "M11 8h7", "M11 12h4"],
  sortUp: ["m3 8 4-4 4 4", "M7 4v16", "M11 12h4", "M11 16h7", "M11 20h10"],
  back: ["m12 19-7-7 7-7", "M19 12H5"],
  undo: ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"],
  check: ["M20 6 9 17l-5-5"],
  close: ["M18 6 6 18", "m6 6 12 12"],
  stop: ["M7 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"],
  ghost: ["M9 10h.01", "M15 10h.01", "M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"],
  eye: [
    "M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0",
    "M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6z"
  ],
  eyeOff: [
    "M10.73 5.08A10.43 10.43 0 0 1 12 5c4.82 0 8.75 3.2 9.94 6.65a1 1 0 0 1 0 .7 10.8 10.8 0 0 1-1.44 2.49",
    "M14.08 14.16a3 3 0 0 1-4.24-4.24",
    "M17.48 17.5A10.75 10.75 0 0 1 2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14",
    "m2 2 20 20"
  ],
  paperclip: ["m16 6-8.41 8.59a2 2 0 0 0 2.83 2.83l8.49-8.48a4 4 0 0 0-5.66-5.66l-8.49 8.49a6 6 0 0 0 8.49 8.49L21 12"],
  dropped: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "m4.9 4.9 14.2 14.2"],
  summary: ["M3 6h18", "M3 12h18", "M3 18h11"],
  continue: ["m6 17 5-5-5-5", "m13 17 5-5-5-5"],
  reasoning: [
    "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5",
    "M9 18h6",
    "M10 22h4"
  ],
  people: [
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
    "M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
    "M22 21v-2a4 4 0 0 0-3-3.87",
    "M16 3.13a4 4 0 0 1 0 7.75"
  ],
  sliders: ["M20 7h-9", "M14 17H5", "M14 17a3 3 0 1 0 6 0a3 3 0 1 0-6 0", "M4 7a3 3 0 1 0 6 0a3 3 0 1 0-6 0"],
  search: ["M21 21l-4.34-4.34", "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z"],
  book: ["M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z", "M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"],
  star: [
    "M11.52 2.3a.53.53 0 0 1 .95 0l2.31 4.68a2.12 2.12 0 0 0 1.6 1.16l5.16.76a.53.53 0 0 1 .3.9l-3.74 3.64a2.12 2.12 0 0 0-.61 1.88l.88 5.14a.53.53 0 0 1-.77.56l-4.62-2.43a2.12 2.12 0 0 0-1.97 0L6.4 21.01a.53.53 0 0 1-.77-.56l.88-5.14a2.12 2.12 0 0 0-.61-1.88L2.16 9.8a.53.53 0 0 1 .29-.9l5.17-.76a2.12 2.12 0 0 0 1.6-1.16z"
  ],
  compare: ["M12 3v18", "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"],
  note: ["M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3z", "M15 3v6h6"],
  chat: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  model: [
    "M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    "M9 9h6v6H9z",
    "M9 1v3",
    "M15 1v3",
    "M9 20v3",
    "M15 20v3",
    "M20 9h3",
    "M20 14h3",
    "M1 9h3",
    "M1 14h3"
  ],
  preset: [
    "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z",
    "M14 2v5h6",
    "M16 13H8",
    "M16 17H8",
    "M10 9H8"
  ],
  history: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 6v6l4 2"],
  // A box with its lid: put away (archive), and taken back out (unarchive).
  archive: [
    "M3 3h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
    "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8",
    "M10 12h4"
  ],
  unarchive: [
    "M3 3h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
    "M4 8v11a2 2 0 0 0 2 2h2",
    "M20 8v11a2 2 0 0 1-2 2h-2",
    "m9 15 3-3 3 3",
    "M12 12v9"
  ],
  type: ["M4 7V4h16v3", "M9 20h6", "M12 4v16"],
  snippet: ["m16 18 6-6-6-6", "m8 6-6 6 6 6"],
  /** Opens something large: a field over the page. */
  expand: ["M15 3h6v6", "M9 21H3v-6", "m21 3-7 7", "m3 21 7-7"],
  guidance: [
    "M12 13v8",
    "M12 3v3",
    "M18 6a2 2 0 0 1 1.39.56l2.3 2.22a1 1 0 0 1 0 1.44l-2.3 2.22A2 2 0 0 1 18 13H6a2 2 0 0 1-1.39-.56l-2.3-2.22a1 1 0 0 1 0-1.44l2.3-2.22A2 2 0 0 1 6 6z"
  ],
  /**
   * A question mark drawn centred in its box, ink and round caps included (top 4.75, bottom
   * 19.25, x 8–16), so a round chip shows it in the middle, which a text "?" sitting on the
   * font's baseline isn't.
   */
  help: ["M9 8.75a3 3 0 1 1 5.2 2.05C13.3 11.75 12 12.25 12 14.25", "M12 18.25h.01"],
  /** Speak now: the model writes this character's turn. */
  play: ["M6 4v16a1 1 0 0 0 1.5.87l13-8a1 1 0 0 0 0-1.74l-13-8A1 1 0 0 0 6 4z"],
  volume: [
    "M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6a1.4 1.4 0 0 1-1 .4H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z",
    "M16 9a5 5 0 0 1 0 6",
    "M19.4 18.4a9 9 0 0 0 0-12.8"
  ],
  muted: [
    "M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6a1.4 1.4 0 0 1-1 .4H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z",
    "m22 9-6 6",
    "m16 9 6 6"
  ]
} as const

export type IconName = keyof typeof paths

export function Icon({
  name,
  size = 16,
  className = "",
  filled = false
}: {
  name: IconName
  size?: number
  className?: string
  /** Filled in, for an icon that shows a state that's on (a star). */
  filled?: boolean
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={name === "stop" || name === "play" || filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={name === "more" ? 3 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      {paths[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
