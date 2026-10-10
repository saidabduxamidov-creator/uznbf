#!/usr/bin/env node
/**
 * Build guard for the MCP platform. Fails when:
 *  - platform sources or manifests reference a forbidden AI provider SDK/endpoint (the MCP platform
 *    performs no AI calls; Gemini stays in the editing panels, outside this platform),
 *  - an installed dependency declares an install script (supply-chain policy),
 *  - source code opens network connections outside the explicitly allowed modules.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

const FORBIDDEN = [
  [/gemini|generativelanguage\.googleapis|aiplatform\.googleapis|vertex\s*ai|@google\/(genai|generative-ai)|google-cloud\/aiplatform/i, "Google AI reference"],
  [/flow\.google|\bveo\b/i, "Google Flow/Veo reference"],
  [/api\.openai\.com|(?:from|import|require\()\s*["']openai["']|api\.anthropic\.com|@anthropic-ai\/sdk|mistral|cohere|ollama|groq/i, "AI provider API/SDK (the MCP server must not call AI services)"],
];
/** Modules allowed to open network connections (none yet; the browser tool will be listed here). */
const NETWORK_ALLOWED = new Set([]);
const NETWORK_API = /\b(?:fetch\s*\(|https?\.request|https?\.get|net\.connect|tls\.connect|new\s+WebSocket\s*\(|dgram\.)/;

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.(ts|mts|js|mjs|json|md)$/.test(entry.name) && entry.name !== "package-lock.json") out.push(full);
  }
  return out;
}

for (const file of await walk(root)) {
  const rel = path.relative(root, file);
  if (rel === path.join("scripts", "guard.mjs")) continue;
  const content = await readFile(file, "utf8");
  // Documentation may explain what is outside the platform; only code and manifests are policed.
  const isCode = !file.endsWith(".md");
  for (const [pattern, label] of isCode ? FORBIDDEN : []) {
    const match = content.match(pattern);
    if (match) problems.push(`${rel}: ${label} ("${match[0]}")`);
  }
  if (/\.(ts|mts)$/.test(file) && !/[\\/]test[\\/]/.test(rel) && NETWORK_API.test(content) && !NETWORK_ALLOWED.has(rel)) {
    problems.push(`${rel}: opens network connections but is not in the network allowlist`);
  }
}

const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
for (const [name, info] of Object.entries(lock.packages ?? {})) {
  if (info.hasInstallScript) problems.push(`package-lock.json: ${name || "(root)"} has an install script`);
  if (/node_modules\/(@google\/|openai$|@anthropic-ai\/)/.test(name)) problems.push(`package-lock.json: forbidden dependency ${name}`);
}

if (problems.length) {
  console.error(`guard: ${problems.length} problem(s)\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log("guard: ok");
