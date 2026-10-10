/**
 * Edit decision formats importable by Premiere Pro and DaVinci Resolve:
 * - Final Cut Pro 7 XML (xmeml v4): File → Import in Premiere, File → Import Timeline in Resolve.
 * - CMX 3600 EDL: universal fallback (video + audio events, source clip names as comments).
 */
export interface EditClip {
  readonly path: string;
  readonly name: string;
  readonly inSec: number;
  readonly outSec: number;
  /** Media facts from ffprobe. */
  readonly mediaDurationSec: number;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly audioChannels: number;
  readonly width: number;
  readonly height: number;
}

export interface SequenceSpec {
  readonly name: string;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
}

export interface Rate {
  readonly timebase: number;
  readonly ntsc: boolean;
}

export function rateOf(fps: number): Rate {
  const ntsc = [23.976, 29.97, 47.952, 59.94, 119.88].some((r) => Math.abs(fps - r) < 0.01);
  return { timebase: Math.round(fps), ntsc };
}

/** Frame count at the sequence rate (NTSC rates count at the nominal timebase over real time). */
export function framesAt(seconds: number, fps: number): number {
  const { timebase, ntsc } = rateOf(fps);
  return Math.round(seconds * (ntsc ? (timebase * 1000) / 1001 : fps));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function pathUrl(filePath: string): string {
  const forward = filePath.replace(/\\/g, "/");
  const parts = forward.split("/").map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? `${seg[0]}%3a` : encodeURIComponent(seg)));
  return `file://localhost/${parts.join("/").replace(/^\/+/, "")}`;
}

function rateXml(r: Rate, indent: string): string {
  return `${indent}<rate>\n${indent}  <timebase>${r.timebase}</timebase>\n${indent}  <ntsc>${r.ntsc ? "TRUE" : "FALSE"}</ntsc>\n${indent}</rate>`;
}

