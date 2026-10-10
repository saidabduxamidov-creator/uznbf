/**
 * Browser package: reads web pages and takes screenshots with the Edge or Chrome already installed
 * on this computer, in a throwaway headless profile. Each call needs the "network" capability for
 * the site it visits (denied by default), and the page can reach only that site plus any extra
 * sites the call names (each also permission-checked). Downloads are refused.
 */
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { ConflictError, ExternalProcessError, ValidationError, defineTool, defineToolPackage, image, text } from "@lmp/core";
import { canonicalizePath, writeFileAtomic } from "@lmp/toolkit";
import { z } from "zod";
import { locateBrowser, openBrowser, siteOf, type BrowserSession } from "./cdp.js";

const SettingsSchema = z
  .object({
    browserPath: z.string().optional(),
    /** Route pages through the system proxy (e.g. a corporate proxy). Off: direct connections only. */
    useSystemProxy: z.boolean().default(false),
  })
  .strict();

const URL_INPUT = z
  .string()
  .min(1)
  .max(4096)
  .refine((u) => /^https?:\/\//i.test(u) && URL.canParse(u), "an http(s) URL")
  .describe("http(s) URL");
const SITES = z.array(z.string().regex(/^[a-z0-9.-]+$/i).max(253)).max(20).default([]).describe("Extra sites the page may load from (e.g. a CDN)");

const siteOfUrl = (u: string) => siteOf(new URL(u).hostname);

const NAV = {
  url: URL_INPUT,
  alsoAllow: SITES,
  timeoutSec: z.number().int().min(3).max(120).default(30),
  waitAfterLoadMs: z.number().int().min(0).max(10_000).default(800).describe("Extra wait for scripts that render after load"),
};

function networkCaps(input: { url: string; alsoAllow: readonly string[] }) {
  const sites = [...new Set([siteOfUrl(input.url), ...input.alsoAllow.map(siteOf)])];
  return sites.map((s) => ({ kind: "network" as const, target: s, reason: `open ${s} in a private headless browser` }));
}

async function navigate(page: BrowserSession, url: string, timeoutSec: number, settleMs: number): Promise<void> {
  const loaded = page.waitFor("Page.loadEventFired", timeoutSec * 1000);
  loaded.catch(() => undefined);
  const nav = (await page.send("Page.navigate", { url })) as { errorText?: string };
  if (nav.errorText) throw new ExternalProcessError(`Could not open ${url}: ${nav.errorText}`);
  await loaded;
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
}

async function evaluate<T>(page: BrowserSession, expression: string): Promise<T> {
  const r = (await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
  if (r.exceptionDetails) throw new ExternalProcessError(`Page script failed: ${r.exceptionDetails.text ?? "error"}`);
  return r.result?.value as T;
}

const READ_SCRIPT = (selector: string | null, maxChars: number, maxLinks: number) => `(() => {
  const clean = (s) => (s || "").replace(/[ \\t]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim();
  const sel = ${JSON.stringify(selector)};
  const nodes = sel ? Array.from(document.querySelectorAll(sel)) : [document.body];
  const text = clean(nodes.map((n) => n && n.innerText).filter(Boolean).join("\\n\\n"));
  const meta = document.querySelector('meta[name="description"]');
  const links = Array.from(document.links).slice(0, ${maxLinks}).map((a) => ({ text: clean(a.innerText).slice(0, 120), href: a.href }));
  return { title: document.title, url: location.href, description: meta ? meta.content : null, matched: nodes.length, length: text.length, text: text.slice(0, ${maxChars}), links };
})()`;

export default defineToolPackage({
  manifest: {
    id: "browser",
    version: "0.1.0",
    displayName: "Web browser",
    description: "Reads web pages and takes screenshots in a private headless Edge/Chrome, limited to approved sites.",
    platforms: ["win32", "darwin", "linux"],
    capabilities: ["network", "fs.write"],
  },
  configSchema: SettingsSchema,
  register: ({ config }) => {
    async function withPage<T>(input: { url: string; alsoAllow: readonly string[] }, size: { width: number; height: number }, signal: AbortSignal, fn: (page: BrowserSession) => Promise<T>): Promise<T & { blocked: readonly string[] }> {
      const executable = await locateBrowser(config.browserPath);
      const allowedSites = new Set([siteOfUrl(input.url), ...input.alsoAllow.map(siteOf)]);
      const page = await openBrowser({ executable, allowedSites, width: size.width, height: size.height, signal, useSystemProxy: config.useSystemProxy });
      try {
        const result = await fn(page);
        return { ...result, blocked: [...page.blocked] };
      } finally {
        await page.close();
      }
    }

    const blockedNote = (blocked: readonly string[]) =>
      blocked.length ? `\n\n${blocked.length} request(s) to other sites were blocked (e.g. ${new URL(blocked[0] ?? "http://x").hostname}); add them to alsoAllow if the page needs them.` : "";

    return {
      tools: [
        defineTool({
          name: "browser.read_page",
          title: "Read web page",
          description:
            "Opens a web page in a private headless browser (no cookies or logins of the user's browser) and returns its readable text, title and links. Optionally only the elements matching a CSS selector.",
          input: z
            .object({
              ...NAV,
              selector: z.string().min(1).max(500).optional(),
              maxChars: z.number().int().min(100).max(500_000).default(40_000),
              maxLinks: z.number().int().min(0).max(1000).default(100),
            })
            .strict(),
          annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
          execution: { resourceClass: "external", timeoutMs: 3 * 60_000 },
          cache: { ttlMs: 10 * 60_000 },
          capabilities: (input) => networkCaps(input),
          run: async (input, ctx) => {
            const page = await withPage(input, { width: 1280, height: 900 }, ctx.signal, async (p) => {
              await navigate(p, input.url, input.timeoutSec, input.waitAfterLoadMs);
              return evaluate<{ title: string; url: string; description: string | null; matched: number; length: number; text: string; links: { text: string; href: string }[] }>(
                p,
                READ_SCRIPT(input.selector ?? null, input.maxChars, input.maxLinks),
              );
            });
            if (input.selector && page.matched === 0) throw new ValidationError(`No element matches "${input.selector}" on ${page.url}.`);
            const truncated = page.length > page.text.length;
            return {
              content: [text(`# ${page.title || page.url}\n${page.url}\n\n${page.text}${truncated ? `\n… (${page.length - page.text.length} more characters; raise maxChars)` : ""}${blockedNote(page.blocked)}`)],
              structured: { title: page.title, url: page.url, description: page.description, text: page.text, truncated, links: page.links, blocked: page.blocked },
            };
          },
        }),

        defineTool({
          name: "browser.screenshot",
          title: "Screenshot web page",
          description: "Takes a screenshot of a web page (viewport or full page) in a private headless browser; the image is shown to you and can be saved as PNG.",
          input: z
            .object({
              ...NAV,
              width: z.number().int().min(320).max(3840).default(1280),
              height: z.number().int().min(240).max(2160).default(800),
              fullPage: z.boolean().default(false),
              saveTo: z.string().min(1).max(32_767).optional().describe("Optional .png path"),
              overwrite: z.boolean().default(false),
            })
            .strict(),
          annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
          execution: { resourceClass: "external", timeoutMs: 3 * 60_000 },
          capabilities: (input) => [
            ...networkCaps(input),
            ...(input.saveTo ? [{ kind: "fs.write" as const, target: input.saveTo, reason: "save screenshot" }] : []),
          ],
          run: async (input, ctx) => {
            const saveTo = input.saveTo ? await canonicalizePath(input.saveTo, { platform: process.platform }) : null;
            if (saveTo && path.extname(saveTo).toLowerCase() !== ".png") throw new ValidationError("saveTo must end with .png");
            if (saveTo && !input.overwrite && (await stat(saveTo).catch(() => undefined))) throw new ConflictError(`${saveTo} already exists. Set overwrite to replace it.`);
            const shot = await withPage(input, { width: input.width, height: input.height }, ctx.signal, async (p) => {
              await navigate(p, input.url, input.timeoutSec, input.waitAfterLoadMs);
              let clip: Record<string, number> | undefined;
              if (input.fullPage) {
                const m = (await p.send("Page.getLayoutMetrics")) as { cssContentSize?: { width: number; height: number } };
                const h = Math.min(16_000, Math.ceil(m.cssContentSize?.height ?? input.height));
                clip = { x: 0, y: 0, width: input.width, height: h, scale: 1 };
              }
              const r = (await p.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: input.fullPage, ...(clip ? { clip } : {}) })) as { data: string };
              const title = await evaluate<string>(p, "document.title");
              const url = await evaluate<string>(p, "location.href");
              return { data: r.data, title, url, height: clip?.height ?? input.height };
            });
            const png = Buffer.from(shot.data, "base64");
            if (saveTo) {
              await mkdir(path.dirname(saveTo), { recursive: true });
              await writeFileAtomic(saveTo, png);
            }
            return {
              content: [image(shot.data, "image/png"), text(`${shot.title || shot.url} (${input.width}×${shot.height})${saveTo ? `, saved to ${saveTo}` : ""}${blockedNote(shot.blocked)}`)],
              structured: { url: shot.url, title: shot.title, width: input.width, height: shot.height, bytes: png.length, saved: saveTo, blocked: shot.blocked },
            };
          },
        }),
      ],
    };
  },
});

export { BROWSER_FLAGS, hostAllowed, resolverRules, siteOf } from "./cdp.js";
