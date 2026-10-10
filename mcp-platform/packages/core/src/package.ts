/**
 * Tool package contract. Each package is an independent unit discovered at startup: it declares a
 * manifest and contributes tools, resources and prompts. Adding a package never requires changes
 * to existing code.
 */
import { z } from "zod";
import { CAPABILITY_KINDS } from "./capabilities.js";
import type { Cache, Logger } from "./ports.js";
import type { PromptDefinition, ResourceDefinition } from "./resources.js";
import type { AnyToolDefinition } from "./tool.js";

export const PACKAGE_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const ToolPackageManifestSchema = z
  .object({
    id: z.string().regex(PACKAGE_ID_PATTERN, "lowercase id: letters, digits, underscore"),
    version: z.string().regex(SEMVER, "semantic version"),
    displayName: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    platforms: z.array(z.enum(["win32", "darwin", "linux"])).min(1),
    /** Every capability kind the package may request; requests outside this list are rejected. */
    capabilities: z.array(z.enum(CAPABILITY_KINDS)),
  })
  .strict();

export type ToolPackageManifest = z.output<typeof ToolPackageManifestSchema>;

/** Persistent key/value storage scoped to one package. Values must be JSON-serializable. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<readonly string[]>;
}

/** A package's private view of the platform cache (keys are isolated per package). */
export type ScopedCache = Pick<Cache, "get" | "set" | "delete">;

export interface PackageServices {
  readonly cache: ScopedCache;
  readonly kv: KeyValueStore;
  /** Writable directory owned by the package (created on demand by the platform). */
  readonly dataDir: string;
  /** Directory for large derived artifacts that may be evicted (frames, proxies, audio). */
  readonly artifactsDir: string;
}

export interface PackageContext<C> {
  readonly manifest: ToolPackageManifest;
  readonly config: C;
  readonly logger: Logger;
  readonly services: PackageServices;
  readonly platform: NodeJS.Platform;
  /** Platform data directory (read-only use: shared discovery files such as editor bridges). */
  readonly platformDataDir: string;
}

export interface PackageContribution {
  readonly tools?: readonly AnyToolDefinition[];
  readonly resources?: readonly ResourceDefinition[];
  readonly prompts?: readonly PromptDefinition[];
}

export interface ToolPackage<C = unknown> {
  readonly manifest: ToolPackageManifest;
  /** Validates `tools.settings.<id>` from the platform configuration. */
  readonly configSchema?: z.ZodType<C>;
  readonly register: (context: PackageContext<C>) => PackageContribution | Promise<PackageContribution>;
  /** Releases package-owned resources (connections, child processes) on shutdown. */
  readonly dispose?: () => Promise<void>;
}

export function defineToolPackage<C = unknown>(pkg: ToolPackage<C>): ToolPackage<C> {
  return pkg;
}
