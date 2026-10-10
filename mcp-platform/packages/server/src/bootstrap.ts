/**
 * Composition root. Builds every platform service in dependency order, wires events to metrics
 * and persistence, loads tool packages and returns a handle with an idempotent shutdown.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT, type Logger, type ToolPackage } from "@lmp/core";
import {
  AuditRepository,
  ConfigWatcher,
  DiskCache,
  JobQueue,
  JobRepository,
  KeyValueRepository,
  MemoryLruCache,
  MetricsRegistry,
  MultiSink,
  PLATFORM_MIGRATIONS,
  PackageManager,
  PolicyPermissionGate,
  RotatingFileSink,
  SqliteDatabase,
  StderrSink,
  StructuredLogger,
  TieredCache,
  ToolExecutor,
  ToolRegistry,
  TypedEventBus,
  changedSections,
  currentPathEnvironment,
  loadConfig,
  resolvePlatformPaths,
  type LogSink,
  type PackageSource,
  type PlatformConfig,
  type PlatformEvents,
  type PlatformPaths,
} from "@lmp/kernel";
import { McpAdapter } from "./mcp/adapter.js";
import { createPlatformPackage } from "./platform-package.js";

export interface PlatformOptions {
  /** Puts config, data, cache and logs under one root (portable/test mode). */
  readonly dataRoot?: string;
  readonly configFile?: string;
  /** Directories with built-in (trusted) tool packages. Defaults to the bundled tools directory. */
  readonly builtinToolDirs?: readonly string[];
  /**
   * Tool packages compiled into the server (single-file build). When given, the default tool
   * directories are not scanned; configured third-party directories still are.
   */
  readonly builtinPackages?: ReadonlyArray<{ readonly pkg: ToolPackage<unknown>; readonly location: string }>;
  readonly configOverrides?: Record<string, unknown>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Extra log sink (tests). */
  readonly extraLogSink?: LogSink;
}

export interface Platform {
  readonly config: PlatformConfig;
  readonly paths: PlatformPaths;
  readonly configFile: string;
  readonly logger: Logger;
  readonly registry: ToolRegistry;
  readonly packages: PackageManager;
  readonly executor: ToolExecutor;
  readonly adapter: McpAdapter;
  shutdown(reason: string): Promise<void>;
}

const SERVER_INSTRUCTIONS = [
  `${PRODUCT.displayName}: local tools for video editing workflows on this computer.`,
  "Everything runs locally; tools touch only what the user's local permission policy allows.",
  "If a call is denied, explain to the user which permission is missing instead of retrying.",
  "Long operations may return a background job id: fetch the result with platform.jobs.result.",
  "Use platform.health when tools behave unexpectedly.",
].join(" ");

/** Default built-in tools location: <install>/tools, or packages/tools in the source tree. */
export function defaultBuiltinToolDirs(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.resolve(here, "..", "..", "..", "tools"), path.resolve(here, "..", "tools")];
}

