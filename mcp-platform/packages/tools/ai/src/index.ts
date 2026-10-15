/**
 * Universal AI tools: call ChatGPT, Claude, or Gemini
 */

import { defineTool, defineToolPackage, text } from "@lmp/core";
import { z } from "zod";

export default defineToolPackage({
  manifest: {
    id: "ai",
    version: "0.1.0",
    displayName: "AI Services",
    description: "Call ChatGPT, Claude, or Gemini AI services",
    platforms: ["win32", "darwin", "linux"],
    capabilities: [],
  },
  register: () => {
    return {
      tools: [
        defineTool({
          name: "ai.text",
          title: "AI Text Generation",
          description: "Generate text using ChatGPT, Claude, or Gemini. Note: Requires authentication tokens.",
          input: z.object({
            prompt: z.string().describe("The prompt to send to the AI"),
            provider: z.enum(["chatgpt", "claude", "gemini"]).describe("Which AI provider to use"),
            model: z.string().optional().describe("Specific model to use"),
            temperature: z.number().min(0).max(2).default(0.7),
            maxTokens: z.number().min(1).max(4096).default(2048),
            systemPrompt: z.string().optional(),
          }).strict(),
          annotations: { readOnly: true, destructive: false, idempotent: false, openWorld: false },
          execution: { resourceClass: "external", timeoutMs: 60_000 },
          capabilities: () => [],
          run: async (input) => {
            return {
              content: [text(`[Placeholder] Would call ${input.provider} with: ${input.prompt.substring(0, 100)}...`)],
              structured: { provider: input.provider, status: "auth_required" }
            };
          },
        }),

        defineTool({
          name: "ai.status",
          title: "AI Connection Status",
          description: "Check which AI providers are configured",
          input: z.object({}).strict(),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "cpu", timeoutMs: 5_000 },
          capabilities: () => [],
          run: async () => {
            return {
              content: [text("AI connection status: Configure OAuth tokens to enable AI services")],
              structured: { configured: false }
            };
          },
        }),

        defineTool({
          name: "ai.models",
          title: "List Available Models",
          description: "List available models for a specific AI provider",
          input: z.object({
            provider: z.enum(["chatgpt", "claude", "gemini"]),
          }).strict(),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "cpu", timeoutMs: 5_000 },
          capabilities: () => [],
          run: async (input) => {
            const models: Record<string, string[]> = {
              chatgpt: ["gpt-4-turbo", "gpt-4o", "gpt-4o-mini"],
              claude: ["claude-opus-5-5", "claude-sonnet-4-20250514", "claude-haiku-3-5"],
              gemini: ["gemini-2.0-flash", "gemini-2.0-pro", "gemini-1.5-flash"],
            };

            const modelList = models[input.provider] || [];
            return {
              content: [text(modelList.join("\n"))],
              structured: { provider: input.provider, models: modelList }
            };
          },
        }),
      ],
    };
  },
});
