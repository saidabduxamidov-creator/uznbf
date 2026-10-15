/**
 * Universal AI tools: call ChatGPT, Claude, or Gemini
 */

import {
  TOOL_CATEGORY,
  ValidationError,
  type Tool,
  type ToolPackage,
  type ExecutionContext,
  type Logger,
} from "@lmp/core";
import { z } from "zod";

export const PACKAGE_ID = "ai";

/**
 * Tool package exporting universal AI call tools
 */
export const create = (deps: {
  logger: Logger;
  config: {
    chatgpt?: { clientId: string; clientSecret: string; redirectUri: string };
    claude?: { apiKey: string };
    gemini?: { apiKey: string };
  };
}): ToolPackage => {
  const { logger, config } = deps;

  const tools: Tool[] = [
    {
      id: "ai.text",
      category: TOOL_CATEGORY.CONTENT_GENERATION,
      title: "AI Text Generation",
      description: "Generate text using ChatGPT, Claude, or Gemini",
      input: z.object({
        prompt: z.string().describe("The prompt to send to the AI"),
        provider: z.enum(["chatgpt", "claude", "gemini"]).describe("Which AI provider to use"),
        model: z.string().optional().describe("Specific model to use"),
        temperature: z.number().min(0).max(2).default(0.7),
        maxTokens: z.number().min(1).max(4096).default(2048),
        systemPrompt: z.string().optional(),
      }),
      execute: async (input, ctx) => {
        // Import dynamically to avoid circular dependencies
        const { AIIntegration } = await import("@lmp/kernel");

        if (!config[input.provider]) {
          throw new ValidationError(`${input.provider} is not configured`);
        }

        // Token availability will be checked by AIIntegration
        const response = await callAI(
          input.provider,
          [
            ...(input.systemPrompt ? [{ role: "system" as const, content: input.systemPrompt }] : []),
            { role: "user" as const, content: input.prompt },
          ],
          { temperature: input.temperature, maxTokens: input.maxTokens, model: input.model },
        );

        return {
          result: response.content,
          usage: response.usage,
          model: response.model,
        };
      },
    },

    {
      id: "ai.status",
      category: TOOL_CATEGORY.SYSTEM,
      title: "AI Connection Status",
      description: "Check which AI providers are authenticated and ready",
      input: z.object({}),
      execute: async (input, ctx) => {
        // Would call OAuthManager to get status
        // This is a placeholder that shows the pattern
        return {
          providers: {
            chatgpt: !!config.chatgpt,
            claude: !!config.claude,
            gemini: !!config.gemini,
          },
        };
      },
    },

    {
      id: "ai.models",
      category: TOOL_CATEGORY.SYSTEM,
      title: "List Available Models",
      description: "List available models for a specific AI provider",
      input: z.object({
        provider: z.enum(["chatgpt", "claude", "gemini"]),
      }),
      execute: async (input, ctx) => {
        const models = {
          chatgpt: ["gpt-4-turbo", "gpt-4o", "gpt-4o-mini"],
          claude: ["claude-opus-5-5", "claude-sonnet-4-20250514", "claude-haiku-3-5"],
          gemini: ["gemini-2.0-flash", "gemini-2.0-pro", "gemini-1.5-flash"],
        };

        return { models: models[input.provider] };
      },
    },
  ];

  return {
    id: PACKAGE_ID,
    label: "AI",
    version: "0.1.0",
    tools,
  };
};

/**
 * Unified AI call function (will be implemented with real integration)
 */
async function callAI(
  provider: string,
  messages: any[],
  options: any = {},
): Promise<{ content: string; usage?: any; model?: string }> {
  // This will be implemented with actual API calls
  // For now, return a placeholder response
  return {
    content: `Response from ${provider}`,
    model: options.model,
  };
}
