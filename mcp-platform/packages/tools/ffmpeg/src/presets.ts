/**
 * Transcode presets. The assistant chooses a preset by name; it can never pass raw ffmpeg
 * arguments, so no option injection (e.g. writing arbitrary files via filters) is possible.
 */
export interface TranscodePreset {
  readonly description: string;
  readonly extensions: readonly string[];
  readonly args: readonly string[];
  readonly audioOnly?: boolean;
}

export const PRESETS = {
  h264_high: {
    description: "H.264 MP4, visually lossless (CRF 18), AAC 192k - masters and uploads",
    extensions: [".mp4", ".mov", ".mkv"],
    args: ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
  },
  h264_web: {
    description: "H.264 MP4, balanced size (CRF 23), AAC 160k - sharing and previews",
    extensions: [".mp4", ".mov", ".mkv"],
    args: ["-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"],
  },
  proxy_720p: {
    description: "Lightweight 720p H.264 editing proxy",
    extensions: [".mp4", ".mov"],
    args: ["-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"],
  },
  vertical_1080x1920: {
    description: "Vertical 1080x1920 (Reels/Shorts/TikTok), center-cropped to fill, H.264",
    extensions: [".mp4"],
    args: [
      "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
    ],
  },
  prores_proxy: {
    description: "ProRes 422 Proxy MOV with PCM audio - smooth editing in Premiere/Resolve",
    extensions: [".mov"],
    args: ["-c:v", "prores_ks", "-profile:v", "0", "-pix_fmt", "yuv422p10le", "-c:a", "pcm_s16le"],
  },
  audio_wav_48k: {
    description: "WAV PCM 16-bit 48 kHz stereo",
    extensions: [".wav"],
    args: ["-vn", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2"],
    audioOnly: true,
  },
  audio_mp3_320: {
    description: "MP3 320 kbps",
    extensions: [".mp3"],
    args: ["-vn", "-c:a", "libmp3lame", "-b:a", "320k"],
    audioOnly: true,
  },
} as const satisfies Record<string, TranscodePreset>;

export type PresetName = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as [PresetName, ...PresetName[]];
