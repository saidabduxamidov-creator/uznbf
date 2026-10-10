/**
 * Command-line implementation shared by the development entry (cli.ts) and the bundled server.
 *
 * stdout carries JSON-RPC only. Every console method is redirected to stderr as soon as this module
 * is evaluated, before any tool package code runs, so a stray console.log in any dependency or tool
 * package cannot corrupt the protocol.
 */
import { parseArgs } from "node:util";
import { PRODUCT, type LogLevel, type ToolPackage } from "@lmp/core";
import { currentPathEnvironment, isLogLevel, resolvePlatformPaths } from "@lmp/kernel";

protectStdout();
filterExperimentalWarnings();

/** Tool packages compiled into a bundled server (see scripts/bundle.mjs). */
export interface BundledPackage {
  readonly pkg: ToolPackage<unknown>;
  readonly location: string;
}

async function main(bundled: readonly BundledPackage[]): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${usage()}`);
    return 2;
  }
  const { values } = args;
  if (values.help) {
    process.stderr.write(usage());
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${PRODUCT.version}\n`);
    return 0;
  }
  if (values["print-paths"]) {
    process.stdout.write(`${JSON.stringify(resolvePlatformPaths(currentPathEnvironment(), values["data-root"]), null, 2)}\n`);
    return 0;
  }
  const level = values["log-level"];
  if (level !== undefined && !isLogLevel(level)) {
    process.stderr.write(`Invalid --log-level "${level}".\n`);
    return 2;
  }

  const { createPlatform } = await import("./bootstrap.js");
  const platform = await createPlatform({
    ...(values["data-root"] ? { dataRoot: values["data-root"] } : {}),
    ...(values.config ? { configFile: values.config } : {}),
    ...(values["tools-dir"]?.length ? { builtinToolDirs: values["tools-dir"] } : {}),
    ...(bundled.length ? { builtinPackages: bundled } : {}),
    ...(level ? { configOverrides: { logging: { level: level as LogLevel } } } : {}),
  });

  if (values.check) {
    const report = platform.packages.report();
    const tools = platform.registry.listTools().map((t) => t.definition.name);
    process.stdout.write(`${JSON.stringify({ version: PRODUCT.version, configFile: platform.configFile, paths: platform.paths, packages: report, tools }, null, 2)}\n`);
    await platform.shutdown("check finished");
    return report.failed.length === 0 ? 0 : 1;
  }

  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const transport = new StdioServerTransport();
  const stop = (reason: string, code = 0) => {
    void platform.shutdown(reason).finally(() => {
      process.exitCode = code;
      // Give pending stderr writes a moment, then exit even if a handle is stuck.
      setTimeout(() => process.exit(code), 250).unref();
    });
  };
  transport.onclose = () => stop("transport closed");
  process.stdin.on("end", () => stop("client disconnected (stdin ended)"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    try {
      process.on(signal, () => stop(`signal ${signal}`));
    } catch {
      /* signal not supported on this platform */
    }
  }
  process.on("uncaughtException", (error) => {
    platform.logger.fatal("uncaught exception", { error });
    stop("uncaught exception", 1);
  });
  process.on("unhandledRejection", (reason) => {
    platform.logger.error("unhandled promise rejection", { error: reason });
  });

  await platform.adapter.connect(transport);
  platform.logger.info("ready", { transport: "stdio", tools: platform.registry.listTools().length });
  return -1; // keep running
}

function parse() {
  return parseArgs({
    options: {
      config: { type: "string" },
      "data-root": { type: "string" },
      "tools-dir": { type: "string", multiple: true },
      "log-level": { type: "string" },
      check: { type: "boolean", default: false },
      "print-paths": { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
}

function usage(): string {
  return [
    `${PRODUCT.displayName} ${PRODUCT.version} - local MCP server for Claude Desktop and ChatGPT Desktop`,
    "",
    "Usage: lmp-server [--config <file>] [--data-root <dir>] [--tools-dir <dir>]... [--log-level <level>]",
    "       lmp-server --check | --print-paths | --version | --help",
    "",
  ].join("\n");
}

function protectStdout(): void {
  const toStderr = (...parts: unknown[]) => {
    process.stderr.write(`${parts.map((p) => (typeof p === "string" ? p : safeInspect(p))).join(" ")}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
  console.dir = (value: unknown) => toStderr(value);
}

function safeInspect(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** node:sqlite is stable in practice but still flagged experimental on Node 22; keep stderr clean. */
function filterExperimentalWarnings(): void {
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if ((type === "ExperimentalWarning" || (warning as Error).name === "ExperimentalWarning") && /SQLite/i.test(message)) return;
    (original as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

/** Runs the command line. The bundled build passes its compiled-in tool packages. */
export function runCli(bundled: readonly BundledPackage[] = []): void {
  main(bundled).then(
    (code) => {
      if (code >= 0) process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${PRODUCT.displayName} failed to start: ${(error as Error)?.message ?? String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
