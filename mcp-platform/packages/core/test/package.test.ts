import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { TOOL_NAME_PATTERN, ToolPackageManifestSchema, defineTool, text } from "../src/index.js";

describe("tool package contract", () => {
  it("accepts a valid manifest and rejects unknown keys", () => {
    const ok = ToolPackageManifestSchema.safeParse({
      id: "ffmpeg", version: "1.0.0", displayName: "FFmpeg", description: "Media processing",
      platforms: ["win32"], capabilities: ["fs.read", "process.spawn"],
    });
    assert.ok(ok.success);
    const extra = ToolPackageManifestSchema.safeParse({ ...(ok.success ? ok.data : {}), main: "x" });
    assert.equal(extra.success, false);
    const badCap = ToolPackageManifestSchema.safeParse({ ...(ok.success ? ok.data : {}), capabilities: ["root"] });
    assert.equal(badCap.success, false);
  });

  it("tool names are namespaced", () => {
    assert.ok(TOOL_NAME_PATTERN.test("ffmpeg.probe"));
    assert.ok(TOOL_NAME_PATTERN.test("premiere.timeline.get_info"));
    assert.ok(!TOOL_NAME_PATTERN.test("probe"));
    assert.ok(!TOOL_NAME_PATTERN.test("FFmpeg.probe"));
    assert.ok(!TOOL_NAME_PATTERN.test("a.b c"));
  });

  it("defineTool keeps the definition intact", async () => {
    const tool = defineTool({
      name: "demo.echo", title: "Echo", description: "Echoes",
      input: z.object({ value: z.string() }),
      annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      execution: { resourceClass: "inline" },
      capabilities: () => [],
      run: async (input) => ({ content: [text(input.value)] }),
    });
    const r = await tool.run({ value: "hi" }, undefined as never);
    assert.deepEqual(r.content, [{ type: "text", text: "hi" }]);
  });
});
