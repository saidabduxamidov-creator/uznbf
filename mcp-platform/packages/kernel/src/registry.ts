/**
 * Registry of everything the server exposes. Validates names and namespaces, rejects duplicates,
 * and precomputes JSON Schemas (zod → JSON Schema 2020-12) once at registration so listing tools
 * is a cheap read.
 */
import {
  InternalError,
  TOOL_NAME_PATTERN,
  ValidationError,
  type AnyToolDefinition,
  type CapabilityKind,
  type PromptDefinition,
  type ResourceDefinition,
} from "@lmp/core";
import { z } from "zod";

export interface RegisteredTool {
  readonly definition: AnyToolDefinition;
  readonly packageId: string;
  readonly packageVersion: string;
  readonly allowedCapabilities: ReadonlySet<CapabilityKind>;
  readonly inputJsonSchema: Record<string, unknown>;
  readonly outputJsonSchema?: Record<string, unknown>;
}

export interface RegisteredPrompt {
  readonly definition: PromptDefinition;
  readonly packageId: string;
}

export interface RegisteredResource {
  readonly definition: ResourceDefinition;
  readonly packageId: string;
}

export interface PackageIdentity {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly CapabilityKind[];
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly prompts = new Map<string, RegisteredPrompt>();
  private readonly resources = new Map<string, RegisteredResource>();

  registerTool(pkg: PackageIdentity, definition: AnyToolDefinition): void {
    if (!TOOL_NAME_PATTERN.test(definition.name)) throw new ValidationError(`Invalid tool name "${definition.name}"`);
    if (!definition.name.startsWith(`${pkg.id}.`)) throw new ValidationError(`Tool "${definition.name}" must be namespaced under "${pkg.id}."`);
    if (this.tools.has(definition.name)) throw new ValidationError(`Duplicate tool "${definition.name}"`);
    if (!isZodObject(definition.input)) throw new ValidationError(`Tool "${definition.name}" input must be a zod object schema`);
    if (definition.output !== undefined && !isZodObject(definition.output)) throw new ValidationError(`Tool "${definition.name}" output must be a zod object schema`);
    if (definition.execution.longRunning && definition.output) {
      // A long-running call may answer with a job reference, which could not satisfy the schema.
      throw new ValidationError(`Long-running tool "${definition.name}" cannot declare an output schema; return structured data from the job result instead`);
    }
    const registered: RegisteredTool = {
      definition,
      packageId: pkg.id,
      packageVersion: pkg.version,
      allowedCapabilities: new Set(pkg.capabilities),
      inputJsonSchema: toJsonSchema(definition.input, "input", definition.name),
      ...(definition.output ? { outputJsonSchema: toJsonSchema(definition.output, "output", definition.name) } : {}),
    };
    this.tools.set(definition.name, registered);
  }

  registerPrompt(pkg: PackageIdentity, definition: PromptDefinition): void {
    if (!TOOL_NAME_PATTERN.test(definition.name) || !definition.name.startsWith(`${pkg.id}.`)) {
      throw new ValidationError(`Prompt "${definition.name}" must be namespaced under "${pkg.id}."`);
    }
    if (this.prompts.has(definition.name)) throw new ValidationError(`Duplicate prompt "${definition.name}"`);
    this.prompts.set(definition.name, { definition, packageId: pkg.id });
  }

  registerResource(pkg: PackageIdentity, definition: ResourceDefinition): void {
    let url: URL;
    try {
      url = new URL(definition.uri);
    } catch {
      throw new ValidationError(`Resource URI is not absolute: "${definition.uri}"`);
    }
    const scheme = url.protocol.slice(0, -1);
    if (scheme !== pkg.id && !(pkg.id === "platform" && scheme === "platform")) {
      throw new ValidationError(`Resource "${definition.uri}" must use the "${pkg.id}://" scheme`);
    }
    if (this.resources.has(definition.uri)) throw new ValidationError(`Duplicate resource "${definition.uri}"`);
    this.resources.set(definition.uri, { definition, packageId: pkg.id });
  }

  /** Removes everything a package contributed (used when a package fails mid-registration). */
  removePackage(packageId: string): void {
    for (const [k, v] of this.tools) if (v.packageId === packageId) this.tools.delete(k);
    for (const [k, v] of this.prompts) if (v.packageId === packageId) this.prompts.delete(k);
    for (const [k, v] of this.resources) if (v.packageId === packageId) this.resources.delete(k);
  }

  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }
  getPrompt(name: string): RegisteredPrompt | undefined {
    return this.prompts.get(name);
  }
  getResource(uri: string): RegisteredResource | undefined {
    return this.resources.get(uri);
  }
  listTools(): RegisteredTool[] {
    return [...this.tools.values()].sort((a, b) => a.definition.name.localeCompare(b.definition.name));
  }
  listPrompts(): RegisteredPrompt[] {
    return [...this.prompts.values()].sort((a, b) => a.definition.name.localeCompare(b.definition.name));
  }
  listResources(): RegisteredResource[] {
    return [...this.resources.values()].sort((a, b) => a.definition.uri.localeCompare(b.definition.uri));
  }
}

/**
 * Structural check instead of `instanceof`: tool packages may resolve their own copy of zod (same
 * major version), which would fail an identity check against the kernel's copy.
 */
export function isZodObject(value: unknown): value is z.ZodObject {
  const internals = (value as { _zod?: { def?: { type?: unknown } } } | null)?._zod;
  return typeof (value as { safeParse?: unknown } | null)?.safeParse === "function" && internals?.def?.type === "object";
}

function toJsonSchema(schema: z.ZodType, io: "input" | "output", tool: string): Record<string, unknown> {
  try {
    const json = z.toJSONSchema(schema, { io, unrepresentable: "throw", target: "draft-2020-12" }) as Record<string, unknown>;
    if (json["type"] !== "object") throw new Error("root must be an object schema");
    delete json["$schema"];
    return json;
  } catch (error) {
    throw new InternalError(`Tool "${tool}" ${io} schema cannot be expressed as JSON Schema: ${(error as Error).message}`, { cause: error });
  }
}
