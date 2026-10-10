/**
 * Maps the MCP `initialize` client info to a client family. This only toggles behaviour that
 * depends on client capabilities; business logic never branches on the client.
 */
import type { ClientIdentity } from "@lmp/core";

export function identifyClient(info: { readonly name?: string; readonly version?: string } | undefined): ClientIdentity {
  const name = info?.name ?? "unknown";
  const version = info?.version ?? "0";
  const lower = name.toLowerCase();
  if (lower.includes("claude")) return { kind: "claude", name, version };
  if (lower.includes("chatgpt") || lower.includes("openai") || lower.includes("codex")) return { kind: "chatgpt", name, version };
  return { kind: "unknown", name, version };
}
