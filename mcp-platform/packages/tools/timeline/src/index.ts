/**
 * Timeline package: turns an edit plan (ordered source ranges) into a timeline the editors import
 * (FCP7 XML for Premiere Pro / DaVinci Resolve, CMX3600 EDL), or renders a rough cut with FFmpeg so
 * the plan can be reviewed before it is built in the editor.
 */
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ConflictError, NotFoundError, ValidationError, defineTool, defineToolPackage, text } from "@lmp/core";
import { canonicalizePath, locateFfmpeg, probeMedia, runFfmpeg, safeFileName, writeFileAtomic, type MediaInfo } from "@lmp/toolkit";
import { z } from "zod";
import { buildEdl, buildXmeml, framesAt, type EditClip, type SequenceSpec } from "./formats.js";

const SettingsSchema = z.object({ ffmpegPath: z.string().optional(), ffprobePath: z.string().optional() }).strict();

const PATH = z.string().min(1).max(32_767).describe("Absolute path");
const canonical = (p: string) => canonicalizePath(p, { platform: process.platform });

const ClipInput = z
  .object({
    path: PATH,
    inSec: z.number().min(0).default(0),
    outSec: z.number().min(0).optional().describe("Default: end of the media"),
    name: z.string().min(1).max(200).optional(),
  })
  .strict();
type ClipInputT = z.output<typeof ClipInput>;

const CLIPS = z.array(ClipInput).min(1).max(2000).describe("Source ranges in timeline order");
const FPS = z.number().min(1).max(240);

interface ResolvedClip extends EditClip {
  readonly info: MediaInfo;
}

async function resolveClips(ffprobe: string, clips: readonly ClipInputT[], signal: AbortSignal): Promise<ResolvedClip[]> {
  const probes = new Map<string, Promise<MediaInfo>>();
  const result: ResolvedClip[] = [];
  for (const [i, c] of clips.entries()) {
    const file = await canonical(c.path);
    if (!(await stat(file).catch(() => undefined))?.isFile()) throw new NotFoundError(`Clip ${i + 1}: file not found: ${file}`);
    let probe = probes.get(file);
    if (!probe) probes.set(file, (probe = probeMedia(ffprobe, file, signal)));
    const info = await probe;
    const duration = info.durationSec ?? 0;
    if (!info.hasVideo && !info.hasAudio) throw new ValidationError(`Clip ${i + 1}: ${file} has no audio or video.`);
    const outSec = Math.min(c.outSec ?? duration, duration || Number.POSITIVE_INFINITY);
    if (!(outSec > c.inSec)) throw new ValidationError(`Clip ${i + 1}: outSec (${outSec}) must be after inSec (${c.inSec}) and within the media (${duration.toFixed(3)} s).`);
    const video = info.streams.find((s) => s.type === "video");
    const audio = info.streams.find((s) => s.type === "audio");
    result.push({
      info,
      path: file,
      name: c.name ?? path.basename(file),
      inSec: c.inSec,
      outSec,
      mediaDurationSec: duration,
      hasVideo: info.hasVideo,
      hasAudio: info.hasAudio,
      audioChannels: Math.max(1, Math.min(2, audio?.channels ?? 2)),
      width: video?.width ?? 0,
      height: video?.height ?? 0,
    });
  }
  return result;
}

async function ensureWritable(file: string, overwrite: boolean): Promise<void> {
  if (!overwrite && (await stat(file).catch(() => undefined))) throw new ConflictError(`${file} already exists. Set overwrite to replace it.`);
  await mkdir(path.dirname(file), { recursive: true });
}

const fmtSec = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;

