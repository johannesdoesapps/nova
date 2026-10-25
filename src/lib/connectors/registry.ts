import "server-only";
import { gmail, googleCalendar, googleDrive } from "./providers/google";
import { oneDrive, outlook } from "./providers/microsoft";
import { notion } from "./providers/notion";
import { figma, hubspot, wikipedia } from "./providers/others";
import { github } from "./providers/github";
import { vercel } from "./providers/vercel";
import { slack } from "./providers/slack";
import type { ActionDef, Connector, ToolDef } from "./types";

/** Every connector with a server implementation, by id. */
export const REGISTRY: Record<string, Connector> = Object.fromEntries(
  [googleDrive, gmail, googleCalendar, slack, notion, github, vercel, oneDrive, outlook, hubspot, figma, wikipedia].map((c) => [c.meta.id, c]),
);

export function connector(id: string): Connector | null {
  return REGISTRY[id] ?? null;
}

const TOOLS = new Map<string, { connector: Connector; tool: ToolDef }>();
const ACTIONS = new Map<string, { connector: Connector; action: ActionDef }>();
for (const c of Object.values(REGISTRY)) {
  for (const t of c.tools) TOOLS.set(t.name, { connector: c, tool: t });
  for (const a of c.actions) ACTIONS.set(a.name, { connector: c, action: a });
}

export const toolByName = (name: string) => TOOLS.get(name) ?? null;
export const actionByName = (name: string) => ACTIONS.get(name) ?? null;
