/**
 * File helpers for tools: atomic writes (temp file + rename in the same directory) so readers never
 * observe partial files and a crash never leaves a truncated target.
 */
import { randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function writeFileAtomic(target: string, data: string | Uint8Array, options: { readonly exclusive?: boolean } = {}): Promise<void> {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, "wx");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (options.exclusive) {
      // Exclusive create: fail if the target appeared meanwhile (link would be ideal; rename is atomic but overwrites).
      const probe = await open(target, "wx");
      await probe.close();
    }
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** A file name that is safe on Windows, macOS and Linux. */
export function safeFileName(name: string, fallback = "file"): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cleaned) || cleaned.length === 0 ? `${fallback}_${cleaned}` : cleaned;
}
