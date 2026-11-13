/** Browser API v1. Full plugins run as the signed-in user; these handles are not a sandbox. */
import type { ComponentType, ComponentProps } from "react"
export {
  Children,
  Component,
  Fragment,
  StrictMode,
  Suspense,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version
} from "react"
import React from "react"
export { React }
export { jsx, jsxs } from "react/jsx-runtime"
export { default } from "react"

export interface DraftControl {
  /** Appends to the current draft, including its normal browser backup and server saving. */
  readonly append: (text: string) => void
}
export interface ComposerContext {
  readonly draft: DraftControl
  readonly compact: boolean
  readonly busy: boolean
  readonly ready: boolean
}
export interface ComposerEntry {
  readonly id: string
  readonly order: number
  readonly placement: "tools" | "banner" | "strip"
  readonly component: ComponentType<ComposerContext>
}
export interface PanelContext {
  readonly active: boolean
  readonly chatId: string
  readonly forkId: string | null
}
export interface PanelEntry {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly order: number
  readonly component: ComponentType<PanelContext>
}
export interface RouteEntry {
  readonly id: string
  /** A top-level path below /extensions/. */
  readonly path: string
  readonly component: ComponentType
}
export interface BannerEntry {
  readonly id: string
  readonly order: number
  readonly component: ComponentType
}
export interface ClientRegistry<A> {
  readonly register: (entry: A) => () => void
  readonly disable: (id: string) => () => void
  readonly list: () => ReadonlyArray<{ readonly id: string }>
}
export interface ClientHost {
  readonly api: 1
  readonly id: string
  readonly registries: {
    readonly composerControls?: ClientRegistry<ComposerEntry>
    readonly chatPanels?: ClientRegistry<PanelEntry>
    readonly routes?: ClientRegistry<RouteEntry>
    readonly appBanners?: ClientRegistry<BannerEntry>
  }
  /** Owns cleanup such as subscriptions. Runs even when activation fails or times out. */
  readonly onDispose: (dispose: () => void) => void
}
export type Activate = (host: ClientHost) => void | Promise<void>

interface ButtonProps extends Omit<ComponentProps<"button">, "title"> {
  readonly hint: string
  readonly variant?: "primary" | "secondary" | "ghost" | "danger"
}
/** Components are supplied by /plugin-host.mjs, sharing the application's UI and React. */
export declare const ui: {
  readonly Button: ComponentType<ButtonProps>
  readonly IconButton: ComponentType<ButtonProps>
}
export declare const rpc: {
  readonly useAction: () => {
    readonly pending: boolean
    readonly error: { readonly message: string } | null
    readonly run: (tag: string, payload: unknown) => Promise<{ readonly ok: boolean; readonly value?: unknown }>
  }
}
