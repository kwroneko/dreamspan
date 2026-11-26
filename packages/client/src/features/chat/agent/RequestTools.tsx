import type { OfferedTool } from "@dreamspan/shared/agent.ts"
import type { RequestTool, RequestTools as Declarations } from "@dreamspan/shared/inspectorApi.ts"
import { Disclosure } from "../../../ui/Surface.tsx"
import { Tooltip } from "../../../ui/Tooltip.tsx"
import { formatWhen } from "../chatTitle.ts"

type Tool = Omit<RequestTool, "tokens"> & { readonly tokens?: number }

export const toolsForRequest = (declarations: Declarations | undefined, id = declarations?.latest) =>
  id === undefined || declarations === undefined
    ? undefined
    : declarations.attempts[id]?.map((key) => declarations.definitions[key]!)

export const toolTokens = (tools: ReadonlyArray<Tool>) => tools.reduce((sum, tool) => sum + (tool.tokens ?? 0), 0)

export const legacyRequestTools = (tools: ReadonlyArray<OfferedTool>, loads: ReadonlyMap<string, string> = new Map()) =>
  tools.flatMap((tool): Array<Tool> => {
    if (!tool.deferred) return [tool]
    const loadedBy = tool.loadedBy === undefined ? undefined : loads.get(tool.loadedBy)
    return loadedBy === undefined ? [] : [{ ...tool, loadedBy }]
  })

const count = (n: number) => n.toLocaleString()

export const requestTokenText = (messages: number, tools: number) =>
  `${count(messages + tools)} tokens: ${count(messages)} messages, ${count(tools)} tools`

export function RequestTools({ tools }: { tools: ReadonlyArray<Tool> }) {
  if (tools.length === 0) return null
  const counted = tools.every((tool) => tool.tokens !== undefined)
  return (
    <section aria-label="Tools" className="min-w-0 rounded-md border border-border bg-surface px-2.5 py-1.5">
      <Disclosure
        className="[&>div]:pl-0 sm:[&>div]:pl-5"
        title={
          <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
            <span className="font-semibold text-text">Tools</span>
            {counted && (
              <span className="text-xs whitespace-nowrap tabular-nums">{count(toolTokens(tools))} tokens</span>
            )}
          </span>
        }
        hint="Show or hide the tool definitions included in this request. The token count is an estimate."
        lazy
      >
        <div className="flex min-w-0 flex-col gap-2">
          {tools.map((tool, i) => (
            <section
              key={`${tool.name}:${i}`}
              aria-label={tool.name}
              className="min-w-0 rounded-md border border-border"
            >
              <Tooltip label="The name of this tool in the request and the estimated size of its definition.">
                <h3 className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-t-md border-b border-border bg-surface-raised px-2.5 py-2 text-xs">
                  <span className="min-w-0 font-mono font-medium text-text [overflow-wrap:anywhere]">{tool.name}</span>
                  {tool.tokens !== undefined && (
                    <span className="text-muted tabular-nums">{count(tool.tokens)} tokens</span>
                  )}
                </h3>
              </Tooltip>
              <div className="flex min-w-0 flex-col gap-1 bg-canvas px-2.5 py-2">
                {(tool.label !== tool.name || tool.loadedBy || tool.mcp) && (
                  <p className="text-xs text-muted [overflow-wrap:anywhere]">
                    {tool.label !== tool.name && tool.label}
                    {tool.loadedBy && (
                      <>
                        {tool.label !== tool.name && " · "}Loaded by <code>{tool.loadedBy}</code>
                      </>
                    )}
                    {tool.mcp && (
                      <>
                        {(tool.label !== tool.name || tool.loadedBy) && " · "}
                        From {tool.mcp.connectionName}
                        {tool.mcp.listedAt === null ? "" : `, listed ${formatWhen(tool.mcp.listedAt)}`}
                      </>
                    )}
                  </p>
                )}
                <p className="font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-text [overflow-wrap:anywhere]">
                  {tool.description || <span className="font-sans text-muted italic">(empty)</span>}
                </p>
                <Disclosure
                  title={tool.format === undefined ? "Parameters" : "Format"}
                  hint={`Show or hide the ${tool.format === undefined ? "parameter schema" : "format constraint"} sent for ${tool.name}.`}
                  lazy
                >
                  <pre className="font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-text [overflow-wrap:anywhere]">
                    {JSON.stringify(tool.format ?? tool.parameters, null, 2)}
                  </pre>
                </Disclosure>
              </div>
            </section>
          ))}
        </div>
      </Disclosure>
    </section>
  )
}
