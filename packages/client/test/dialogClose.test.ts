import { Children, isValidElement, type ReactElement, type ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { ConfirmDialog, Dialog } from "../src/ui/Dialog.tsx"
import { Popover } from "../src/ui/Popover.tsx"
import { Sheet } from "../src/ui/Sheet.tsx"
import { WindowClose } from "../src/ui/WindowClose.tsx"

// Inspect the primitive's component tree without a DOM. Real focus, pointer dismissal
// and text preservation are exercised in the browser's fieldChrome tests.
vi.hoisted(() => vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" }))

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: () => ({ current: null })
}))

function closeControls(node: ReactNode): ReactElement<{ onClick: () => void }>[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return []
    if (child.type === WindowClose) return [child as ReactElement<{ onClick: () => void }>]
    return closeControls(child.props.children)
  })
}

describe("window corner close", () => {
  it("has an accessible name and the shared icon/tooltip label", () => {
    const control = WindowClose({})
    expect(control.props.label).toBe("Close")
    expect(control.props.icon).toBe("close")
    // IconButton uses its label as its hover/focus tooltip when no hint overrides it.
    expect(control.props.hint).toBeUndefined()
    expect(control.props.className).toContain("size-11")
  })

  it.each([Dialog, Sheet, Popover])("dismisses a shared window through its open-change handler", (Window) => {
    const onOpenChange = vi.fn()
    const tree = Window({
      open: true,
      onOpenChange,
      title: "A window",
      children: "Text",
      trigger: "Open",
      triggerLabel: "Open"
    })
    const controls = closeControls(tree)
    expect(controls).toHaveLength(1)
    controls[0]!.props.onClick()
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
  })

  it("leaves confirmation dialogs to their action buttons", () => {
    const tree = ConfirmDialog({
      open: true,
      onOpenChange: vi.fn(),
      title: "Delete?",
      description: "Deletes this.",
      confirmLabel: "Delete",
      onConfirm: vi.fn()
    })
    expect(closeControls(tree)).toEqual([])
  })
})
