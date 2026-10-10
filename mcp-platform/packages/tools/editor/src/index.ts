/**
 * Editor tool package: Premiere Pro, After Effects and DaVinci Resolve through the panel bridge.
 *
 * Every operation is executed by the panel's existing host functions (gc_*) and modules, so the
 * editing logic exists exactly once. Tools take an optional "host"; when only one editor is
 * connected it is chosen automatically.
 */
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  NotFoundError,
  ValidationError,
  defineTool,
  defineToolPackage,
  image,
  resourceLink,
  text,
  throwIfAborted,
  type CapabilityRequest,
  type ContentPart,
  type ToolAnnotations,
} from "@lmp/core";
import { canonicalizePath, locateFfmpeg, runFfmpeg } from "@lmp/toolkit";
import { z } from "zod";
import { BridgeClient, HOST_IDS, HOST_NAMES, type HostId } from "./bridge.js";

const SettingsSchema = z.object({ ffmpegPath: z.string().optional(), ffprobePath: z.string().optional() }).strict();

const HOST = z.enum(HOST_IDS).optional().describe("premiere | aftereffects | resolve. Optional when only one editor is open.");
const SECONDS = z.number().min(0).max(24 * 3600);
const TRACKS = z.array(z.number().int().min(0).max(99)).max(32).optional().describe("Speech audio tracks, 0 = A1. Default: the tracks selected in the panel.");
const READ: ToolAnnotations = { readOnly: true, destructive: false, idempotent: true, openWorld: false };
const EDIT: ToolAnnotations = { readOnly: false, destructive: false, idempotent: false, openWorld: false };
const DESTRUCTIVE: ToolAnnotations = { readOnly: false, destructive: true, idempotent: false, openWorld: false };
const hostCap = (host: HostId | undefined, reason: string): CapabilityRequest => ({ kind: "host", target: host ?? "editor", reason });
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;

interface SequenceInfo {
  readonly name: string;
  readonly duration: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly playhead: number;
  readonly inPoint?: number;
  readonly outPoint?: number;
  readonly hasRange?: boolean;
  readonly videoTracks?: number;
  readonly clipCount?: number;
  readonly audioTracks?: ReadonlyArray<{ index: number; name: string; clips: number; muted?: boolean; locked?: boolean; coverage?: number }>;
}

interface EditContext {
  readonly clips: ReadonlyArray<{ track: number; start: number; end: number; name: string; path?: string }>;
  readonly source: string;
  readonly playhead: number;
}

