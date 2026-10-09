/**
 * Resources and prompts contributed by tool packages (and by the platform itself).
 */
import type { z } from "zod";
import type { TextContent } from "./content.js";

export interface ResourceContents {
  /** UTF-8 text payload (JSON, Markdown, SRT, …). */
  readonly text?: string;
  /** Base64 payload for binary data. */
  readonly blob?: string;
}

export interface ResourceDefinition {
  /** Absolute URI, e.g. "platform://health". Scheme is the owning package or "platform". */
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly mimeType: string;
  readonly read: (signal: AbortSignal) => Promise<ResourceContents>;
}

export interface PromptMessage {
  readonly role: "user" | "assistant";
  readonly content: TextContent;
}

export interface PromptDefinition {
  /** Namespaced like tools: "<package>.<prompt>". */
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  /** Prompt arguments are strings (protocol rule); the schema validates and documents them. */
  readonly arguments: z.ZodObject<Record<string, z.ZodString | z.ZodOptional<z.ZodString>>>;
  readonly render: (args: Readonly<Record<string, string | undefined>>) => Promise<readonly PromptMessage[]>;
}
