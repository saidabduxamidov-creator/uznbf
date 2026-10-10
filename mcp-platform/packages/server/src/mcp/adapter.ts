/**
 * MCP protocol adapter - the only module that imports the MCP SDK.
 *
 * Uses the SDK's low-level Server so the platform owns tool listing (precomputed JSON Schemas),
 * validation, errors, progress and cancellation; the SDK provides transport and JSON-RPC.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { PRODUCT, type CapabilityRequest, type ClientIdentity, type ContentPart, type Logger, type ProgressReport } from "@lmp/core";
import type { ExecutionOutcome, ToolExecutor, ToolRegistry } from "@lmp/kernel";
import { identifyClient } from "./client-identity.js";
import { ProgressForwarder } from "./progress.js";

const CONSENT_TIMEOUT_MS = 120_000;

export interface McpAdapterDeps {
  readonly registry: ToolRegistry;
  readonly executor: ToolExecutor;
  readonly logger: Logger;
  readonly instructions: string;
}

export class McpAdapter {
  readonly server: Server;
  private client: ClientIdentity = { kind: "unknown", name: "unknown", version: "0" };
  private closing = false;

  constructor(private readonly deps: McpAdapterDeps) {
    this.server = new Server(
      { name: PRODUCT.serverName, title: PRODUCT.displayName, version: PRODUCT.version },
      {
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false } },
        instructions: deps.instructions,
      },
    );
    this.server.oninitialized = () => {
      this.client = identifyClient(this.server.getClientVersion());
      deps.logger.info("client initialized", {
        client: this.client,
        elicitation: Boolean(this.server.getClientCapabilities()?.elicitation),
      });
    };
    this.server.onerror = (error) => deps.logger.warn("protocol error", { error });
    this.registerHandlers();
  }

  get clientIdentity(): ClientIdentity {
    return this.client;
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.server.close();
  }

  private registerHandlers(): void {
    const { registry, executor, logger } = this.deps;

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: registry.listTools().map(
        (t): Tool => ({
          name: t.definition.name,
          title: t.definition.title,
          description: t.definition.description,
          inputSchema: t.inputJsonSchema as Tool["inputSchema"],
          ...(t.outputJsonSchema ? { outputSchema: t.outputJsonSchema as NonNullable<Tool["outputSchema"]> } : {}),
          annotations: {
            title: t.definition.title,
            readOnlyHint: t.definition.annotations.readOnly,
            destructiveHint: t.definition.annotations.destructive,
            idempotentHint: t.definition.annotations.idempotent,
            openWorldHint: t.definition.annotations.openWorld,
          },
        }),
      ),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
      const token = request.params._meta?.progressToken;
      const forwarder =
        token === undefined
          ? undefined
          : new ProgressForwarder(
              token,
              (params) => extra.sendNotification({ method: "notifications/progress", params }),
              (error) => logger.debug("progress notification failed", { error }),
            );
      try {
        const outcome = await executor.execute(request.params.name, request.params.arguments ?? {}, {
          requestId: String(extra.requestId),
          client: this.client,
          signal: extra.signal,
          ...(forwarder ? { onProgress: (r: ProgressReport) => forwarder.report(r) } : {}),
          ...(this.server.getClientCapabilities()?.elicitation ? { consent: (message: string, req: CapabilityRequest) => this.askConsent(message, req, extra.signal) } : {}),
        });
        await forwarder?.drain();
        return toCallToolResult(outcome);
      } finally {
        forwarder?.close();
      }
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: registry.listResources().map((r) => ({
        uri: r.definition.uri,
        name: r.definition.name,
        ...(r.definition.title ? { title: r.definition.title } : {}),
        description: r.definition.description,
        mimeType: r.definition.mimeType,
      })),
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const resource = registry.getResource(request.params.uri);
      if (!resource) throw new McpError(-32002, `Resource not found: ${request.params.uri}`, { uri: request.params.uri });
      const contents = await resource.definition.read(extra.signal);
      const base = { uri: resource.definition.uri, mimeType: resource.definition.mimeType };
      return { contents: [contents.blob !== undefined ? { ...base, blob: contents.blob } : { ...base, text: contents.text ?? "" }] };
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: registry.listPrompts().map((p) => ({
        name: p.definition.name,
        ...(p.definition.title ? { title: p.definition.title } : {}),
        description: p.definition.description,
        arguments: Object.entries(p.definition.arguments.shape).map(([name, schema]) => ({
          name,
          ...(schema.description ? { description: schema.description } : {}),
          required: !schema.safeParse(undefined).success,
        })),
      })),
    }));

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const prompt = registry.getPrompt(request.params.name);
      if (!prompt) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt "${request.params.name}"`);
      const parsed = prompt.definition.arguments.safeParse(request.params.arguments ?? {});
      if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid prompt arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      }
      const messages = await prompt.definition.render(parsed.data as Record<string, string | undefined>);
      return { description: prompt.definition.description, messages: messages.map((m) => ({ role: m.role, content: m.content })) };
    });
  }

  /** Asks the user through the client (MCP elicitation). Any failure counts as "not approved". */
  private async askConsent(message: string, request: CapabilityRequest, signal: AbortSignal): Promise<boolean> {
    const result = await this.server.elicitInput(
      {
        mode: "form",
        message,
        requestedSchema: {
          type: "object",
          properties: {
            approve: {
              type: "boolean",
              title: "Allow",
              description: request.target ? `${request.kind}: ${request.target}` : request.kind,
              default: false,
            },
          },
          required: ["approve"],
        },
      },
      { signal, timeout: CONSENT_TIMEOUT_MS },
    );
    return result.action === "accept" && result.content?.["approve"] === true;
  }
}

export function toCallToolResult(outcome: ExecutionOutcome): CallToolResult {
  if (outcome.kind === "result") {
    return {
      content: outcome.result.content.map(toProtocolContent),
      ...(outcome.result.structured !== undefined ? { structuredContent: outcome.result.structured } : {}),
    };
  }
  if (outcome.kind === "job") {
    return {
      content: [
        {
          type: "text",
          text:
            `"${outcome.tool}" is still running as background job ${outcome.jobId}. ` +
            `Call platform.jobs.result with {"jobId":"${outcome.jobId}","waitMs":30000} to get the result, ` +
            `platform.jobs.status to check progress, or platform.jobs.cancel to stop it.`,
        },
      ],
      _meta: { [`${PRODUCT.id}/job`]: { jobId: outcome.jobId, tool: outcome.tool, state: "running" } },
    };
  }
  const { error } = outcome;
  return {
    isError: true,
    content: [{ type: "text", text: error.retryable ? `${error.message} (temporary - retrying may succeed)` : error.message }],
    _meta: { [`${PRODUCT.id}/error`]: { code: error.code, retryable: error.retryable } },
  };
}

function toProtocolContent(part: ContentPart): CallToolResult["content"][number] {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return { type: "image", data: part.data, mimeType: part.mimeType };
    case "resource_link":
      return {
        type: "resource_link",
        uri: part.uri,
        name: part.name,
        ...(part.mimeType ? { mimeType: part.mimeType } : {}),
        ...(part.description ? { description: part.description } : {}),
      };
  }
}
