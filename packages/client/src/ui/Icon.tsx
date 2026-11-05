// Line icons for compact controls. Each is decorative: the control carrying it gives the
// accessible name (and a tooltip), so the icon itself is hidden from assistive technology.

const paths = {
  lock: ["M5 11h14v10H5z", "M8 11V7a4 4 0 0 1 8 0v4"],
  home: ["M3 10 12 3l9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z", "M9 21v-8h6v8"],
  person: ["M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2", "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"],
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
  /** Two lines joining: taking a parent's changes into a fork, or another chat into this one. */
  merge: ["M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M6 21V9a9 9 0 0 0 9 9"],
  /** A small tree of boxes: a family of forks. */
  family: [
    "M17 16h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z",
    "M3 16h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z",
    "M10 2h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z",
    "M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3",
    "M12 12V8"
  ],
  /** A path forking off on its own: a branch made its own chat, apart from branch's tree. */
  split: ["M16 3h5v5", "M8 3H3v5", "M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3", "m15 9 6-6"],
  /** A window with a side column: the chat's side panel. */
  panel: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M15 3v18"],
  /** A window with a column on its left: the app's sidebar. */
  sidebar: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M9 3v18"],
  /** Splits a view along a vertical line: two side by side. */
  "split-right": ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M12 3v18"],
  /** Splits a view along a horizontal line: one above the other. */
  "split-down": ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M3 12h18"],
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
  /** Keeps this version (a floppy disk, the familiar save mark). */
  save: [
    "M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
    "M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7",
    "M7 3v4a1 1 0 0 0 1 1h7"
  ],
  /** Save with a note: the same disk, smaller, with a speech bubble at its corner. */
  "save-message": [
    "M10 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7.2a2 2 0 0 1 1.4.6l1.8 1.8a2 2 0 0 1 .6 1.4V10",
    "M5.5 2v2.5a1 1 0 0 0 1 1H11",
    "M5.5 15v-4a1 1 0 0 1 1-1H10",
    "M14 13h7a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5l-3 2.5V14a1 1 0 0 1 1-1z"
  ],
  /** Something went wrong: a circled exclamation mark. */
  alert: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 8v4", "M12 16h.01"],
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
  /** A single person (Lucide user): personas included. */
  user: ["M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2", "M8 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0"],
  /** A person with a cross (Lucide user-x): personas excluded by the filter. */
  "user-x": ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0", "m17 8 5 5", "m22 8-5 5"],
  people: [
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
    "M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
    "M22 21v-2a4 4 0 0 0-3-3.87",
    "M16 3.13a4 4 0 0 1 0 7.75"
  ],
  sliders: ["M20 7h-9", "M14 17H5", "M14 17a3 3 0 1 0 6 0a3 3 0 1 0-6 0", "M4 7a3 3 0 1 0 6 0a3 3 0 1 0-6 0"],
  search: ["M21 21l-4.34-4.34", "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z"],
  /** An agent reply's tool use: a wrench. */
  tool: [
    "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
  ],
  /** Model work in the background: a pulse line. */
  activity: [
    "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"
  ],
  /** Search and replace: a word, an arrow, its replacement. */
  replace: [
    "M14 4a1 1 0 0 1 1-1",
    "M15 10a1 1 0 0 1-1-1",
    "M21 4a1 1 0 0 0-1-1",
    "M21 9a1 1 0 0 1-1 1",
    "m3 7 3 3 3-3",
    "M6 10V5a2 2 0 0 1 2-2h2",
    "M4 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z"
  ],
  /** Open every item of a list. */
  expandAll: ["m7 15 5 5 5-5", "m7 9 5-5 5 5"],
  /** Close every item of a list. */
  collapseAll: ["m7 20 5-5 5 5", "m7 4 5 5 5-5"],
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
  /** The snippet brackets around a text cursor: the selection to a snippet. */
  snippetSelection: ["m17 16 5-4-5-4", "m7 8-5 4 5 4", "M10 8h4", "M10 16h4", "M12 8v8"],
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
  info: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18", "M12 11v5", "M12 7.75h.01"],
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
  ],
  crop: ["M6 2v14a2 2 0 0 0 2 2h14", "M18 22V8a2 2 0 0 0-2-2H2"],
  /** One portrait's frame: only one image open at a time (the portrait column's toggle). */
  "one-image": ["M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", "M12 8v8", "m10 10 2-2"],
  /** A picture: the portrait's Picture button. */
  image: [
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
    "M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
    "m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"
  ],
  camera: [
    "M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z",
    "M12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"
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