export default defineToolPackage({
  manifest: {
    id: "timeline",
    version: "0.1.0",
    displayName: "Timeline builder",
    description: "Builds editor timelines (FCP XML / EDL) from an edit plan and renders rough cuts with FFmpeg.",
    platforms: ["win32", "darwin", "linux"],
    capabilities: ["fs.read", "fs.write", "process.spawn"],
  },
  configSchema: SettingsSchema,
  register: ({ config, services }) => ({
    tools: [
      defineTool({
        name: "timeline.build_edit",
        title: "Build editor timeline",
        description:
          "Writes a timeline from an ordered list of source ranges. .xml (Final Cut Pro 7 XML) opens in Premiere Pro (File → Import) and DaVinci Resolve (File → Import → Timeline) with linked video and audio; .edl is the CMX3600 fallback.",
        input: z
          .object({
            clips: CLIPS,
            output: PATH.describe("Target file ending in .xml or .edl"),
            sequence: z
              .object({
                name: z.string().min(1).max(120).default("Rough cut"),
                fps: FPS.optional().describe("Default: frame rate of the first video clip"),
                width: z.number().int().min(16).max(16384).optional(),
                height: z.number().int().min(16).max(16384).optional(),
              })
              .strict()
              .prefault({}),
            overwrite: z.boolean().default(false),
          })
          .strict(),
        output: z.object({
          output: z.string(),
          format: z.enum(["xml", "edl"]),
          clips: z.number(),
          durationSec: z.number(),
          sequence: z.object({ name: z.string(), fps: z.number(), width: z.number(), height: z.number() }),
        }),
        annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
        execution: { resourceClass: "io" },
        capabilities: (input) => [
          ...[...new Set(input.clips.map((c) => c.path))].map((p) => ({ kind: "fs.read" as const, target: p, reason: "probe source media" })),
          { kind: "fs.write", target: input.output, reason: "write timeline" },
          { kind: "process.spawn", target: "ffprobe", reason: "read media facts" },
        ],
        run: async (input, ctx) => {
          const output = await canonical(input.output);
          const ext = path.extname(output).toLowerCase();
          if (ext !== ".xml" && ext !== ".edl") throw new ValidationError("The output must end with .xml or .edl");
          const { ffprobe } = await locateFfmpeg(config, "tools.settings.timeline");
          const clips = await resolveClips(ffprobe, input.clips, ctx.signal);
          const firstVideo = clips.find((c) => c.hasVideo);
          const videoStream = firstVideo?.info.streams.find((s) => s.type === "video");
          const seq: SequenceSpec = {
            name: input.sequence.name,
            fps: input.sequence.fps ?? videoStream?.fps ?? 25,
            width: input.sequence.width ?? (firstVideo?.width || 1920),
            height: input.sequence.height ?? (firstVideo?.height || 1080),
          };
          await ensureWritable(output, input.overwrite);
          const body = ext === ".xml" ? buildXmeml(seq, clips) : buildEdl(seq, clips);
          await writeFileAtomic(output, body);
          const frames = clips.reduce((n, c) => n + framesAt(c.outSec, seq.fps) - framesAt(c.inSec, seq.fps), 0);
          const durationSec = Math.round((frames / seq.fps) * 1000) / 1000;
          const how = ext === ".xml" ? "Premiere: File → Import. Resolve: File → Import → Timeline." : "Import as an EDL and point it at the source folder.";
          return {
            content: [text(`Timeline "${seq.name}" (${clips.length} clips, ${fmtSec(durationSec)}, ${seq.width}×${seq.height} @ ${seq.fps} fps) written to ${output}.\n${how}`)],
            structured: { output, format: ext === ".xml" ? ("xml" as const) : ("edl" as const), clips: clips.length, durationSec, sequence: { ...seq } },
          };
        },
      }),

      defineTool({
        name: "timeline.render_rough_cut",
        title: "Render rough cut",
        description:
          "Renders the ordered source ranges into one H.264/AAC MP4 (scaled and letterboxed to the frame size) so the edit can be reviewed before building it in the editor.",
        input: z
          .object({
            clips: CLIPS,
            output: PATH.optional().describe("Target .mp4; default: artifacts folder"),
            width: z.number().int().min(16).max(7680).default(1280),
            height: z.number().int().min(16).max(4320).default(720),
            fps: FPS.default(25),
            quality: z.enum(["draft", "review"]).default("draft"),
            overwrite: z.boolean().default(false),
          })
          .strict(),
        annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
        execution: { resourceClass: "external", longRunning: true, timeoutMs: 6 * 3600_000 },
        capabilities: (input) => [
          ...[...new Set(input.clips.map((c) => c.path))].map((p) => ({ kind: "fs.read" as const, target: p, reason: "read source media" })),
          ...(input.output ? [{ kind: "fs.write" as const, target: input.output, reason: "write rough cut" }] : []),
          { kind: "process.spawn", target: "ffmpeg", reason: "render" },
        ],
        run: async (input, ctx) => {
          const { ffmpeg, ffprobe } = await locateFfmpeg(config, "tools.settings.timeline");
          const clips = await resolveClips(ffprobe, input.clips, ctx.signal);
          const w = input.width - (input.width % 2);
          const h = input.height - (input.height % 2);
          const output = input.output
            ? await canonical(input.output)
            : path.join(services.artifactsDir, "rough-cuts", `${safeFileName(path.parse(clips[0]?.path ?? "cut").name)}_${Date.now()}.mp4`);
          if (path.extname(output).toLowerCase() !== ".mp4") throw new ValidationError("The output must end with .mp4");
          await ensureWritable(output, input.overwrite || !input.output);

          // One input per distinct file; every segment trims from it. Clips without video get
          // black frames, clips without audio get silence, so concat always sees v+a pairs.
          const inputs = [...new Set(clips.map((c) => c.path))];
          const args: string[] = [];
          for (const f of inputs) args.push("-i", f);
          const filters: string[] = [];
          const pairs: string[] = [];
          let total = 0;
          clips.forEach((c, i) => {
            const src = inputs.indexOf(c.path);
            const len = c.outSec - c.inSec;
            total += len;
            const range = `start=${c.inSec.toFixed(3)}:end=${c.outSec.toFixed(3)}`;
            if (c.hasVideo) {
              filters.push(
                `[${src}:v:0]trim=${range},setpts=PTS-STARTPTS,fps=${input.fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`,
              );
            } else {
              filters.push(`color=c=black:s=${w}x${h}:r=${input.fps}:d=${len.toFixed(3)},setsar=1,format=yuv420p[v${i}]`);
            }
            if (c.hasAudio) {
              filters.push(`[${src}:a:0]atrim=${range},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${len.toFixed(3)},atrim=0:${len.toFixed(3)}[a${i}]`);
            } else {
              filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${len.toFixed(3)}[a${i}]`);
            }
            pairs.push(`[v${i}][a${i}]`);
          });
          filters.push(`${pairs.join("")}concat=n=${clips.length}:v=1:a=1[vout][aout]`);
          const crf = input.quality === "draft" ? "28" : "20";
          const preset = input.quality === "draft" ? "veryfast" : "medium";
          const partial = `${output}.part.mp4`;
          ctx.progress({ progress: 0, total: 100, message: `rendering ${clips.length} clips` });
          try {
            await runFfmpeg(
              ffmpeg,
              [
                ...args,
                "-filter_complex", filters.join(";"),
                "-map", "[vout]", "-map", "[aout]",
                "-c:v", "libx264", "-preset", preset, "-crf", crf, "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-y", partial,
              ],
              { signal: ctx.signal, durationSec: total, onProgress: (f) => ctx.progress({ progress: Math.round(f * 99), total: 100, message: "rendering" }) },
            );
            await rename(partial, output);
          } catch (error) {
            await rm(partial, { force: true }).catch(() => undefined);
            throw error;
          }
          ctx.progress({ progress: 100, total: 100, message: "done" });
          return {
            content: [text(`Rough cut (${clips.length} clips, ${fmtSec(total)}, ${w}×${h} @ ${input.fps} fps) written to ${output}.`)],
            structured: { output, clips: clips.length, durationSec: Math.round(total * 1000) / 1000, width: w, height: h, fps: input.fps },
          };
        },
      }),
    ],
  }),
});

export { buildEdl, buildXmeml, framesAt, pathUrl, rateOf } from "./formats.js";
