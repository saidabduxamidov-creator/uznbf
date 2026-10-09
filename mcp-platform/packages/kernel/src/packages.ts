/**
 * Tool package discovery and lifecycle.
 *
 * A package directory contains package.json with an "lmpTool" descriptor:
 *     { "name": "...", "lmpTool": { "id": "ffmpeg", "entry": "dist/index.js" } }
 * The entry module's default export is a ToolPackage (see defineToolPackage).
 *
 * Built-in directories are trusted. Packages from user-configured directories load only when
 * `tools.trusted[id]` holds the sha-256 of their entry file - checked before any code is imported.
 * Each package loads in isolation: a failing package is reported and skipped, never fatal.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PACKAGE_ID_PATTERN,
  ToolPackageManifestSchema,
  ValidationError,
  type EventBus,
  type KeyValueStore,
  type Logger,
  type PackageContribution,
  type ScopedCache,
  type ToolPackage,
} from "@lmp/core";
import type { PlatformConfig } from "./config.js";
import type { PlatformEvents } from "./events.js";
import { isWithin } from "./permissions/paths.js";
import type { ToolRegistry } from "./registry.js";

export interface PackageSource {
  readonly directory: string;
  readonly builtin: boolean;
}

export interface LoadedPackage {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly location: string;
  readonly builtin: boolean;
  readonly tools: number;
  readonly resources: number;
  readonly prompts: number;
}

export interface PackageProblem {
  readonly location: string;
  readonly id?: string;
  readonly reason: string;
}

export interface PackageReport {
  readonly loaded: readonly LoadedPackage[];
  readonly skipped: readonly PackageProblem[];
  readonly failed: readonly PackageProblem[];
}

export interface PackageManagerDeps {
  readonly registry: ToolRegistry;
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly events: EventBus<PlatformEvents>;
  readonly cacheFor: (packageId: string) => ScopedCache;
  readonly kvFor: (packageId: string) => KeyValueStore;
  readonly dataRoot: string;
  readonly artifactsRoot: string;
  readonly platform: NodeJS.Platform;
}

const DescriptorSchema = {
  parse(json: unknown, location: string): { id: string; entry: string } {
    const lmp = (json as { lmpTool?: unknown } | null)?.lmpTool as { id?: unknown; entry?: unknown } | undefined;
    if (!lmp || typeof lmp !== "object") throw new ValidationError(`${location}: package.json has no "lmpTool" descriptor`);
    if (typeof lmp.id !== "string" || !PACKAGE_ID_PATTERN.test(lmp.id)) throw new ValidationError(`${location}: lmpTool.id is invalid`);
    if (typeof lmp.entry !== "string" || lmp.entry.length === 0) throw new ValidationError(`${location}: lmpTool.entry is missing`);
    return { id: lmp.id, entry: lmp.entry };
  },
};

export class PackageManager {
  private readonly loaded: LoadedPackage[] = [];
  private readonly skipped: PackageProblem[] = [];
  private readonly failed: PackageProblem[] = [];
  private readonly disposers: Array<{ id: string; dispose: () => Promise<void> }> = [];

  constructor(private readonly deps: PackageManagerDeps) {}

  report(): PackageReport {
    return { loaded: [...this.loaded], skipped: [...this.skipped], failed: [...this.failed] };
  }

  /** Registers a package object that ships inside the server (no discovery, always trusted). */
  async registerBuiltin(pkg: ToolPackage<unknown>, location = "builtin"): Promise<boolean> {
    return this.activate(pkg, location, true);
  }

  async discover(sources: readonly PackageSource[]): Promise<void> {
    for (const source of sources) {
      let entries: string[];
      try {
        entries = await readdir(source.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.fail({ location: source.directory, reason: `cannot read directory: ${(error as Error).message}` });
        }
        continue;
      }
      for (const name of entries.sort()) {
        const dir = path.join(source.directory, name);
        await this.loadFromDirectory(dir, source.builtin);
      }
    }
  }

  async disposeAll(): Promise<void> {
    for (const { id, dispose } of this.disposers.reverse()) {
      try {
        await dispose();
      } catch (error) {
        this.deps.logger.warn("package dispose failed", { package: id, error });
      }
    }
    this.disposers.length = 0;
  }

  private async loadFromDirectory(dir: string, builtin: boolean): Promise<void> {
    let pkgJson: unknown;
    try {
      pkgJson = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return; // not a package directory
      this.fail({ location: dir, reason: `invalid package.json: ${(error as Error).message}` });
      return;
    }
    let descriptor: { id: string; entry: string };
    try {
      descriptor = DescriptorSchema.parse(pkgJson, dir);
    } catch (error) {
      this.fail({ location: dir, reason: (error as Error).message });
      return;
    }
    const { config } = this.deps;
    if (config.tools.disabled.includes(descriptor.id)) {
      this.skip({ location: dir, id: descriptor.id, reason: "disabled in configuration" });
      return;
    }
    let entryFile: string;
    try {
      const realDir = await realpath(dir);
      entryFile = await realpath(path.resolve(realDir, descriptor.entry));
      if (!isWithin(realDir, entryFile, process.platform)) throw new ValidationError("entry resolves outside the package directory");
    } catch (error) {
      this.fail({ location: dir, id: descriptor.id, reason: `entry not usable: ${(error as Error).message}` });
      return;
    }
    if (!builtin) {
      const expected = config.tools.trusted[descriptor.id];
      const actual = createHash("sha256").update(await readFile(entryFile)).digest("hex");
      if (!expected) {
        this.skip({ location: dir, id: descriptor.id, reason: `not trusted; to enable add "tools.trusted": { "${descriptor.id}": "${actual}" }` });
        return;
      }
      if (expected.toLowerCase() !== actual) {
        this.skip({ location: dir, id: descriptor.id, reason: `entry hash mismatch (expected ${expected}, found ${actual}); package changed since it was trusted` });
        return;
      }
    }
    let pkg: ToolPackage<unknown>;
    try {
      const mod = (await import(pathToFileURL(entryFile).href)) as { default?: unknown };
      pkg = mod.default as ToolPackage<unknown>;
      if (!pkg || typeof pkg !== "object" || typeof pkg.register !== "function") throw new ValidationError("default export is not a tool package");
    } catch (error) {
      this.fail({ location: dir, id: descriptor.id, reason: `import failed: ${(error as Error).message}` });
      return;
    }
    if ((pkg.manifest as { id?: unknown } | undefined)?.id !== descriptor.id) {
      this.fail({ location: dir, id: descriptor.id, reason: "manifest id does not match lmpTool.id" });
      return;
    }
    await this.activate(pkg, dir, builtin);
  }

  private async activate(pkg: ToolPackage<unknown>, location: string, builtin: boolean): Promise<boolean> {
    const parsed = ToolPackageManifestSchema.safeParse(pkg.manifest);
    if (!parsed.success) {
      this.fail({ location, reason: `invalid manifest: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
      return false;
    }
    const manifest = parsed.data;
    const { config, registry, logger } = this.deps;
    if (this.loaded.some((p) => p.id === manifest.id)) {
      this.fail({ location, id: manifest.id, reason: "a package with this id is already loaded" });
      return false;
    }
    if (!manifest.platforms.includes(this.deps.platform as "win32" | "darwin" | "linux")) {
      this.skip({ location, id: manifest.id, reason: `not supported on ${this.deps.platform}` });
      return false;
    }
    if (config.tools.disabled.includes(manifest.id)) {
      this.skip({ location, id: manifest.id, reason: "disabled in configuration" });
      return false;
    }
    let settings: unknown = config.tools.settings[manifest.id] ?? {};
    if (pkg.configSchema) {
      const result = pkg.configSchema.safeParse(settings);
      if (!result.success) {
        this.fail({ location, id: manifest.id, reason: `invalid tools.settings.${manifest.id}: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
        return false;
      }
      settings = result.data;
    }
    const dataDir = path.join(this.deps.dataRoot, manifest.id);
    const artifactsDir = path.join(this.deps.artifactsRoot, manifest.id);
    const pkgLogger = logger.child({ package: manifest.id });
    let contribution: PackageContribution;
    try {
      await mkdir(dataDir, { recursive: true });
      await mkdir(artifactsDir, { recursive: true });
      contribution = await withTimeout(
        Promise.resolve(
          pkg.register({
            manifest,
            config: settings,
            logger: pkgLogger,
            platform: this.deps.platform,
            services: { cache: this.deps.cacheFor(manifest.id), kv: this.deps.kvFor(manifest.id), dataDir, artifactsDir },
          }),
        ),
        config.tools.registerTimeoutMs,
        `${manifest.id}: register() did not finish in ${config.tools.registerTimeoutMs} ms`,
      );
    } catch (error) {
      this.fail({ location, id: manifest.id, reason: `register failed: ${(error as Error).message}` });
      return false;
    }
    const identity = { id: manifest.id, version: manifest.version, capabilities: manifest.capabilities };
    try {
      for (const tool of contribution.tools ?? []) registry.registerTool(identity, tool);
      for (const resource of contribution.resources ?? []) registry.registerResource(identity, resource);
      for (const prompt of contribution.prompts ?? []) registry.registerPrompt(identity, prompt);
    } catch (error) {
      registry.removePackage(manifest.id);
      this.fail({ location, id: manifest.id, reason: (error as Error).message });
      if (pkg.dispose) await pkg.dispose().catch(() => undefined);
      return false;
    }
    if (pkg.dispose) this.disposers.push({ id: manifest.id, dispose: pkg.dispose });
    const loaded: LoadedPackage = {
      id: manifest.id,
      version: manifest.version,
      displayName: manifest.displayName,
      location,
      builtin,
      tools: contribution.tools?.length ?? 0,
      resources: contribution.resources?.length ?? 0,
      prompts: contribution.prompts?.length ?? 0,
    };
    this.loaded.push(loaded);
    this.deps.events.emit("package.loaded", { id: manifest.id, version: manifest.version, tools: loaded.tools });
    logger.info("package loaded", { package: manifest.id, version: manifest.version, tools: loaded.tools, builtin });
    return true;
  }

  private skip(problem: PackageProblem): void {
    this.skipped.push(problem);
    this.deps.logger.info("package skipped", { ...problem });
  }

  private fail(problem: PackageProblem): void {
    this.failed.push(problem);
    this.deps.events.emit("package.failed", { location: problem.location, reason: problem.reason });
    this.deps.logger.error("package failed to load", { ...problem });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
