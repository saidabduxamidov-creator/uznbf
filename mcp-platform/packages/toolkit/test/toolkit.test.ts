import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { CancelledError, ConflictError, ExternalProcessError, NotFoundError, ValidationError } from "@lmp/core";
import { BIN_DIR_ENV, clearBinaryCache, locateBinary, parseProbeJson, parseRate, runProcess, safeFileName, writeFileAtomic } from "../src/index.js";

const node = process.execPath;

describe("runProcess", () => {
  it("captures output, streams lines and reports failures without a shell", async () => {
    const lines: string[] = [];
    const ok = await runProcess(node, ["-e", "console.log('a\\nb'); console.error('warn')"], { onStdoutLine: (l) => lines.push(l) });
    assert.equal(ok.exitCode, 0);
    assert.deepEqual(lines, ["a", "b"]);
    assert.equal(ok.stderr.trim(), "warn");
    await assert.rejects(runProcess(node, ["-e", "console.error('boom'); process.exit(3)"]), (e: unknown) => {
      assert.ok(e instanceof ExternalProcessError);
      assert.match(e.message, /exit code 3.*boom/);
      return true;
    });
    const literal = await runProcess(node, ["-e", "console.log(process.argv[1])", "a & echo injected"]);
    assert.equal(literal.stdout.trim(), "a & echo injected", "arguments are never interpreted by a shell");
  });

  it("bounds captured output", async () => {
    const r = await runProcess(node, ["-e", "process.stdout.write('x'.repeat(100000))"], { maxOutputBytes: 1000 });
    assert.equal(r.stdout.length, 1000);
    assert.ok(r.stdoutTruncated);
  });

  it("kills the process tree on abort", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const pending = runProcess(node, ["-e", "require('child_process').spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {stdio:'inherit'}); setInterval(()=>{},1000)"], { signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(pending, CancelledError);
    assert.ok(Date.now() - started < 5000);
  });

  it("reports missing executables clearly", async () => {
    await assert.rejects(runProcess(path.join(os.tmpdir(), "definitely-missing-binary"), []), NotFoundError);
  });
});

describe("locateBinary", () => {
  it("uses configured path, bundled dir, then PATH", async () => {
    clearBinaryCache();
    const dir = path.dirname(node);
    const name = path.basename(node);
    assert.equal(await locateBinary(name, { configKey: "k", env: { PATH: dir } }), node);
    assert.equal(await locateBinary(name, { configKey: "k", env: { [BIN_DIR_ENV]: dir, PATH: "" } }), node);
    assert.equal(await locateBinary(name, { configKey: "k", configured: node, env: { PATH: "" } }), node);
    await assert.rejects(locateBinary(name, { configKey: "tools.settings.x.path", configured: "relative/node", env: {} }), ValidationError);
    await assert.rejects(locateBinary("no-such-tool-xyz", { configKey: "tools.settings.x.path", env: { PATH: dir } }), /tools\.settings\.x\.path/);
  });
});

describe("ffprobe parsing", () => {
  it("normalizes streams and ignores cover art as video", () => {
    const info = parseProbeJson(
      {
        format: { format_name: "mov,mp4", duration: "12.5", size: "1000", bit_rate: "640" },
        streams: [
          { index: 0, codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30000/1001", pix_fmt: "yuv420p", side_data_list: [{ rotation: -90 }] },
          { index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, channel_layout: "stereo", tags: { language: "uzb" } },
        ],
      },
      "C:\\a.mp4",
    );
    assert.equal(info.durationSec, 12.5);
    assert.equal(info.streams[0]?.fps, 29.97);
    assert.equal(info.streams[0]?.rotation, -90);
    assert.equal(info.streams[1]?.language, "uzb");
    assert.ok(info.hasVideo && info.hasAudio);
    const mp3 = parseProbeJson({ format: { duration: "3" }, streams: [{ index: 0, codec_type: "audio" }, { index: 1, codec_type: "video", disposition: { attached_pic: 1 } }] }, "x.mp3");
    assert.equal(mp3.hasVideo, false);
    assert.equal(parseRate("0/0"), null);
    assert.equal(parseRate("25"), 25);
  });
});

describe("files", () => {
  it("writes atomically and refuses to replace in exclusive mode", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lmp-files-"));
    try {
      const target = path.join(dir, "a.txt");
      await writeFileAtomic(target, "one", { exclusive: true });
      await assert.rejects(writeFileAtomic(target, "two", { exclusive: true }), (e: unknown) => (e as NodeJS.ErrnoException).code === "EEXIST");
      await writeFileAtomic(target, "three");
      assert.equal(await readFile(target, "utf8"), "three");
      assert.deepEqual(await readdir(dir), ["a.txt"], "no temp files left behind");
      await writeFile(path.join(dir, "keep"), "");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    assert.equal(safeFileName('a<b>:c"d/e\\f|g?h*'), "a_b__c_d_e_f_g_h_");
    assert.equal(safeFileName("CON.txt"), "file_CON.txt");
    assert.equal(safeFileName("trailing. "), "trailing");
    void ConflictError;
  });
});
