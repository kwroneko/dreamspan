// The app and external plugins share this build entry and its imported module graph.
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
export { default } from "react"
export { jsx, jsxs } from "react/jsx-runtime"
export type { Activate, ClientHost, ComposerContext, PanelContext } from "../../plugin-api/src/client.ts"
export { ui, rpc, Switch, Alert } from "./pluginUi.tsx"
export { syncClientPlugins } from "./pluginLifecycle.ts"
