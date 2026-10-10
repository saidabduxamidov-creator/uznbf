#!/usr/bin/env node
/**
 * Entry point launched by Claude Desktop and ChatGPT Desktop (stdio transport).
 *
 *   lmp-server                      run the MCP server on stdin/stdout
 *   lmp-server --check              load configuration and packages, print a JSON report, exit
 *   lmp-server --print-paths        print the per-user directories and exit
 *   options: --config <file> --data-root <dir> --tools-dir <dir> (repeatable) --log-level <level>
 */
import { runCli } from "./cli-main.js";

runCli();
