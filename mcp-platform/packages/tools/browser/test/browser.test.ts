import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ValidationError, type ToolPackage } from "@lmp/core";
import { createToolHarness, type ToolHarness } from "@lmp/toolkit";
import browserPackage, { BROWSER_FLAGS, hostAllowed, resolverRules, siteOf } from "../src/index.js";

describe("site rules", () => {
  it("groups hosts by site", () => {
    assert.equal(siteOf("www.kun.uz"), "kun.uz");
    assert.equal(siteOf("news.bbc.co.uk"), "bbc.co.uk");
    assert.equal(siteOf("gov.uz"), "gov.uz");
    assert.equal(siteOf("127.0.0.1"), "127.0.0.1");
  });

  it("allows only listed sites and inline data", () => {
    const allowed = new Set(["kun.uz"]);
    assert.ok(hostAllowed("https://kun.uz/news", allowed));
    assert.ok(hostAllowed("https://cdn.kun.uz/a.png", allowed));
    assert.ok(hostAllowed("data:image/png;base64,AA==", allowed));
    assert.ok(!hostAllowed("https://tracker.example.com/p.gif", allowed));
    assert.ok(!hostAllowed("file:///C:/Windows/win.ini", allowed));
    assert.ok(!hostAllowed("ftp://kun.uz/x", allowed));
  });

  it("runs the browser privately without a debugging port", () => {
    assert.ok(BROWSER_FLAGS.includes("--remote-debugging-pipe"));
    assert.ok(BROWSER_FLAGS.includes("--disable-background-networking"));
    assert.ok(!BROWSER_FLAGS.some((f) => f.startsWith("--remote-debugging-port")));
  });

  it("leaves only allowed sites resolvable", () => {
    assert.equal(resolverRules(new Set(["kun.uz"])), "MAP * ~NOTFOUND, EXCLUDE kun.uz, EXCLUDE *.kun.uz");
    assert.equal(resolverRules(new Set(["bad site,MAP"])), "MAP * ~NOTFOUND");
  });
});

const CHROMIUM = process.env["LMP_TEST_BROWSER"] ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const hasBrowser = await access(CHROMIUM).then(() => true, () => false);

describe("browser tools", { skip: !hasBrowser && "no Chromium for tests" }, () => {
  let server: Server;
  let base: string;
  let h: ToolHarness;
  let thirdPartyHits = 0;
  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<!doctype html><title>Yangiliklar</title><meta name="description" content="Test sahifa">
          <h1>Bosh sahifa</h1><p class="lead">Oʻzbekiston yangiliklari</p><a href="/about">Biz haqimizda</a>
          <img src="http://localhost:${(server.address() as { port: number }).port}/pixel.png">
          <div id="late"></div><script>setTimeout(() => document.getElementById("late").textContent = "Kech yuklangan matn", 100)</script>`);
      } else if (req.url === "/pixel.png") {
        thirdPartyHits++;
        res.end();
      } else {
        res.statusCode = 404;
        res.end("not found");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    h = await createToolHarness(browserPackage as ToolPackage<unknown>, { browserPath: CHROMIUM });
  });
  after(async () => {
    await h.close();
    server.close();
  });

  it("asks for network access per site", () => {
    const caps = h.capabilities("browser.read_page", { url: "https://www.kun.uz/x", alsoAllow: ["cdn.example.com"] }) as { kind: string; target: string }[];
    assert.deepEqual(caps.map((c) => [c.kind, c.target]), [["network", "kun.uz"], ["network", "example.com"]]);
  });

  it("reads a page, including script-rendered text, and blocks other sites", async () => {
    const r = await h.run("browser.read_page", { url: base });
    const s = r.structured as { title: string; text: string; description: string; links: { href: string }[]; blocked: string[] };
    assert.equal(s.title, "Yangiliklar");
    assert.match(s.text, /Oʻzbekiston yangiliklari/);
    assert.match(s.text, /Kech yuklangan matn/);
    assert.equal(s.description, "Test sahifa");
    assert.equal(s.links[0]?.href, `${base}about`);
    assert.ok(s.blocked.some((u) => u.includes("localhost")), "third-party request blocked");
    assert.equal(thirdPartyHits, 0, "blocked request never reached the server");
  });

  it("extracts by selector", async () => {
    const r = await h.run("browser.read_page", { url: base, selector: "p.lead" });
    assert.equal((r.structured as { text: string }).text, "Oʻzbekiston yangiliklari");
    await assert.rejects(h.run("browser.read_page", { url: base, selector: ".missing" }), ValidationError);
  });

  it("takes and saves a screenshot", async () => {
    const out = path.join(h.dir, "shot.png");
    const r = await h.run("browser.screenshot", { url: base, width: 640, height: 400, saveTo: out });
    assert.equal(r.content[0]?.type, "image");
    const png = await readFile(out);
    assert.equal(png.readUInt32BE(16), 640);
    assert.equal(png.readUInt32BE(20), 400);
  });

  it("rejects non-web URLs", async () => {
    await assert.rejects(h.run("browser.read_page", { url: "file:///etc/passwd" }), ValidationError);
  });
});