export async function createPlatform(options: PlatformOptions = {}): Promise<Platform> {
  const env = options.env ?? process.env;
  const paths = resolvePlatformPaths({ ...currentPathEnvironment(), env }, options.dataRoot);
  // The config directory must exist so the watcher can pick up a config.json created later.
  await mkdir(options.configFile ? path.dirname(path.resolve(options.configFile)) : paths.configDir, { recursive: true });
  const loaded = await loadConfig({
    configDir: paths.configDir,
    env,
    ...(options.configFile ? { file: options.configFile } : {}),
    ...(options.configOverrides ? { overrides: options.configOverrides } : {}),
  });
  const { config } = loaded;

  const sinks: LogSink[] = [new StderrSink(config.logging.stderrLevel)];
  const fileSink = config.logging.file
    ? new RotatingFileSink({ directory: paths.logsDir, fileName: "server.log", maxFileBytes: config.logging.maxFileBytes, maxFiles: config.logging.maxFiles })
    : undefined;
  if (fileSink) sinks.push(fileSink);
  if (options.extraLogSink) sinks.push(options.extraLogSink);
  const sink = new MultiSink(sinks);
  const logger = new StructuredLogger(sink, config.logging.level, { component: "server" });
  logger.info("starting", { version: PRODUCT.version, pid: process.pid, node: process.version, paths, configFile: loaded.file, configFound: loaded.fileExists });

  const cleanups: Array<{ name: string; run: () => void | Promise<void> }> = [];
  const onCleanup = (name: string, run: () => void | Promise<void>) => cleanups.push({ name, run });
  try {
    const events = new TypedEventBus<PlatformEvents>((event, error) => logger.error("event listener failed", { event, error }));
    onCleanup("events", () => events.clear());
    const clock = { now: () => Date.now() };

    const db = await SqliteDatabase.open(path.join(paths.dataDir, "platform.db"));
    onCleanup("database", () => db.close());
    const migrated = db.migrate(PLATFORM_MIGRATIONS);
    if (migrated > 0) logger.info("database migrated", { applied: migrated });
    const audit = new AuditRepository(db, clock);
    const jobs = new JobRepository(db);
    const kv = new KeyValueRepository(db, clock);
    const interrupted = jobs.markOrphansInterrupted(isProcessAlive, clock.now());
    if (interrupted > 0) logger.warn("jobs from a previous run were interrupted", { count: interrupted });
    audit.pruneOlderThan(clock.now() - config.audit.retentionDays * 86_400_000);
    jobs.pruneOlderThan(clock.now() - 30 * 86_400_000);

    const disk = new DiskCache(path.join(paths.cacheDir, "results"), config.cache.diskMaxBytes, clock, logger.child({ component: "cache" }));
    void disk.init();
    const cache = new TieredCache(new MemoryLruCache(config.cache.memoryMaxBytes, config.cache.memoryMaxEntryBytes, clock), disk, config.cache.defaultTtlMs, clock);

    const metrics = new MetricsRegistry();
    onCleanup("metrics", () => metrics.dispose());

    const queue = new JobQueue(
      {
        cpu: config.queue.cpu,
        io: config.queue.io,
        external: config.queue.external,
        host: 1,
        maxQueuedPerLane: 1000,
        retentionMs: config.queue.jobRetentionMs,
        maxRetained: config.queue.maxRetainedJobs,
      },
      clock,
      events,
      logger.child({ component: "queue" }),
    );
    onCleanup("queue", () => queue.shutdown(5000));

    const persistJob = (jobId: string) => {
      const snapshot = queue.get(jobId);
      if (!snapshot) return;
      try {
        jobs.save(snapshot);
      } catch (error) {
        logger.warn("job persistence failed", { jobId, error });
      }
    };
    events.on("job.queued", (e) => persistJob(e.jobId));
    events.on("job.started", (e) => {
      metrics.jobWait.observe(e.waitedMs, { tool: e.tool });
      persistJob(e.jobId);
    });
    events.on("job.finished", (e) => persistJob(e.jobId));
    events.on("permission.decided", (e) => metrics.permissionDecisions.inc({ kind: e.kind, effect: e.effect }));
    events.on("tool.finished", (e) => logger.debug("tool call", { ...e }));

    const gate = new PolicyPermissionGate(config.permissions, process.platform, audit, events, logger.child({ component: "permissions" }), loaded.file);
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(
      { registry, gate, queue, cache, metrics, events, logger: logger.child({ component: "executor" }) },
      { syncWaitMs: config.queue.syncWaitMs, defaultTimeoutMs: config.queue.defaultTimeoutMs },
    );
    onCleanup("executor", () => executor.shutdown());

    const packages = new PackageManager({
      registry,
      config,
      logger: logger.child({ component: "packages" }),
      events,
      cacheFor: (id) => cache.namespaced(id),
      kvFor: (id) => kv.scope(id),
      dataRoot: path.join(paths.dataDir, "packages"),
      artifactsRoot: path.join(paths.cacheDir, "artifacts"),
      platformDataDir: paths.dataDir,
      platform: process.platform,
    });
    onCleanup("packages", () => packages.disposeAll());
    await packages.registerBuiltin(
      createPlatformPackage({
        queue, jobs, audit, cache, metrics, registry,
        packages: () => packages,
        paths: { ...paths },
        configFile: loaded.file,
      }),
      "server",
    );
    for (const { pkg, location } of options.builtinPackages ?? []) await packages.registerBuiltin(pkg, location);
    const sources: PackageSource[] = [
      ...(options.builtinToolDirs ?? (options.builtinPackages ? [] : defaultBuiltinToolDirs())).map((directory) => ({ directory, builtin: true })),
      ...config.tools.directories.map((directory) => ({ directory: path.resolve(paths.configDir, directory), builtin: false })),
    ];
    await packages.discover(sources);
    const report = packages.report();
    logger.info("packages ready", { loaded: report.loaded.map((p) => `${p.id}@${p.version}`), skipped: report.skipped.length, failed: report.failed.length, tools: registry.listTools().length });

    const watcher = new ConfigWatcher(
      { configDir: paths.configDir, env, file: loaded.file, ...(options.configOverrides ? { overrides: options.configOverrides } : {}) },
      config,
      (next, previous) => {
        const changed = changedSections(previous, next);
        if (changed.includes("permissions")) void gate.update(next.permissions);
        if (changed.includes("queue")) executor.updateOptions({ syncWaitMs: next.queue.syncWaitMs, defaultTimeoutMs: next.queue.defaultTimeoutMs });
        const restart = changed.filter((s) => s !== "permissions" && s !== "queue");
        logger.info("configuration reloaded", { changed, ...(restart.length ? { restartRequiredFor: restart } : {}) });
        events.emit("config.reloaded", { changed });
      },
      (error) => {
        logger.error("configuration reload rejected; keeping previous configuration", { error });
        events.emit("config.reloadFailed", { message: (error as Error).message });
      },
      logger.child({ component: "config" }),
    );
    watcher.start();
    onCleanup("config watcher", () => watcher.stop());

    const adapter = new McpAdapter({ registry, executor, logger: logger.child({ component: "mcp" }), instructions: SERVER_INSTRUCTIONS });
    onCleanup("mcp", () => adapter.close());

    let shuttingDown: Promise<void> | undefined;
    const shutdown = (reason: string): Promise<void> => {
      shuttingDown ??= (async () => {
        logger.info("shutting down", { reason });
        for (const cleanup of [...cleanups].reverse()) {
          try {
            await cleanup.run();
          } catch (error) {
            logger.warn("cleanup step failed", { step: cleanup.name, error });
          }
        }
        logger.info("stopped");
        await sink.close();
      })();
      return shuttingDown;
    };

    return { config, paths, configFile: loaded.file, logger, registry, packages, executor, adapter, shutdown };
  } catch (error) {
    logger.fatal("startup failed", { error });
    for (const cleanup of [...cleanups].reverse()) {
      try {
        await cleanup.run();
      } catch {
        /* best effort while failing */
      }
    }
    await sink.close();
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