export default defineToolPackage({
  manifest: {
    id: "editor",
    version: "0.1.0",
    displayName: "Video editors",
    description: "Read and edit the open Premiere Pro, After Effects or DaVinci Resolve timeline through the local panel bridge.",
    platforms: ["win32", "darwin", "linux"],
    capabilities: ["host", "fs.read", "process.spawn"],
  },
  configSchema: SettingsSchema,
  register: ({ platformDataDir, services, config }) => {
    const bridge = new BridgeClient(path.join(platformDataDir, "bridges"));
    const call = async <T>(requested: HostId | undefined, method: string, args: unknown, timeoutMs: number, signal: AbortSignal): Promise<{ host: HostId; data: T }> => {
      const host = await bridge.resolveHost(requested);
      return { host, data: await bridge.call<T>(host, method, args, { timeoutMs, signal }) };
    };
    const speech = async (host: HostId | undefined, tracks: readonly number[] | undefined, signal: AbortSignal): Promise<{ host: HostId; tracks: number[] }> => {
      if (tracks?.length) return { host: await bridge.resolveHost(host), tracks: [...tracks] };
      const panel = await call<number[]>(host, "panel.speechTracks", {}, 10_000, signal);
      if (panel.data.length) return { host: panel.host, tracks: panel.data };
      const info = await call<SequenceInfo>(panel.host, "gc_getSequenceInfo", [], 20_000, signal);
      const guess = (info.data.audioTracks ?? []).filter((t) => !t.muted && (t.coverage ?? 0) > 0.2).map((t) => t.index);
      if (!guess.length) throw new ValidationError("Could not tell which audio tracks contain speech; pass speechTracks (0 = A1).");
      return { host: panel.host, tracks: guess.slice(0, 2) };
    };

    return {
      tools: [
        defineTool({
          name: "editor.list_hosts",
          title: "Connected editors",
          description: "Which editing applications (Premiere Pro, After Effects, DaVinci Resolve) are open with the panel connected.",
          input: z.object({}).strict(),
          annotations: READ,
          execution: { resourceClass: "inline", timeoutMs: 15_000 },
          capabilities: () => [],
          run: async (_input, ctx) => {
            const hosts = [];
            for (const d of await bridge.available()) {
              try {
                const conn = await bridge.connection(d.host);
                const info = await conn.call("gc_ping", [], { timeoutMs: 5000, signal: ctx.signal });
                hosts.push({ host: d.host, name: HOST_NAMES[d.host], panelVersion: conn.welcome?.panelVersion ?? "", application: info });
              } catch (error) {
                hosts.push({ host: d.host, name: HOST_NAMES[d.host], error: (error as Error).message });
              }
            }
            return {
              content: [text(hosts.length ? hosts.map((h) => `${h.name}: ${"error" in h ? `not responding (${h.error})` : `connected, panel ${h.panelVersion}`}`).join("\n") : "No editor connected. Open Premiere Pro, After Effects or DaVinci Resolve with the panel.")],
              structured: { hosts },
            };
          },
        }),

        defineTool({
          name: "editor.get_timeline",
          title: "Timeline overview",
          description: "Active sequence/composition/timeline: name, duration, fps, resolution, playhead, in/out range and audio tracks (index 0 = A1).",
          input: z.object({ host: HOST }).strict(),
          annotations: READ,
          execution: { resourceClass: "host:editor", timeoutMs: 30_000 },
          capabilities: (input) => [hostCap(input.host, "read the timeline")],
          run: async (input, ctx) => {
            const { host, data } = await call<SequenceInfo>(input.host, "gc_getSequenceInfo", [], 20_000, ctx.signal);
            const tracks = (data.audioTracks ?? []).map((t) => `A${t.index + 1} "${t.name}": ${t.clips} clips${t.muted ? ", muted" : ""}${t.locked ? ", locked" : ""}`).join("\n");
            return {
              content: [text(`${HOST_NAMES[host]} · "${data.name}": ${fmt(data.duration)} at ${data.fps.toFixed(3)} fps, ${data.width}x${data.height}, playhead ${fmt(data.playhead)}${data.hasRange ? `, in/out ${fmt(data.inPoint ?? 0)}–${fmt(data.outPoint ?? 0)}` : ""}.\n${tracks}`)],
              structured: { host, ...data },
            };
          },
        }),

        defineTool({
          name: "editor.get_selection",
          title: "Selected clips",
          description: "Clips selected on the timeline (or, if none, the clip under the playhead) with track, start/end, source file and current scale/position/rotation/opacity.",
          input: z.object({ host: HOST }).strict(),
          annotations: READ,
          execution: { resourceClass: "host:editor", timeoutMs: 30_000 },
          capabilities: (input) => [hostCap(input.host, "read the selection")],
          run: async (input, ctx) => {
            const { host, data } = await call<EditContext>(input.host, "gc_getEditContext", [], 20_000, ctx.signal);
            return {
              content: [text(data.clips.length ? `${data.clips.length} clip(s) from ${data.source}:\n${data.clips.map((c) => `V${c.track + 1} ${fmt(c.start)}–${fmt(c.end)} ${c.name}`).join("\n")}` : "Nothing selected and no clip under the playhead.")],
              structured: { host, ...data },
            };
          },
        }),

        defineTool({
          name: "editor.set_playhead",
          title: "Move playhead",
          description: "Moves the playhead to a time in seconds.",
          input: z.object({ host: HOST, seconds: SECONDS }).strict(),
          annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
          execution: { resourceClass: "host:editor", timeoutMs: 15_000 },
          capabilities: (input) => [hostCap(input.host, "move the playhead")],
          run: async (input, ctx) => {
            const { host } = await call(input.host, "gc_setPlayhead", [input.seconds], 10_000, ctx.signal);
            return { content: [text(`Playhead at ${fmt(input.seconds)} in ${HOST_NAMES[host]}.`)], structured: { host, seconds: input.seconds } };
          },
        }),

        defineTool({
          name: "editor.view_frames",
          title: "Look at the timeline",
          description: "Renders timeline frames at the given times (seconds) and returns them as images, so the assistant sees exactly what the viewer shows (all layers, effects and text).",
          input: z.object({ host: HOST, times: z.array(SECONDS).min(1).max(12), width: z.number().int().min(160).max(1920).default(768) }).strict(),
          annotations: READ,
          execution: { resourceClass: "host:editor", timeoutMs: 5 * 60_000 },
          capabilities: (input) => [hostCap(input.host, "render timeline frames"), { kind: "process.spawn", target: "ffmpeg", reason: "resize frames" }],
          run: async (input, ctx) => {
            const dir = path.join(services.artifactsDir, "timeline-frames", `${Date.now()}`);
            await mkdir(dir, { recursive: true });
            const { host, data } = await call<{ files: string[] }>(input.host, "gc_exportFrames", [path.join(dir, "f"), input.times], 3 * 60_000, ctx.signal);
            if (!data.files.length) throw new NotFoundError("The editor did not export any frame.");
            const ffmpeg = await locateFfmpeg(config, "tools.settings.editor").then((b) => b.ffmpeg, () => undefined);
            const content: ContentPart[] = [];
            for (const [i, file] of data.files.entries()) {
              throwIfAborted(ctx.signal);
              content.push(text(`Frame at ${fmt(input.times[i] ?? 0)}:`));
              if (ffmpeg) {
                const jpg = `${file}.jpg`;
                await runFfmpeg(ffmpeg, ["-y", "-i", file, "-vf", `scale='min(${input.width},iw)':-2`, "-q:v", "3", jpg], { signal: ctx.signal });
                content.push(image((await readFile(jpg)).toString("base64"), "image/jpeg"));
              } else if ((await stat(file)).size <= 4 * 1024 * 1024) {
                content.push(image((await readFile(file)).toString("base64"), "image/png"));
              } else {
                content.push(resourceLink(`file:///${file.replace(/\\/g, "/")}`, path.basename(file), { mimeType: "image/png", description: "Frame too large to inline; install FFmpeg to resize." }));
              }
            }
            await rm(dir, { recursive: true, force: true }).catch(() => undefined);
            return { content, structured: { host, times: input.times } };
          },
        }),

        defineTool({
          name: "editor.apply_cuts",
          title: "Cut out ranges (ripple delete)",
          description:
            "Removes time ranges from the timeline and closes the gaps (ripple delete) on all unlocked tracks, keeping audio and video in sync. Use with video.detect_silence to remove pauses. Times are timeline seconds.",
          input: z.object({
            host: HOST,
            ranges: z.array(z.object({ start: SECONDS, end: SECONDS }).refine((r) => r.end > r.start + 0.02, { message: "end must be after start" })).min(1).max(2000),
            speechTracks: TRACKS,
          }).strict(),
          annotations: DESTRUCTIVE,
          execution: { resourceClass: "host:editor", timeoutMs: 15 * 60_000 },
          capabilities: (input) => [hostCap(input.host, "cut the timeline")],
          run: async (input, ctx) => {
            const { host, tracks } = await speech(input.host, input.speechTracks, ctx.signal);
            const ranges = [...input.ranges].sort((a, b) => a.start - b.start).map((r) => [r.start, r.end]);
            const { data } = await call<{ applied: number; seconds?: number }>(host, "gc_applyCuts", [ranges, tracks], 10 * 60_000, ctx.signal);
            return { content: [text(`${HOST_NAMES[host]}: ${data.applied} cut(s), ${(data.seconds ?? 0).toFixed(1)} s removed. Undo is available in the editor (Ctrl+Z).`)], structured: { host, ...data } };
          },
        }),

        defineTool({
          name: "editor.apply_zooms",
          title: "Punch-in zooms",
          description: "Adds smooth punch-in zooms on the speaking clip at the given times (scale 102-160 %, held for holdSec).",
          input: z.object({
            host: HOST,
            zooms: z.array(z.object({ time: SECONDS, scale: z.number().min(102).max(160).default(115), holdSec: z.number().min(0.5).max(8).default(2) })).min(1).max(500),
            speechTracks: TRACKS,
          }).strict(),
          annotations: EDIT,
          execution: { resourceClass: "host:editor", timeoutMs: 5 * 60_000 },
          capabilities: (input) => [hostCap(input.host, "animate clips")],
          run: async (input, ctx) => {
            const { host, tracks } = await speech(input.host, input.speechTracks, ctx.signal);
            const zooms = input.zooms.map((z) => [z.time, z.scale, z.holdSec]);
            const { data } = await call<{ applied: number; skipped: number; errors?: string[] }>(host, "gc_applyZooms", [zooms, tracks], 2 * 60_000, ctx.signal);
            return { content: [text(`${HOST_NAMES[host]}: ${data.applied} zoom(s) applied, ${data.skipped} skipped.${data.errors?.length ? ` ${data.errors.join("; ")}` : ""}`)], structured: { host, ...data } };
          },
        }),

        defineTool({
          name: "editor.motion_presets",
          title: "Motion presets",
          description: "Ready-made camera/motion animations (zoom in/out, Ken Burns, shake, punch, slide…) that can be applied to the selected clips.",
          input: z.object({ host: HOST }).strict(),
          annotations: READ,
          execution: { resourceClass: "host:editor", timeoutMs: 15_000 },
          capabilities: (input) => [hostCap(input.host, "list presets")],
          run: async (input, ctx) => {
            const { data } = await call<Array<{ id: string; name: string; description: string }>>(input.host, "panel.motionPresets", {}, 10_000, ctx.signal);
            return { content: [text(data.map((p) => `${p.id}: ${p.name}${p.description ? ` - ${p.description}` : ""}`).join("\n"))], structured: { presets: data } };
          },
        }),

        defineTool({
          name: "editor.apply_motion_preset",
          title: "Animate selected clips",
          description: "Applies a motion preset (see editor.motion_presets) to the selected clips, or the clip under the playhead.",
          input: z.object({ host: HOST, preset: z.string().min(1).max(64), strength: z.number().min(102).max(200).default(115).describe("Scale % for zoom-type presets") }).strict(),
          annotations: EDIT,
          execution: { resourceClass: "host:editor", timeoutMs: 2 * 60_000 },
          capabilities: (input) => [hostCap(input.host, "animate clips")],
          run: async (input, ctx) => {
            const { host, data } = await call<{ clips: number; applied: number; keys: number; errors: string[] }>(input.host, "panel.applyMotionPreset", { preset: input.preset, strength: input.strength }, 90_000, ctx.signal);
            return { content: [text(`${HOST_NAMES[host]}: "${input.preset}" on ${data.applied}/${data.clips} clip(s) (${data.keys} keyframes).${data.errors.length ? ` ${data.errors.join("; ")}` : ""}`)], structured: { host, ...data } };
          },
        }),

        defineTool({
          name: "editor.apply_motion",
          title: "Keyframe animation",
          description:
            'Sets keyframes on clips. Each op: {track (0 = V1), start (clip start, s), prop: scale|position|rotation|opacity|anchor, mode: rel|abs, keys: [[timelineSec, value], ...]}. rel: scale/opacity in % of the current value, rotation in degrees added, position [dx,dy] as fraction of the frame. abs: position [x,y] as fraction (0.5,0.5 = centre).',
          input: z.object({
            host: HOST,
            ops: z.array(z.object({
              track: z.number().int().min(0).max(99),
              start: SECONDS,
              prop: z.enum(["scale", "position", "rotation", "opacity", "anchor"]),
              mode: z.enum(["rel", "abs"]),
              keys: z.array(z.tuple([SECONDS, z.union([z.number(), z.tuple([z.number(), z.number()])])])).min(1).max(240),
            }).strict()).min(1).max(200),
          }).strict(),
          annotations: EDIT,
          execution: { resourceClass: "host:editor", timeoutMs: 3 * 60_000 },
          capabilities: (input) => [hostCap(input.host, "animate clips")],
          run: async (input, ctx) => {
            const { host, data } = await call<{ applied: number; keys: number; errors?: string[] }>(input.host, "gc_applyMotion", [input.ops], 2 * 60_000, ctx.signal);
            return { content: [text(`${HOST_NAMES[host]}: ${data.applied} op(s), ${data.keys} keyframes.${data.errors?.length ? ` ${data.errors.join("; ")}` : ""}`)], structured: { host, ...data } };
          },
        }),

        defineTool({
          name: "editor.reset_motion",
          title: "Remove animation",
          description: "Removes scale/position/rotation/opacity keyframes from the given clips, or from the selected clips when none are given.",
          input: z.object({ host: HOST, clips: z.array(z.object({ track: z.number().int().min(0).max(99), start: SECONDS })).max(500).optional() }).strict(),
          annotations: DESTRUCTIVE,
          execution: { resourceClass: "host:editor", timeoutMs: 2 * 60_000 },
          capabilities: (input) => [hostCap(input.host, "remove animation")],
          run: async (input, ctx) => {
            let host = await bridge.resolveHost(input.host);
            let targets = input.clips?.map((c) => [c.track, c.start]);
            if (!targets) {
              const sel = await call<EditContext>(host, "gc_getEditContext", [], 20_000, ctx.signal);
              host = sel.host;
              targets = sel.data.clips.map((c) => [c.track, c.start]);
            }
            if (!targets.length) throw new ValidationError("No clips selected.");
            const { data } = await call<Record<string, unknown>>(host, "gc_resetMotion", [targets], 60_000, ctx.signal);
            return { content: [text(`${HOST_NAMES[host]}: animation removed from ${targets.length} clip(s).`)], structured: { host, ...data } };
          },
        }),

        defineTool({
          name: "editor.sound_library",
          title: "Sound effects library",
          description: "The panel's built-in sound effects (whoosh, hits, risers, UI, gym…) with ids for editor.insert_sound.",
          input: z.object({ host: HOST, folder: z.string().max(80).optional() }).strict(),
          annotations: READ,
          execution: { resourceClass: "host:editor", timeoutMs: 60_000 },
          capabilities: (input) => [hostCap(input.host, "list sound effects")],
          run: async (input, ctx) => {
            const { data } = await call<Array<{ id: string; folder: string; name: string; duration: number }>>(input.host, "panel.sounds", {}, 50_000, ctx.signal);
            const items = input.folder ? data.filter((s) => s.folder.toLowerCase() === input.folder?.toLowerCase()) : data;
            const folders = [...new Set(data.map((s) => s.folder))];
            return { content: [text(`${items.length} sounds${input.folder ? ` in ${input.folder}` : ` in ${folders.length} folders (${folders.join(", ")})`}:\n${items.slice(0, 300).map((s) => `${s.id} (${s.duration.toFixed(2)} s)`).join("\n")}`)], structured: { sounds: items, folders } };
          },
        }),

        defineTool({
          name: "editor.insert_sound",
          title: "Add sound effect",
          description: "Places a library sound effect on a free audio track at a time (default: playhead), avoiding the speech tracks.",
          input: z.object({ host: HOST, id: z.string().min(1).max(300), at: SECONDS.optional(), track: z.number().int().min(0).max(99).optional() }).strict(),
          annotations: EDIT,
          execution: { resourceClass: "host:editor", timeoutMs: 60_000 },
          capabilities: (input) => [hostCap(input.host, "add a sound effect")],
          run: async (input, ctx) => {
            const { host, data } = await call<Record<string, unknown>>(input.host, "panel.insertSound", { id: input.id, at: input.at, track: input.track }, 50_000, ctx.signal);
            return { content: [text(`${HOST_NAMES[host]}: "${input.id}" placed${input.at !== undefined ? ` at ${fmt(input.at)}` : " at the playhead"}.`)], structured: { host, ...data } };
          },
        }),

        defineTool({
          name: "editor.insert_audio_file",
          title: "Add an audio file",
          description: "Places any local audio file (music, voice-over, sound) on a free audio track at a time (default: playhead).",
          input: z.object({ host: HOST, path: z.string().min(1).max(32_767), at: SECONDS.optional(), track: z.number().int().min(0).max(99).optional() }).strict(),
          annotations: EDIT,
          execution: { resourceClass: "host:editor", timeoutMs: 60_000 },
          capabilities: (input) => [hostCap(input.host, "add audio"), { kind: "fs.read", target: input.path, reason: "import audio into the editor" }],
          run: async (input, ctx) => {
            const file = await canonicalizePath(input.path, { platform: process.platform });
            if (!(await stat(file).catch(() => undefined))?.isFile()) throw new NotFoundError(`File not found: ${file}`);
            const { host, tracks } = await speech(input.host, undefined, ctx.signal).catch(async () => ({ host: await bridge.resolveHost(input.host), tracks: [] as number[] }));
            const { data } = await call<Record<string, unknown>>(host, "gc_insertSound", [file, input.track ?? -1, input.at ?? -1, tracks], 50_000, ctx.signal);
            return { content: [text(`${HOST_NAMES[host]}: ${path.basename(file)} placed.`)], structured: { host, ...data } };
          },
        }),

        defineTool({
          name: "editor.import_subtitles",
          title: "Import subtitles",
          description: "Imports an .srt file as captions (Premiere/Resolve subtitle track; After Effects text layers).",
          input: z.object({ host: HOST, path: z.string().min(1).max(32_767) }).strict(),
          annotations: EDIT,
          execution: { resourceClass: "host:editor", timeoutMs: 3 * 60_000 },
          capabilities: (input) => [hostCap(input.host, "import subtitles"), { kind: "fs.read", target: input.path, reason: "read subtitles" }],
          run: async (input, ctx) => {
            const file = await canonicalizePath(input.path, { platform: process.platform });
            if (path.extname(file).toLowerCase() !== ".srt") throw new ValidationError("Only .srt files can be imported.");
            if (!(await stat(file).catch(() => undefined))?.isFile()) throw new NotFoundError(`File not found: ${file}`);
            const { host, data } = await call<Record<string, unknown>>(input.host, "gc_importSrt", [file], 2 * 60_000, ctx.signal);
            return { content: [text(`${HOST_NAMES[host]}: subtitles imported from ${path.basename(file)}.`)], structured: { host, ...data } };
          },
        }),

        defineTool({
          name: "editor.export_audio",
          title: "Export timeline audio",
          description: "Renders the speech tracks of the timeline (whole timeline or in/out range) to a WAV file in the platform's artifacts folder, e.g. for transcription or silence detection. Times in the file start at the returned offset.",
          input: z.object({ host: HOST, speechTracks: TRACKS, useInOut: z.boolean().default(false) }).strict(),
          annotations: READ,
          execution: { resourceClass: "host:editor", longRunning: true, timeoutMs: 35 * 60_000 },
          capabilities: (input) => [hostCap(input.host, "export audio")],
          run: async (input, ctx) => {
            const host = await bridge.resolveHost(input.host);
            const output = path.join(services.artifactsDir, "timeline-audio", `${host}_${Date.now()}.wav`);
            ctx.progress({ progress: 0, total: 1, message: `exporting audio from ${HOST_NAMES[host]}` });
            const { data } = await call<{ path: string; offset: number }>(host, "panel.exportAudio", { output, tracks: input.speechTracks, useInOut: input.useInOut }, 30 * 60_000, ctx.signal);
            return { content: [text(`Timeline audio exported to ${data.path} (timeline offset ${data.offset.toFixed(2)} s).`)], structured: { host, path: data.path, offset: data.offset } };
          },
        }),

        defineTool({
          name: "editor.text_templates",
          title: "Text and logo templates",
          description: "Animated text, plates, gym titles, 3D promo blocks, 3D liquid text and 3D logo templates of the panel (ids for editor.insert_text).",
          input: z.object({ host: HOST, kind: z.enum(["2d", "plate", "gym", "3d"]).optional() }).strict(),
          annotations: READ,
          execution: { resourceClass: "host:editor", timeoutMs: 15_000 },
          capabilities: (input) => [hostCap(input.host, "list templates")],
          run: async (input, ctx) => {
            const { data } = await call<Array<{ id: string; kind: string; name: string; description: string; logo: boolean }>>(input.host, "panel.textTemplates", {}, 10_000, ctx.signal);
            const list = input.kind ? data.filter((t) => t.kind === input.kind) : data;
            return { content: [text(list.map((t) => `${t.id} [${t.kind}${t.logo ? ", logo" : ""}]: ${t.name} - ${t.description}`).join("\n"))], structured: { templates: list } };
          },
        }),

        defineTool({
          name: "editor.insert_text",
          title: "Add animated text / logo",
          description:
            'Renders a template (see editor.text_templates) with your text and places it above the clips at the playhead. insertMode "native" builds editable layers where the host supports it (After Effects layers, Resolve Fusion); "png" places rendered frames.',
          input: z.object({
            host: HOST,
            template: z.string().min(1).max(64),
            text: z.string().max(400).optional().describe("Use \\n for line breaks"),
            sub: z.string().max(200).optional(),
            duration: z.number().min(0.5).max(30).optional(),
            x: z.number().min(0).max(1).optional().describe("Horizontal centre as fraction of the frame"),
            y: z.number().min(0).max(1).optional().describe("Vertical centre as fraction of the frame"),
            size: z.number().min(0.01).max(0.5).optional().describe("Text height as fraction of the frame height"),
            color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
            color2: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
            accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
            font: z.string().max(80).optional(),
            insertMode: z.enum(["native", "png"]).default("native"),
          }).strict(),
          annotations: EDIT,
          execution: { resourceClass: "host:editor", longRunning: true, timeoutMs: 15 * 60_000 },
          capabilities: (input) => [hostCap(input.host, "add a title")],
          run: async (input, ctx) => {
            const { host: requested, template, insertMode, ...rest } = input;
            const overrides = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
            ctx.progress({ progress: 0, total: 1, message: "rendering title" });
            const { host, data } = await call<{ track: number; seconds: number; mode: string; message: string }>(requested, "panel.insertText", { template, overrides, insertMode }, 12 * 60_000, ctx.signal);
            return { content: [text(`${HOST_NAMES[host]}: ${data.message}`)], structured: { host, ...data } };
          },
        }),

        defineTool({
          name: "editor.color_presets",
          title: "Colour looks",
          description: "Colour grading looks available for DaVinci Resolve (natural, cinema teal & orange, warm, cool…).",
          input: z.object({ host: HOST }).strict(),
          annotations: READ,
          execution: { resourceClass: "host:editor", timeoutMs: 15_000 },
          capabilities: (input) => [hostCap(input.host, "list colour looks")],
          run: async (input, ctx) => {
            const { data } = await call<Array<{ id: string; name: string; description: string }>>(input.host, "panel.colorPresets", {}, 10_000, ctx.signal);
            return { content: [text(data.map((p) => `${p.id}: ${p.name} - ${p.description}`).join("\n"))], structured: { presets: data } };
          },
        }),

        defineTool({
          name: "editor.apply_color",
          title: "Colour grade (Resolve)",
          description:
            'Grades clips in DaVinci Resolve with a look preset or custom look values, plus per-clip automatic balance from each clip\'s frame. scope: "playhead" (clip under playhead), "track" or "all". Written as a separate colour version, so it can be reverted. Custom look fields: exposure, temperature, tint, contrast, saturation, vibrance, lift/gamma/gain [r,g,b], shadow_hue, shadow_amount, highlight_hue, highlight_amount, fade, highlight_rolloff, monochrome.',
          input: z.object({
            host: HOST,
            scope: z.enum(["playhead", "track", "all"]).default("playhead"),
            preset: z.string().max(40).optional(),
            look: z.record(z.string(), z.union([z.number(), z.array(z.number()).length(3)])).optional(),
            autoBalance: z.boolean().default(true),
            method: z.enum(["auto", "node", "fusion"]).default("auto"),
          }).strict(),
          annotations: EDIT,
          execution: { resourceClass: "host:editor", longRunning: true, timeoutMs: 20 * 60_000 },
          capabilities: (input) => [hostCap(input.host ?? "resolve", "grade clips")],
          run: async (input, ctx) => {
            const { host, data } = await call<{ clips: number; graded: number; modes: Record<string, number>; errors: string[]; analysedFrames: number }>(
              input.host ?? "resolve", "panel.applyColor", { scope: input.scope, preset: input.preset, look: input.look, autoBalance: input.autoBalance, method: input.method }, 18 * 60_000, ctx.signal,
            );
            return {
              content: [text(`${HOST_NAMES[host]}: graded ${data.graded}/${data.clips} clip(s) (node ${data.modes["node"] ?? 0}, fusion ${data.modes["fusion"] ?? 0}, cdl ${data.modes["cdl"] ?? 0}); ${data.analysedFrames} frame(s) analysed for balance.${data.errors.length ? ` Errors: ${data.errors.join("; ")}` : ""}`)],
              structured: { host, ...data },
            };
          },
        }),

        defineTool({
          name: "editor.revert_color",
          title: "Undo colour grade (Resolve)",
          description: "Switches clips back to their original colour version and removes the AI grades. Pass clip ids from editor.apply_color, or omit to use the clip(s) in scope.",
          input: z.object({ host: HOST, clipIds: z.array(z.string().min(1)).max(1000).optional(), scope: z.enum(["playhead", "track", "all"]).default("playhead") }).strict(),
          annotations: DESTRUCTIVE,
          execution: { resourceClass: "host:editor", timeoutMs: 5 * 60_000 },
          capabilities: (input) => [hostCap(input.host ?? "resolve", "revert grades")],
          run: async (input, ctx) => {
            const host = input.host ?? "resolve";
            let ids = input.clipIds;
            if (!ids) ids = (await call<{ clips: Array<{ id: string }> }>(host, "gc_colorTargets", [input.scope], 30_000, ctx.signal)).data.clips.map((c) => c.id);
            const { data } = await call<Record<string, unknown>>(host, "gc_revertGrade", [ids], 4 * 60_000, ctx.signal);
            return { content: [text(`${HOST_NAMES[host]}: original colour restored on ${ids.length} clip(s).`)], structured: { host, ...data } };
          },
        }),
      ],
    };
  },
});

export { BridgeClient, BridgeConnection, readDiscovery, HOST_IDS, HOST_NAMES, BRIDGE_PROTOCOL } from "./bridge.js";
