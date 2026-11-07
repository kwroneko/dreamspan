// The inline-HTML sanitizer schema (spec/HTML-MESSAGES.md §3.2): DOMPurify's default lists, as ST
// sanitizes messages with them (purifyLists.ts, generated), less what the five fixes take out.
// It is a hast-util-sanitize schema: rehype-raw parses, this sanitizes, React renders the tree.
import type { Options as Schema } from "rehype-sanitize"
import { ATTRIBUTES, FORBID_CONTENTS, TAG_NAMES } from "./purifyLists.ts"

/**
 * Elements DOMPurify keeps that the schema doesn't:
 * - `style` becomes the chat's constructed stylesheet (css.ts), never an element;
 * - `form` becomes a `div` before sanitizing (fix 2), so nothing can submit;
 * - `title` (React moves it into the page's head), `template` (inert content React can't
 *   render) and the document's own `html`, `head` and `body`.
 */
const LEFT_OUT = new Set(["style", "form", "title", "template", "html", "head", "body"])

/**
 * Attributes DOMPurify keeps that the schema doesn't: form submission (fix 2), `popover`
 * (it opens in the top layer, above the message's containment, fix 1), and `nonce`.
 */
const LEFT_OUT_ATTRIBUTES = new Set([
  "action",
  "method",
  "encType",
  "noValidate",
  "formAction",
  "formEncType",
  "formMethod",
  "formNoValidate",
  "formTarget",
  "popover",
  "popoverTarget",
  "popoverTargetAction",
  "nonce"
])

/** The elements that keep nothing when they're removed: DOMPurify's FORBID_CONTENTS, and `title`. */
const STRIPPED: ReadonlyArray<string> = [...new Set([...FORBID_CONTENTS, "title", "script"])]

/** Links may only be web and mail links (fix 4); images may also be `data:` (they make no request). */
const WEB = ["http", "https"]

/**
 * The schema. `marker` is the trusted attribute that tells Markdown's own elements from parsed
 * HTML (rehypeHtml.ts): it's allowed here so it survives to be removed afterwards.
 */
export function htmlSchema(marker: string): Schema {
  const attributes = ATTRIBUTES.filter((name) => !LEFT_OUT_ATTRIBUTES.has(name))
  return {
    tagNames: TAG_NAMES.filter((name) => !LEFT_OUT.has(name)),
    attributes: {
      "*": [...attributes, "data*", marker],
      // Streamdown's code blocks carry their fence's meta string.
      code: [...attributes, "data*", marker, "metastring"]
    },
    protocols: {
      href: [...WEB, "mailto"],
      xLinkHref: WEB,
      src: [...WEB, "data"],
      srcSet: [...WEB, "data"],
      cite: WEB,
      poster: WEB,
      background: WEB
    },
    // Ids and names get their prefix on parsed HTML only (rehypeHtml.ts), so Markdown's own
    // footnote links keep theirs.
    clobber: [],
    clobberPrefix: "",
    strip: [...STRIPPED],
    allowComments: false,
    allowDoctypes: false,
    ancestors: {},
    required: {}
  }
}
