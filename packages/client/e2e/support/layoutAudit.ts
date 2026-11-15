// Geometry, not class-name snapshots. Runs in the browser, including open shadow roots.
// Intentional exceptions: data-layout-audit-ignore="rule: reason" (semicolon separated),
// scoped to that element and its descendants. Prefer CSS ellipsis/clamp over an exception.
// data-layout-overlay="reason" permits overlap with content outside that overlay only;
// its contents still receive every check. Keep reasons beside the component that owns them.
import { expect, type Page, type TestInfo } from "@playwright/test"

interface Box {
  x: number
  y: number
  width: number
  height: number
}
interface Violation {
  kind: "inset" | "text" | "gap" | "alignment" | "overlap" | "overlay" | "exception"
  selector: string
  related?: string
  name: string
  measurement: string
  box: Box
  crop?: string
}

/** The smallest surrounding content inset (0.5rem, shared rowSpacing.ts). */
export async function layoutAudit(page: Page, options: { inset?: number; scope?: string } = {}): Promise<Violation[]> {
  return page.evaluate(
    ({ inset, scope }) => {
      const tolerance = 1
      const controls =
        "button, input:not([type=hidden]), textarea, select, a[href], [role=button], [role=switch], [role=checkbox], [role=radio], [role=combobox], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=tab], [contenteditable=true]"
      const nodes: HTMLElement[] = []
      const walk = (root: Document | ShadowRoot) => {
        for (const el of root.querySelectorAll<HTMLElement>("*")) {
          nodes.push(el)
          if (el.shadowRoot) walk(el.shadowRoot)
        }
      }
      walk(document)
      const parent = (el: Element): HTMLElement | null =>
        el.parentElement ??
        (el.getRootNode() instanceof ShadowRoot ? ((el.getRootNode() as ShadowRoot).host as HTMLElement) : null)
      const ancestors = function* (el: Element | null): Generator<HTMLElement> {
        for (let p = el as HTMLElement | null; p; p = parent(p)) yield p
      }
      const styles = new Map(nodes.map((el) => [el, getComputedStyle(el)]))
      const css = (el: HTMLElement) => styles.get(el) ?? getComputedStyle(el)
      const rects = new Map(nodes.map((el) => [el, el.getBoundingClientRect()]))
      const rect = (el: HTMLElement) => rects.get(el) ?? el.getBoundingClientRect()
      const num = (s: string) => parseFloat(s) || 0
      const inner = (el: HTMLElement) => {
        const r = rect(el)
        return {
          left: r.left + el.clientLeft,
          top: r.top + el.clientTop,
          right: r.left + el.clientLeft + el.clientWidth,
          bottom: r.top + el.clientTop + el.clientHeight
        }
      }
      const visible = (el: HTMLElement, painted = true) => {
        const r = rect(el),
          s = css(el)
        if (!el.checkVisibility({ checkOpacity: painted, checkVisibilityCSS: painted, contentVisibilityAuto: true }))
          return false
        if (
          !r.width ||
          !r.height ||
          s.display === "none" ||
          (painted && (s.visibility !== "visible" || num(s.opacity) === 0))
        )
          return false
        if (s.clip === "rect(0px, 0px, 0px, 0px)" || s.clipPath === "inset(50%)") return false
        // Offscreen virtual rows, screen-reader labels and hidden/preserved tab bodies.
        if (
          r.right <= 0 ||
          r.left >= innerWidth ||
          r.bottom <= 0 ||
          r.top >= innerHeight ||
          (r.width <= 1 && r.height <= 1)
        )
          return false
        for (const p of ancestors(parent(el))) {
          const ps = css(p)
          if (ps.display === "none" || (painted && (ps.visibility === "hidden" || num(ps.opacity) === 0))) return false
          const b = inner(p)
          if (/(auto|scroll|hidden|clip)/.test(ps.overflowY) && (r.bottom <= b.top || r.top >= b.bottom)) return false
          if (/(auto|scroll|hidden|clip)/.test(ps.overflowX) && (r.right <= b.left || r.left >= b.right)) return false
        }
        return true
      }
      // Compare painted fragments, clipped by every ancestor scrollport. A wrapped
      // inline's bounding rectangle includes empty space between its lines.
      const fragmentCache = new Map<HTMLElement, Array<{ left: number; right: number; top: number; bottom: number }>>()
      const fragments = (el: HTMLElement) => {
        const cached = fragmentCache.get(el)
        if (cached) return cached
        const result = [...el.getClientRects()].map((r) => {
          let left = Math.max(0, r.left),
            right = Math.min(innerWidth, r.right),
            top = Math.max(0, r.top),
            bottom = Math.min(innerHeight, r.bottom)
          for (const p of ancestors(parent(el))) {
            const s = css(p),
              b = inner(p)
            if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) {
              left = Math.max(left, b.left)
              right = Math.min(right, b.right)
            }
            if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) {
              top = Math.max(top, b.top)
              bottom = Math.min(bottom, b.bottom)
            }
          }
          return { left, right, top, bottom }
        })
        fragmentCache.set(el, result)
        return result
      }
      const intersection = (a: HTMLElement, b: HTMLElement) => {
        for (const ar of fragments(a))
          for (const br of fragments(b)) {
            const w = Math.min(ar.right, br.right) - Math.max(ar.left, br.left),
              h = Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top)
            if (w > tolerance && h > tolerance) return `${w.toFixed(2)} × ${h.toFixed(2)}px`
          }
        return null
      }
      const path = (el: HTMLElement): string => {
        if (el.id) return `#${CSS.escape(el.id)}`
        const p = parent(el)
        if (!p) return el.localName
        const same = [...(el.parentElement ?? (el.getRootNode() as ShadowRoot)).children].filter(
          (n) => n.localName === el.localName
        )
        return `${path(p)}${el.parentElement ? " > " : " >>> "}${el.localName}${same.length > 1 ? `:nth-of-type(${same.indexOf(el) + 1})` : ""}`
      }
      const ignored = (el: HTMLElement, kind: string) =>
        [...ancestors(el)].some((p) =>
          (p.dataset.layoutAuditIgnore ?? "")
            .split(";")
            .some(
              (entry) => entry.trim().startsWith(`${kind}:`) && entry.split(":").slice(1).join(":").trim().length > 0
            )
        )
      const overlayCache = new Map<HTMLElement, HTMLElement | null>()
      const overlay = (el: HTMLElement) => {
        if (!overlayCache.has(el)) overlayCache.set(el, [...ancestors(el)].find((p) => p.dataset.layoutOverlay) ?? null)
        return overlayCache.get(el)
      }
      const results: Violation[] = []
      const seen = new Set<string>()
      const add = (kind: Violation["kind"], el: HTMLElement, measurement: string, related?: HTMLElement) => {
        if (scope && ![...ancestors(el)].some((node) => node.matches(scope))) return
        if (ignored(el, kind) || (related && ignored(related, kind))) return
        const selector = path(el),
          key = `${kind}:${selector}:${related ? path(related) : ""}`
        if (seen.has(key)) return
        seen.add(key)
        const r = rect(el),
          b = related ? rect(related) : r
        const left = Math.max(0, Math.min(r.left, b.left) - 12),
          top = Math.max(0, Math.min(r.top, b.top) - 12)
        results.push({
          kind,
          selector,
          name: (
            el.getAttribute("aria-label") ??
            el
              .getAttribute("aria-labelledby")
              ?.split(/\s+/)
              .map((id) => (el.getRootNode() as Document | ShadowRoot).getElementById(id)?.textContent ?? "")
              .join(" ") ??
            (el.matches(controls) ? el.closest("label")?.textContent : null) ??
            el.textContent ??
            ""
          )
            .trim()
            .slice(0, 100),
          ...(related ? { related: path(related) } : {}),
          measurement,
          box: {
            x: left,
            y: top,
            width: Math.max(1, Math.min(innerWidth, Math.max(r.right, b.right) + 12) - left),
            height: Math.max(1, Math.min(innerHeight, Math.max(r.bottom, b.bottom) + 12) - top)
          }
        })
      }
      const shown = nodes.filter((el) => visible(el) && (!(el instanceof SVGElement) || el.localName === "svg"))
      // display:contents contributes its children to the parent's flex/grid row.
      const boxChildren = (el: HTMLElement): HTMLElement[] =>
        [...el.children].flatMap((child) => {
          const node = child as HTMLElement
          return css(node).display === "contents" ? boxChildren(node) : [node]
        })
      for (const el of shown) {
        if (el.hasAttribute("data-layout-audit-ignore")) {
          for (const entry of el.dataset.layoutAuditIgnore!.split(";"))
            if (!/^(inset|text|gap|alignment|overlap|overlay):\s*\S.+/.test(entry.trim()))
              add("exception", el, `Invalid exception (rule and reason required): ${entry}`)
        }
        // An icon's paths are drawing primitives, not independent layout boxes.
        if (el instanceof SVGElement) continue
        if (el.matches(controls)) {
          const pending = new Set([0, 1, 2, 3])
          const r = rect(el)
          for (const p of ancestors(parent(el))) {
            const s = css(p),
              b = inner(p)
            // A single border is a divider, not a surrounding box.
            const bordered =
              (num(s.borderLeftWidth) > 0 && num(s.borderRightWidth) > 0) ||
              (num(s.borderTopWidth) > 0 && num(s.borderBottomWidth) > 0)
            const padded = [s.paddingLeft, s.paddingRight, s.paddingTop, s.paddingBottom].some((v) => num(v) > 0)
            const scroll = /(auto|scroll)/.test(`${s.overflowX} ${s.overflowY}`)
            if (!bordered && !padded && !scroll) continue
            // An interactive ancestor's contents aren't separate edge controls.
            if (p.matches(controls)) break
            const insets = [r.left - b.left, b.right - r.right, r.top - b.top, b.bottom - r.bottom]
            const effective = insets
            // A scroll boundary cutting through a scrolled item is expected. Its cross
            // axis and actual scrollbar, however, always need clearance.
            // Only measure an edge this wrapper actually establishes. Helpers with
            // just pt-2 or pr-2 have no box boundary on their other three sides.
            const padding = [s.paddingLeft, s.paddingRight, s.paddingTop, s.paddingBottom]
            const borders = [s.borderLeftWidth, s.borderRightWidth, s.borderTopWidth, s.borderBottomWidth]
            const axes = [...pending].filter(
              (i) =>
                (num(padding[i]!) > 0 || (bordered && num(borders[i]!) > 0) || scroll) &&
                !(
                  scroll &&
                  (i < 2
                    ? p.scrollWidth > p.clientWidth && s.overflowX !== "hidden"
                    : p.scrollHeight > p.clientHeight && s.overflowY !== "hidden")
                )
            )
            for (const axis of axes) pending.delete(axis)
            if (scroll && p.scrollHeight > p.clientHeight) {
              pending.delete(2)
              pending.delete(3)
            }
            if (scroll && p.scrollWidth > p.clientWidth) {
              pending.delete(0)
              pending.delete(1)
            }
            // Compact markers follow the list's 4 px vertical spacing. Keep their
            // horizontal inset and every Comfortable control under the normal check.
            const minimum = (axis: number) =>
              axis >= 2 && p.matches("[data-state-markers]") && p.closest('[data-chat-density="compact"]')
                ? Math.min(inset, 4)
                : inset
            const bad = axes.filter((i) => effective[i]! < minimum(i) - tolerance)
            if (bad.length)
              add(
                "inset",
                el,
                `${bad.map((i) => `${["left", "right", "top", "bottom"][i]} ${effective[i]!.toFixed(2)}px`).join(", ")}; minimum ${bad.map(minimum).join("/")}px`,
                p
              )
            // Check the first bounded ancestor AND all scrollports (a nested padded
            // wrapper can itself overflow into a scrollbar).
            if (!scroll) {
              for (const scroller of ancestors(parent(p))) {
                const sc = css(scroller)
                if (!/(auto|scroll)/.test(sc.overflowY) || scroller.scrollHeight <= scroller.clientHeight) continue
                const edge = inner(scroller)
                if (r.right > edge.right + tolerance || r.left < edge.left - tolerance)
                  add(
                    "inset",
                    el,
                    `control crosses scrollport by ${Math.max(r.right - edge.right, edge.left - r.left).toFixed(2)}px`,
                    scroller
                  )
              }
            }
            if (!pending.size) break
          }
        }
        // Native fields intentionally scroll their entered value. Ellipsis and clamp are
        // explicit design intent; generic overflow:hidden alone must NOT suppress a finding.
        if (
          !el.matches("input, textarea, select") &&
          [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())
        ) {
          const intended = [...ancestors(el)].some(
            (p) => css(p).textOverflow === "ellipsis" || num(css(p).webkitLineClamp) > 0
          )
          if (!intended) {
            if (
              el.clientHeight &&
              el.scrollHeight > el.clientHeight + tolerance &&
              /hidden|clip/.test(css(el).overflowY)
            )
              add(
                "text",
                el,
                `scrollHeight ${el.scrollHeight}px > clientHeight ${el.clientHeight}px without a line clamp`
              )
            if (
              el.clientWidth &&
              el.scrollWidth > el.clientWidth + tolerance &&
              !/(auto|scroll)/.test(css(el).overflowX)
            )
              add("text", el, `scrollWidth ${el.scrollWidth}px > clientWidth ${el.clientWidth}px`)
            const range = document.createRange()
            for (const node of el.childNodes) {
              if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue
              const content = node.textContent!
              range.setStart(node, content.length - content.trimStart().length)
              range.setEnd(node, content.trimEnd().length)
              let ink: DOMRect[] | undefined
              for (const line of range.getClientRects()) {
                for (const p of ancestors(el)) {
                  const s = css(p)
                  if (/(auto|scroll)/.test(s.overflowY)) break
                  if (!/(hidden|clip)/.test(s.overflowY)) continue
                  const b = inner(p)
                  const clipped = Math.max(b.top - line.top, line.bottom - b.bottom)
                  if (clipped > tolerance)
                    add("text", el, `text clipped vertically by ${clipped.toFixed(2)}px at ${path(p)}`, p)
                  break
                }
                for (const p of ancestors(el)) {
                  const s = css(p)
                  if (s.display === "inline" || !p.clientWidth) continue
                  const b = inner(p)
                  // Intentional horizontal scrolling still checks text inside each item.
                  if (/(auto|scroll)/.test(s.overflowX)) break
                  const over = Math.max(b.left - line.left, line.right - b.right)
                  if (over > tolerance) {
                    // pre-wrap hangs invisible spaces beyond a wrapped line. Measure
                    // actual words before reporting that as clipped text.
                    ink ??= [...content.matchAll(/\S+/g)].flatMap((word) => {
                      range.setStart(node, word.index)
                      range.setEnd(node, word.index + word[0].length)
                      return [...range.getClientRects()]
                    })
                    if (!ink.some((r) => Math.max(b.left - r.left, r.right - b.right) > tolerance)) continue
                    add("text", el, `text extends ${over.toFixed(2)}px past ${path(p)}`, p)
                    break
                  }
                  if (s.overflowX === "hidden" || s.overflowX === "clip") break
                }
              }
            }
          }
        }
        const s = css(el)
        const boxes = boxChildren(el)
        const paintedChildren = boxes.filter((n) => visible(n))
        const children = boxes.filter(
          (n) => visible(n, false) && css(n).position !== "absolute" && css(n).position !== "fixed"
        )
        // CSS expresses the intended alignment. Compare rows separately when flex wraps;
        // don't infer equal gaps for space-between groups or auto-margin action groups.
        const rowLayout = s.display.includes("grid") || (s.display.includes("flex") && s.flexDirection === "row")
        if (rowLayout && children.length >= 2) {
          const rows: HTMLElement[][] = []
          for (const child of children) {
            const childStyle = css(child)
            // A portrait spanning title + metadata is not a third item in either
            // text row. Its full grid area has a different alignment and centre.
            if (s.display.includes("grid")) {
              const start = num(childStyle.gridRowStart),
                end = num(childStyle.gridRowEnd)
              if (
                /span\s+[2-9]/.test(`${childStyle.gridRowStart} ${childStyle.gridRowEnd}`) ||
                (start && end - start > 1)
              )
                continue
            }
            const r = rect(child)
            let row = rows.find((row) => {
              if (
                s.display.includes("grid") &&
                childStyle.gridRowStart !== "auto" &&
                css(row[0]!).gridRowStart !== "auto"
              )
                return childStyle.gridRowStart === css(row[0]!).gridRowStart
              const a = rect(row[0]!)
              return Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top) > Math.min(a.height, r.height) / 2
            })
            if (!row) {
              row = []
              rows.push(row)
            }
            row.push(child)
          }
          for (const row of rows) {
            row.sort((a, b) => rect(a).left - rect(b).left)
            const autoMargin = row.some((c) => /(?:^|\s|:)(?:m[lrsexy]?|m[lrse])-auto(?:\s|$)/.test(c.className))
            const spacer = [...el.children].some((c) => {
              const element = c as HTMLElement
              const style = css(element)
              if (style.display === "none" || ["absolute", "fixed"].includes(style.position)) return false
              // A transparent hover toolbar still reserves its flex space and both gaps, and a
              // collapsing action toolbar still separates the groups on either side: it can
              // retain hidden controls while its own box has zero width or height. Their controls
              // aren't painted children; don't compare across that space.
              const r = rect(element)
              return (
                num(style.flexGrow) > 0 &&
                (num(style.opacity) === 0 || !r.width || !r.height || (!c.textContent?.trim() && !c.children.length))
              )
            })
            const gaps = row.slice(1).map((c, i) => rect(c).left - rect(row[i]!).right)
            if (
              gaps.length > 1 &&
              !autoMargin &&
              !spacer &&
              ["normal", "start", "flex-start", "center"].includes(s.justifyContent) &&
              Math.max(...gaps) - Math.min(...gaps) > tolerance
            )
              add(
                "gap",
                el,
                `sibling gaps [${gaps.map((g) => g.toFixed(2)).join(", ")}]px; spread ${(Math.max(...gaps) - Math.min(...gaps)).toFixed(2)}px`
              )
            const align = s.alignItems
            if (
              ["center", "start", "flex-start", "end", "flex-end"].includes(align) &&
              row.length > 1 &&
              row.every((c) => ["auto", "normal", align].includes(css(c).alignSelf))
            ) {
              const values = row.map((c) => {
                const r = rect(c)
                return align === "center"
                  ? r.top + r.height / 2 + (num(css(c).marginBottom) - num(css(c).marginTop)) / 2
                  : align.endsWith("end")
                    ? r.bottom + num(css(c).marginBottom)
                    : r.top - num(css(c).marginTop)
              })
              const spread = Math.max(...values) - Math.min(...values)
              if (spread > tolerance)
                add(
                  "alignment",
                  el,
                  `${align} ${values.map((v) => v.toFixed(2)).join(", ")}px; spread ${spread.toFixed(2)}px`
                )
            }
          }
        }
        // Sibling boxes catch overlapping cards, controls and content without treating a
        // containing label, icon or wrapper as overlapping its own contents.
        for (let i = 0; i < paintedChildren.length; i++)
          for (const b of paintedChildren.slice(i + 1)) {
            const a = paintedChildren[i]!
            if (overlay(a) !== overlay(b)) continue
            const overlap = intersection(a, b)
            if (overlap) add("overlap", a, `sibling intersection ${overlap}`, b)
          }
      }
      // Painted content can collide across unrelated wrappers too. Use text ranges,
      // not a paragraph's empty full-width box, for these comparisons.
      const contentRects = new Map<HTMLElement, ReturnType<typeof fragments>>()
      const actions = shown.filter((n) => {
        if (n.matches(`${controls}, img, svg`)) return true
        if ([...ancestors(parent(n))].some((p) => p.matches(`${controls}, svg`))) return false
        const text = [...n.childNodes].filter((c) => c.nodeType === Node.TEXT_NODE && c.textContent?.trim())
        if (!text.length) return false
        const range = document.createRange()
        const lines = text.flatMap((c) => {
          range.selectNodeContents(c)
          return [...range.getClientRects()]
        })
        contentRects.set(
          n,
          lines.flatMap((line) =>
            fragments(n).map((clip) => ({
              left: Math.max(line.left, clip.left),
              right: Math.min(line.right, clip.right),
              top: Math.max(line.top, clip.top),
              bottom: Math.min(line.bottom, clip.bottom)
            }))
          )
        )
        return true
      })
      for (const [el, lines] of contentRects) fragmentCache.set(el, lines)
      for (let i = 0; i < actions.length; i++)
        for (const b of actions.slice(i + 1)) {
          const a = actions[i]!
          if (a.contains(b) || b.contains(a) || overlay(a) !== overlay(b)) continue
          const overlap = intersection(a, b)
          if (overlap) add("overlap", a, `content intersection ${overlap}`, b)
        }
      // Controls laid over a picture (a tile's star, its archive, a group's pin), as they rest
      // and as hovered: the overlay checks above skip them, since they overlap the picture on
      // purpose. Each carries one backing of its own (a wrapper's backing doubles or mismatches
      // it); a hidden sibling keeps no space (the shown control would sit off its corner); in a
      // grid of tiles the first shown control sits at the same inset on every tile; and at rest,
      // where a pointer can hover, only a pressed toggle shows.
      const pictures = "img, picture, video, canvas, [data-portrait]"
      const backed = (el: HTMLElement) => {
        const s = css(el)
        const alpha = s.backgroundColor.match(/[\d.]+(?=\)$)/)?.[0]
        const transparent =
          s.backgroundColor === "transparent" || (/(rgba|\/)/.test(s.backgroundColor) && alpha === "0")
        return !transparent || s.backgroundImage !== "none"
      }
      const hoverable = matchMedia("(hover: hover) and (pointer: fine)").matches
      const groups = new Map<string, Array<{ el: HTMLElement; x: number; y: number }>>()
      for (const layer of nodes) {
        if (!layer.dataset.layoutOverlay || css(layer).position !== "absolute" || !visible(layer, false)) continue
        const host = layer.offsetParent as HTMLElement | null
        // Only local picture overlays use this rule. Page positioners and portalled
        // popups can cover unrelated portraits (or contain their own portrait rows).
        // Stop at their positioned host so local toggles inside a popup stay audited.
        if (
          !host ||
          host === document.body ||
          [...ancestors(layer)].some((p) => p.hasAttribute("data-base-ui-portal") && host.contains(p))
        )
          continue
        const box = rect(layer)
        if (
          ![...host.querySelectorAll<HTMLElement>(pictures)].some((p) => {
            const r = rect(p)
            return (
              r.width &&
              r.height &&
              r.left < box.right &&
              box.left < r.right &&
              r.top < box.bottom &&
              box.top < r.bottom
            )
          })
        )
          continue
        const layerControls = [
          ...(layer.matches(controls) ? [layer] : []),
          ...layer.querySelectorAll<HTMLElement>(controls)
        ]
        const shownControls = layerControls.filter(
          (c) => visible(c) && ![...ancestors(parent(c))].some((p) => layer.contains(p) && p.matches(controls))
        )
        for (const control of shownControls) {
          const wrappers = [...ancestors(parent(control))].slice(0, [...ancestors(parent(control))].indexOf(layer) + 1)
          const backing = wrappers.find(backed)
          if (backing)
            add(
              "overlay",
              control,
              backed(control)
                ? `doubled backing: the control and its wrapper ${path(backing)} both paint one`
                : `backing on the wrapper ${path(backing)}, not on the control`,
              backing
            )
          else if (!backed(control)) add("overlay", control, "no backing of its own over the picture")
          if (
            hoverable &&
            !host.matches(":hover, :focus-within") &&
            control.getAttribute("aria-pressed") !== "true" &&
            host.parentElement &&
            css(host.parentElement).display.includes("grid")
          )
            add("overlay", control, "shown at rest though not a pressed toggle (hover or focus should reveal it)")
        }
        // A hidden control must not take the clicks meant for the picture under it.
        for (const control of layerControls)
          if (visible(control, false) && !visible(control) && css(control).pointerEvents !== "none")
            add("overlay", control, "hidden, yet takes clicks meant for the picture under it")
        // Space kept by a hidden sibling, before a shown one in the overlay's flow.
        for (const container of [layer, ...layer.querySelectorAll<HTMLElement>("*")]) {
          const flow = boxChildren(container).filter(
            (n) => visible(n, false) && !["absolute", "fixed"].includes(css(n).position)
          )
          let nextShown: HTMLElement | undefined
          for (const child of flow.toReversed()) {
            if (visible(child)) nextShown = child
            else if (nextShown)
              add("overlay", nextShown, `hidden ${path(child)} keeps its space before this control`, child)
          }
        }
        const first = shownControls[0]
        const grid = host.parentElement
        if (!first || !grid || !css(grid).display.includes("grid")) continue
        const at = rect(first),
          tile = rect(host)
        const fromLeft = css(layer).left !== "auto"
        const key = `${path(grid)}|${layer.dataset.layoutOverlay}`
        groups.set(key, [
          ...(groups.get(key) ?? []),
          { el: first, x: fromLeft ? at.left - tile.left : tile.right - at.right, y: at.top - tile.top }
        ])
      }
      // The inset most of a grid's tiles use is the intended one; the others are reported.
      for (const tiles of groups.values()) {
        if (tiles.length < 2) continue
        const counts = new Map<string, number>()
        for (const t of tiles)
          counts.set(
            `${Math.round(t.x)},${Math.round(t.y)}`,
            (counts.get(`${Math.round(t.x)},${Math.round(t.y)}`) ?? 0) + 1
          )
        const [usual] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!
        const [ux, uy] = usual.split(",").map(Number) as [number, number]
        for (const t of tiles)
          if (Math.abs(t.x - ux) > tolerance || Math.abs(t.y - uy) > tolerance)
            add(
              "overlay",
              t.el,
              `first shown control at ${t.x.toFixed(2)}, ${t.y.toFixed(2)}px from its tile's corner; ${ux}, ${uy}px on the grid's other tiles`
            )
      }
      return results
    },
    { inset: options.inset ?? 8, scope: options.scope }
  )
}

/** Attach ALL measurements and a crop per violation before failing the test. */
/** `hovered`: audit with the pointer where it is (a hovered tile); by default it moves away first. */
export async function expectLayout(
  page: Page,
  info: TestInfo,
  surface: string,
  options: { scope?: string; hovered?: boolean } = {}
) {
  if (!options.hovered) await page.mouse.move(0, 0)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
  const violations = await layoutAudit(page, { ...(options.scope ? { scope: options.scope } : {}) })
  const slug = surface.replace(/[^a-z0-9-]/gi, "-")
  for (const [i, violation] of violations.entries()) {
    violation.crop = info.outputPath(`${slug}-${i}-${violation.kind}.png`)
    await page.screenshot({ path: violation.crop, clip: violation.box, animations: "disabled" })
    await info.attach(`${surface} ${i} ${violation.kind}`, { path: violation.crop, contentType: "image/png" })
  }
  await info.attach(`${surface} measurements`, {
    body: JSON.stringify(violations, null, 2),
    contentType: "application/json"
  })
  expect.soft(violations, `${surface}: layout violations (crops attached)`).toEqual([])
  return violations
}
