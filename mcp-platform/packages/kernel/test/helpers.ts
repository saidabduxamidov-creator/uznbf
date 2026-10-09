import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Clock } from "@lmp/core";
import { MemorySink, StructuredLogger, TypedEventBus, type PlatformEvents } from "../src/index.js";

export class FakeClock implements Clock {
  constructor(public value = 1_700_000_000_000) {}
  now(): number {
    return this.value;
  }
  advance(ms: number): void {
    this.value += ms;
  }
}

export function testLogger(level: "trace" | "debug" | "info" = "debug") {
  const sink = new MemorySink();
  return { sink, logger: new StructuredLogger(sink, level) };
}

export function testEvents() {
  const errors: unknown[] = [];
  const bus = new TypedEventBus<PlatformEvents>((_event, error) => errors.push(error));
  return { bus, errors };
}

export async function tempDir(prefix = "lmp-test-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