export function buildXmeml(seq: SequenceSpec, clips: readonly EditClip[]): string {
  const r = rateOf(seq.fps);
  const files = new Map<string, number>();
  let cursor = 0;
  const placed = clips.map((c, i) => {
    const length = framesAt(c.outSec, seq.fps) - framesAt(c.inSec, seq.fps);
    const item = { clip: c, index: i + 1, start: cursor, end: cursor + length, in: framesAt(c.inSec, seq.fps), out: framesAt(c.outSec, seq.fps) };
    cursor += length;
    if (!files.has(c.path)) files.set(c.path, files.size + 1);
    return item;
  });
  const fileXml = (c: EditClip, id: number, defined: Set<number>, indent: string) => {
    if (defined.has(id)) return `${indent}<file id="file-${id}"/>`;
    defined.add(id);
    return [
      `${indent}<file id="file-${id}">`,
      `${indent}  <name>${esc(c.name)}</name>`,
      `${indent}  <pathurl>${esc(pathUrl(c.path))}</pathurl>`,
      rateXml(r, `${indent}  `),
      `${indent}  <duration>${framesAt(c.mediaDurationSec, seq.fps)}</duration>`,
      `${indent}  <media>`,
      ...(c.hasVideo ? [`${indent}    <video><samplecharacteristics><width>${c.width}</width><height>${c.height}</height></samplecharacteristics></video>`] : []),
      ...(c.hasAudio ? [`${indent}    <audio><channelcount>${c.audioChannels}</channelcount></audio>`] : []),
      `${indent}  </media>`,
      `${indent}</file>`,
    ].join("\n");
  };
  const defined = new Set<number>();
  const clipItem = (p: (typeof placed)[number], kind: "video" | "audio", channel: number, indent: string) => {
    const id = `clipitem-${kind[0]}${p.index}${kind === "audio" ? `-${channel}` : ""}`;
    const links = [
      ...(p.clip.hasVideo ? [`clipitem-v${p.index}`] : []),
      ...(p.clip.hasAudio ? Array.from({ length: Math.min(2, p.clip.audioChannels) }, (_, k) => `clipitem-a${p.index}-${k + 1}`) : []),
    ];
    return [
      `${indent}<clipitem id="${id}">`,
      `${indent}  <name>${esc(p.clip.name)}</name>`,
      `${indent}  <enabled>TRUE</enabled>`,
      `${indent}  <duration>${framesAt(p.clip.mediaDurationSec, seq.fps)}</duration>`,
      rateXml(r, `${indent}  `),
      `${indent}  <start>${p.start}</start>`,
      `${indent}  <end>${p.end}</end>`,
      `${indent}  <in>${p.in}</in>`,
      `${indent}  <out>${p.out}</out>`,
      fileXml(p.clip, files.get(p.clip.path) as number, defined, `${indent}  `),
      ...(kind === "audio" ? [`${indent}  <sourcetrack><mediatype>audio</mediatype><trackindex>${channel}</trackindex></sourcetrack>`] : []),
      ...links.map((l) => `${indent}  <link><linkclipref>${l}</linkclipref></link>`),
      `${indent}</clipitem>`,
    ].join("\n");
  };
  const maxChannels = Math.min(2, Math.max(0, ...clips.filter((c) => c.hasAudio).map((c) => c.audioChannels)));
  const videoTrack = placed.filter((p) => p.clip.hasVideo).map((p) => clipItem(p, "video", 1, "          ")).join("\n");
  const audioTracks = Array.from({ length: maxChannels }, (_, k) =>
    `        <track>\n${placed.filter((p) => p.clip.hasAudio && p.clip.audioChannels > k).map((p) => clipItem(p, "audio", k + 1, "          ")).join("\n")}\n        </track>`,
  ).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!DOCTYPE xmeml>",
    '<xmeml version="4">',
    '  <sequence id="sequence-1">',
    `    <name>${esc(seq.name)}</name>`,
    `    <duration>${cursor}</duration>`,
    rateXml(r, "    "),
    "    <timecode>",
    rateXml(r, "      "),
    "      <string>00:00:00:00</string>",
    "      <frame>0</frame>",
    "      <displayformat>NDF</displayformat>",
    "    </timecode>",
    "    <media>",
    "      <video>",
    "        <format>",
    "          <samplecharacteristics>",
    rateXml(r, "            "),
    `            <width>${seq.width}</width>`,
    `            <height>${seq.height}</height>`,
    "            <pixelaspectratio>square</pixelaspectratio>",
    "          </samplecharacteristics>",
    "        </format>",
    "        <track>",
    videoTrack,
    "        </track>",
    "      </video>",
    "      <audio>",
    audioTracks,
    "      </audio>",
    "    </media>",
    "  </sequence>",
    "</xmeml>",
    "",
  ].join("\n");
}

function timecode(frames: number, timebase: number): string {
  const f = frames % timebase;
  const totalSeconds = Math.floor(frames / timebase);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(totalSeconds / 3600))}:${p(Math.floor((totalSeconds % 3600) / 60))}:${p(totalSeconds % 60)}:${p(f)}`;
}

export function buildEdl(seq: SequenceSpec, clips: readonly EditClip[]): string {
  const { timebase } = rateOf(seq.fps);
  const lines = [`TITLE: ${seq.name.replace(/[\r\n]/g, " ").slice(0, 70)}`, "FCM: NON-DROP FRAME", ""];
  let record = 0;
  let event = 1;
  for (const c of clips) {
    const srcIn = framesAt(c.inSec, seq.fps);
    const srcOut = framesAt(c.outSec, seq.fps);
    const len = srcOut - srcIn;
    const tracks = [c.hasVideo ? "V" : null, c.hasAudio ? (c.audioChannels > 1 ? "AA" : "A") : null].filter(Boolean) as string[];
    for (const track of tracks) {
      lines.push(
        `${String(event).padStart(3, "0")}  AX       ${track.padEnd(5)} C        ${timecode(srcIn, timebase)} ${timecode(srcOut, timebase)} ${timecode(record, timebase)} ${timecode(record + len, timebase)}`,
        `* FROM CLIP NAME: ${c.name}`,
        `* SOURCE FILE: ${c.path}`,
        "",
      );
      event++;
    }
    record += len;
  }
  return lines.join("\r\n");
}
