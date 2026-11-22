// The text-durability guard (textDurability.spec.ts): every place in the client where the
// user types free text, as a Place the spec drives through three reloads. A place is set up
// over RPC, opened as a user opens it, typed into, and reloaded:
//   - "typed just before a reload": the reload comes 150 ms after the last key, inside every
//     save debounce (400–600 ms), as an F5 right after typing would;
//   - "typed and saved": the reload comes once no browser copy holds the text any more (the
//     server acknowledged it), or after 2 s where the place keeps no copies at all;
//   - "reopens where it was": after the save, the reload alone must show the editor again,
//     in the same mode or dialog, with the text in it; nothing is clicked.
// The first two may open the place again after the reload (`open`), since the text is what
// they check. A place with a known gap names it in `gaps`, and that test is marked
// test.fail(): the suite stays green and the test flips to failing, as a reminder to drop
// the mark, once the gap is fixed.
import type { Locator, Page } from "@playwright/test"
import type { Effect } from "effect"
import type { Client } from "./rpc.ts"
import type { TestServer } from "./server.ts"

export interface PlaceContext {
  readonly server: TestServer
  readonly rpc: <A>(use: (client: Client) => Effect.Effect<A, unknown>) => Promise<A>
  /** A word unique to this test, for titles and names of its fixtures. */
  readonly tag: string
}

export interface Place<S = unknown> {
  /** Shown in the test names: what the user calls it. */
  readonly name: string
  /** Where it is in the client source, for the audit (file:line). */
  readonly source: string
  /** Fixtures over RPC; runs once per test. */
  readonly setup: (context: PlaceContext) => Promise<S>
  /** Navigates and opens the editor as a user does, and resolves to its text box. Runs again after a reload when the editor isn't back. */
  readonly open: (page: Page, state: S, context: PlaceContext) => Promise<Locator>
  /** The text box as the page shows it after a reload, when the mode came back by itself. */
  readonly shown: (page: Page, state: S) => Locator
  /** What shows the mode is back, beside the box, when the box alone doesn't (a bar over the composer). */
  readonly mode?: (page: Page, state: S) => Locator
  /**
   * Known gaps, each a test.fail() with this reason: `text`, the text itself is lost on a
   * reload (both reload tests fail); `mode`, the text survives, but the editor, dialog or mode
   * it was typed in doesn't open again by itself.
   */
  readonly gaps?: { readonly text?: string; readonly mode?: string }
  /** Types the marker; the default clicks into the box, goes to its end and inserts it. */
  readonly type?: (box: Locator, marker: string) => Promise<void>
  /** Wide screens only, or a viewport of its own. */
  readonly viewport?: { readonly width: number; readonly height: number }
}

/** Keeps a place's state type while listing places of different states together. */
export const place = <S>(definition: Place<S>): Place => definition as Place

/** A name renamed in place (ui/InlineRename.tsx): its field, opened with its pencil unless a reload kept it open. */
export const renameField = (scope: Locator | Page, field: string | RegExp) =>
  scope
    .locator("[data-renaming]")
    .getByRole("textbox", typeof field === "string" ? { name: field, exact: true } : { name: field })

export const openRename = async (scope: Locator | Page, pencil: string | RegExp, field: string | RegExp) => {
  const box = renameField(scope, field)
  const button = scope.getByRole(
    "button",
    typeof pencil === "string" ? { name: pencil, exact: true } : { name: pencil }
  )
  await button.or(box).first().waitFor({ timeout: 30_000 })
  if (!(await box.isVisible())) await button.first().click()
  return box
}
