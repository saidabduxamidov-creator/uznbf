/*
 * GeminiCut for DaVinci Resolve - host (Resolve skript API bilan ishlaydigan qism).
 *
 * Premiere versiyasidagi host.jsx bilan bir xil funksiyalar (gc_*) va bir xil javob
 * formati: panel kodi o'zgarishsiz ishlaydi. Barcha vaqtlar - timeline boshidan soniya,
 * treklar 0 dan (A1 = 0). Resolve API chaqiruvlari asinxron (await).
 *
 * Resolve API'da yo'q narsalar va yechimlar:
 *  - Keyframe: Fusion kompozitsiyasi (Transform + BrightnessContrast) Lua orqali.
 *  - Blade/ripple kesish: pauzalarsiz YANGI timeline yaratiladi, asl timeline saqlanadi.
 *  - Klip tanlash (selection): playhead ostidagi klip ishlatiladi.
 *  - Rang berish: plagin hisoblagan .cube LUT klipning 1-node'iga, alohida "GeminiCut AI"
 *    rang versiyasida qo'yiladi (asl grade saqlanadi).
 *  - Animatsion matn: plagin chizgan PNG ketma-ketligi import qilinib, yuqori trekka qo'yiladi.
 */
"use strict";

const VERSION = "4.8.0";
const BIN = "GeminiCut";

function pad(n) { return String(n).padStart(2, "0"); }

function tcToFrames(tc, fps) {
  const drop = /;/.test(tc);
  const [h, m, s, f] = String(tc).split(/[:;.]/).map(Number);
  const nominal = Math.round(fps);
  let frames = (h * 3600 + m * 60 + s) * nominal + f;
  if (drop) {
    const d = nominal >= 59 ? 4 : 2;
    const mins = h * 60 + m;
    frames -= d * (mins - Math.floor(mins / 10));
  }
  return frames;
}

function framesToTc(frames, fps, drop) {
  const nominal = Math.round(fps);
  frames = Math.max(0, Math.round(frames));
  if (drop) {
    const d = nominal >= 59 ? 4 : 2;
    const perMin = nominal * 60 - d, per10 = perMin * 10 + d;
    const tens = Math.floor(frames / per10), rem = frames % per10;
    frames += d * 9 * tens + (rem > d ? d * Math.floor((rem - d) / perMin) : 0);
  }
  const f = frames % nominal, s = Math.floor(frames / nominal) % 60;
  const m = Math.floor(frames / (nominal * 60)) % 60, h = Math.floor(frames / (nominal * 3600));
  return `${pad(h)}:${pad(m)}:${pad(s)}${drop ? ";" : ":"}${pad(f)}`;
}

/* Fusion Lua uchun satr literali */
function luaStr(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"'; }
function luaNum(n) { return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : "0"; }

/*
 * Klipning Fusion kompozitsiyasi uchun Lua skripti: MediaIn -> GCTransform -> GCFade -> MediaOut.
 * keys: { size: [[frame, v]], center: [[frame, x, y]], angle: [[frame, v]], gain: [[frame, v]] }
 * frame - klip boshidan (0), skript ichida kompozitsiya boshlanishiga qo'shiladi.
 */
function buildMotionLua(keys) {
  const L = [];
  L.push("local c = comp");
  L.push("c:Lock()");
  L.push('local mi = c:FindTool("MediaIn1")');
  L.push('local mo = c:FindTool("MediaOut1")');
  L.push('if not mi or not mo then c:Unlock() error("MediaIn1/MediaOut1 topilmadi") end');
  L.push("local s = c:GetAttrs().COMPN_RenderStart or 0");
  L.push("local function chain(name, kind)");
  L.push("  local t = c:FindTool(name)");
  L.push("  if t then return t end");
  L.push("  t = c:AddTool(kind, -32768, -32768)");
  L.push("  t:SetAttrs({ TOOLS_Name = name })");
  L.push("  local src = mo.Input:GetConnectedOutput() or mi.Output");
  L.push("  t.Input = src");
  L.push("  mo.Input = t.Output");
  L.push("  return t");
  L.push("end");
  const needT = keys.size || keys.center || keys.angle;
  if (needT) L.push('local tr = chain("GCTransform", "Transform")');
  if (keys.size) {
    L.push("tr.Size = c:BezierSpline({})");
    keys.size.forEach(([f, v]) => L.push(`tr.Size[s + ${luaNum(f)}] = ${luaNum(v)}`));
  }
  if (keys.center) {
    L.push("tr.Center = c:XYPath({})");
    keys.center.forEach(([f, x, y]) => L.push(`tr.Center[s + ${luaNum(f)}] = { ${luaNum(x)}, ${luaNum(y)} }`));
  }
  if (keys.angle) {
    L.push("tr.Angle = c:BezierSpline({})");
    keys.angle.forEach(([f, v]) => L.push(`tr.Angle[s + ${luaNum(f)}] = ${luaNum(v)}`));
  }
  if (keys.gain) {
    L.push('local fd = chain("GCFade", "BrightnessContrast")');
    L.push("fd.Gain = c:BezierSpline({})");
    keys.gain.forEach(([f, v]) => L.push(`fd.Gain[s + ${luaNum(f)}] = ${luaNum(v)}`));
  }
  L.push("c:Unlock()");
  return L.join("\n");
}

/* GeminiCut Fusion vositalarini olib tashlab, zanjirni tiklaydi */
function buildResetLua() {
  return [
    "local c = comp",
    "c:Lock()",
    'local mi = c:FindTool("MediaIn1")',
    'local mo = c:FindTool("MediaOut1")',
    'for _, name in ipairs({ "GCFade", "GCTransform" }) do',
    "  local t = c:FindTool(name)",
    "  if t then",
    "    local src = t.Input:GetConnectedOutput()",
    "    for _, inp in ipairs(t.Output:GetConnectedInputs()) do inp:ConnectTo(src) end",
    "    t:Delete()",
    "  end",
    "end",
    "if mo and mi and not mo.Input:GetConnectedOutput() then mo.Input = mi.Output end",
    "c:Unlock()",
  ].join("\n");
}

/*
 * Rang (Fusion zaxira usuli): MediaIn1 dan keyin "GCGrade" (FileLUT) vositasi .cube LUT bilan.
 * Edit sahifasida darhol ko'rinadi. statusPath - natija yoziladigan fayl (tekshirish uchun).
 */
function buildGradeLua(lutPath, statusPath) {
  return [
    "local c = comp",
    "c:Lock()",
    'local mi = c:FindTool("MediaIn1")',
    'local mo = c:FindTool("MediaOut1")',
    'if not mi or not mo then c:Unlock() error("MediaIn1/MediaOut1 topilmadi") end',
    'local t = c:FindTool("GCGrade")',
    "if not t then",
    "  local outs = mi.Output:GetConnectedInputs() or {}",
    '  t = c:AddTool("FileLUT", -32768, -32768)',
    '  t:SetAttrs({ TOOLS_Name = "GCGrade" })',
    "  t.Input = mi.Output",
    "  for _, inp in pairs(outs) do inp:ConnectTo(t.Output) end",
    "  if not mo.Input:GetConnectedOutput() then mo.Input = t.Output end",
    "end",
    `t.LUTFile = ${luaStr(lutPath)}`,
    "c:Unlock()",
    "pcall(function()",
    `  local f = io.open(${luaStr(statusPath)}, "w")`,
    '  if f then f:write(tostring(t:GetInput("LUTFile") or "ok")) f:close() end',
    "end)",
  ].join("\n");
}

/* Faqat GCGrade vositasini olib tashlaydi (motion vositalari qoladi) */
function buildGradeResetLua() {
  return [
    "local c = comp",
    "c:Lock()",
    'local t = c:FindTool("GCGrade")',
    "if t then",
    "  local src = t.Input:GetConnectedOutput()",
    "  for _, inp in pairs(t.Output:GetConnectedInputs() or {}) do inp:ConnectTo(src) end",
    "  t:Delete()",
    "end",
    "c:Unlock()",
  ].join("\n");
}

/* ======================= tahrirlanadigan (native) matn va 3D logo: Fusion =======================
 * PNG klip timeline'ga qo'yilgach, unga Fusion kompozitsiya qo'shiladi va ichida shablon Fusion'ning
 * o'z vositalari bilan quriladi: Text+ (GCMatn), fon (GCPlashka + GCPlashkaShakl), harakat (GCHarakat),
 * ko'rinish (GCKorinish.Blend). 3D logo: Loader -> ImagePlane3D qatlamlari -> Merge3D -> Renderer3D.
 * Fusion sahifasida har bir vosita Inspector'da tahrirlanadi (matn, shrift, rang, o'lcham, keyframe'lar).
 * MediaIn1 (PNG kadrlar) zaxira sifatida kompozitsiyada qoladi.
 */
const NATIVE_TOOLS = ["GCMatn", "GCOstMatn", "GCPlashka", "GCPlashkaShakl", "GCBirlash", "GCBirlash2", "GCHarakat", "GCXira", "GCBosh", "GCKorinish",
  "GCLogoRasm", "GCLogoYon", "GCLogo3D", "GCLogoRender"];

function hexRgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || ""));
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function luaPrelude(fps, statusPath) {
  return [
    "local c = comp",
    'local mi = c:FindTool("MediaIn1")',
    'local mo = c:FindTool("MediaOut1")',
    "local S = c:GetAttrs().COMPN_RenderStart or 0",
    "local warn = {}",
    "local function opt(what, f) local ok, e = pcall(f) if not ok then table.insert(warn, what .. ': ' .. tostring(e)) end return ok end",
    "local function set(t, k, v) return opt(k, function() t:SetInput(k, v) end) end",
    "local function anim(t, k, keys, xy)",
    "  return opt(k, function()",
    "    t[k] = xy and c:XYPath({}) or c:BezierSpline({})",
    "    for _, kv in ipairs(keys) do t[k][S + kv[1]] = kv[2] end",
    "  end)",
    "end",
    "local function add(kind, name)",
    "  local t = c:AddTool(kind, -32768, -32768)",
    "  if not t then error(kind .. ' vositasi qo\\'shilmadi') end",
    "  t:SetAttrs({ TOOLS_Name = name })",
    "  return t",
    "end",
    `local function finish(ok, err) pcall(function() local f = io.open(${luaStr(statusPath)}, "w") if f then f:write(ok and ("ok\\n" .. table.concat(warn, "\\n")) or ("xato: " .. tostring(err))) f:close() end end) end`,
    "if not mi or not mo then finish(false, 'MediaIn1/MediaOut1 topilmadi') return end",
    "c:Lock()",
    `for _, n in ipairs({ ${NATIVE_TOOLS.map(luaStr).join(", ")} }) do local t = c:FindTool(n) if t then t:Delete() end end`,
    "for k = 0, 40 do local t = c:FindTool('GCLogoQatlam' .. k) if t then t:Delete() end end",
  ];
}

function luaEnd(L) {
  return L.concat(["end)", "c:Unlock()", "finish(ok, err)", "return true"]).join("\n");
}

const lk = (keys) => "{ " + keys.map(([f, v]) => `{ ${Math.round(f)}, ${Array.isArray(v) ? "{ " + v.map(luaNum).join(", ") + " }" : luaNum(v)} }`).join(", ") + " }";

/* Kirish/chiqish kalitlari (kadrlarda, klip boshidan) */
function nativeTiming(spec, fps) {
  const n = Math.max(2, Math.round(spec.duration * fps));
  const i = Math.max(2, Math.round(Math.max(0.1, spec.inDur) * fps)), o = Math.max(2, Math.round(Math.max(0.1, spec.outDur) * fps));
  return { n, i, o, last: n - 1 };
}

function buildNativeTextLua(spec, W, H, fps, statusPath) {
  const T = nativeTiming(spec, fps), a = spec.anim;
  const px = spec.x, py = 1 - spec.y; // Fusion: y yuqoriga
  const size = spec.size, fpx = size * H;
  const lines = String(spec.text || " ").split(/\r?\n/);
  const box = spec.box || [Math.max(...lines.map((l) => l.length)) * fpx * 0.62, lines.length * fpx * 1.14];
  const col = hexRgb(spec.color);
  const L = luaPrelude(fps, statusPath);
  L.push("local ok, err = pcall(function()");
  L.push(`  local W, H = ${Math.round(W)}, ${Math.round(H)}`);
  L.push('  local function canvas(name) local b = add("Background", name) set(b, "Width", W) set(b, "Height", H) set(b, "TopLeftAlpha", 0) return b end');
  L.push('  local function text(name, str, sz, r, g, b, cx, cy)');
  L.push('    local t = add("TextPlus", name)');
  L.push('    set(t, "Width", W) set(t, "Height", H)');
  L.push('    t.StyledText = str');
  L.push(`    set(t, "Font", ${luaStr(spec.font || "Arial")})`);
  L.push(`    set(t, "Style", ${luaStr(Number(spec.weight) >= 600 ? (spec.italic ? "Bold Italic" : "Bold") : spec.italic ? "Italic" : "Regular")})`);
  L.push('    t.Size = sz');
  L.push('    set(t, "Red1", r) set(t, "Green1", g) set(t, "Blue1", b)');
  L.push(`    set(t, "CharacterSpacing", ${luaNum(1 + (spec.spacing || 0))})`);
  const hj = spec.align === "left" ? 0 : spec.align === "right" ? 2 : 1;
  L.push(`    set(t, "HorizontalJustificationNew", ${hj})`);
  L.push(`    set(t, "HorizontalLeftCenterRight", ${hj - 1})`);
  L.push('    t.Center = { cx, cy }');
  if (spec.sticker) L.push('    set(t, "Enabled2", 1) set(t, "Red2", 1) set(t, "Green2", 1) set(t, "Blue2", 1) set(t, "Thickness2", 0.12)');
  else if (spec.stroke > 0) L.push(`    set(t, "Enabled2", 1) set(t, "Red2", 0.04) set(t, "Green2", 0.04) set(t, "Blue2", 0.055) set(t, "Thickness2", ${luaNum(0.04 * spec.stroke)})`);
  if (spec.shadow > 0) L.push(`    set(t, "Enabled3", 1) set(t, "Softness3", ${luaNum(0.6 + spec.shadow)})`);
  L.push('    return t');
  L.push('  end');
  L.push(`  local cur = text("GCMatn", ${luaStr(spec.noText ? " " : lines.join("\n"))}, ${luaNum(size)}, ${col.map(luaNum).join(", ")}, ${luaNum(px)}, ${luaNum(py)})`);
  if (spec.bg) {
    const bg = spec.bg, pad = [bg.padX * fpx, bg.padY * fpx];
    const bw = bg.shape === "bar" ? fpx * 0.14 : box[0] + 2 * pad[0], bh = box[1] + 2 * pad[1];
    let bx = px; // markaz
    if (spec.align === "left") bx = px + box[0] / 2 / W;
    if (spec.align === "right") bx = px - box[0] / 2 / W;
    if (bg.shape === "bar") bx = (spec.align === "left" ? px : bx - box[0] / 2 / W) - pad[0] / W;
    const fc = hexRgb(bg.fill || bg.stroke), op = (bg.opacity || 100) / 100;
    L.push('  local pl = add("Background", "GCPlashka")');
    L.push('  set(pl, "Width", W) set(pl, "Height", H)');
    L.push(`  set(pl, "TopLeftRed", ${luaNum(fc[0] * op)}) set(pl, "TopLeftGreen", ${luaNum(fc[1] * op)}) set(pl, "TopLeftBlue", ${luaNum(fc[2] * op)}) set(pl, "TopLeftAlpha", ${luaNum(op)})`);
    L.push('  local sh = add("RectangleMask", "GCPlashkaShakl")');
    L.push(`  sh.Center = { ${luaNum(bx)}, ${luaNum(py)} }`);
    L.push(`  set(sh, "Width", ${luaNum(bw / W)}) set(sh, "Height", ${luaNum(bh / W)})`);
    L.push(`  set(sh, "CornerRadius", ${luaNum(Math.min(1, bg.radius || 0))})`);
    if (!bg.fill && bg.stroke) L.push(`  set(sh, "Solid", 0) set(sh, "BorderWidth", ${luaNum((fpx * 0.07) / W)})`);
    L.push('  pl.EffectMask = sh.Mask or sh.Output');
    L.push('  local mg = add("Merge", "GCBirlash")');
    L.push('  mg.Background = pl.Output');
    L.push('  mg.Foreground = cur.Output');
    L.push('  cur = mg');
  }
  if (spec.sub) {
    const dy = (lines.length * 1.14 * fpx) / 2 + 0.55 * fpx;
    L.push(`  local st = text("GCOstMatn", ${luaStr(spec.sub)}, ${luaNum(size * 0.55)}, ${col.map(luaNum).join(", ")}, ${luaNum(px)}, ${luaNum(py - dy / H)})`);
    L.push('  local m2 = add("Merge", "GCBirlash2")');
    L.push('  m2.Background = cur.Output');
    L.push('  m2.Foreground = st.Output');
    L.push('  cur = m2');
  }
  // harakat: Transform (o'lcham, joy)
  L.push('  local tr = add("Transform", "GCHarakat")');
  L.push('  tr.Input = cur.Output');
  L.push(`  set(tr, "Pivot", { ${luaNum(px)}, ${luaNum(py)} })`);
  L.push(`  tr.Center = { ${luaNum(px)}, ${luaNum(py)} }`);
  const { i, o, last } = T;
  const P = [px, py];
  if (a === "pop" || a === "counter" || a === "timer" || a === "typewriter" || a === "pulse") {
    const k = [[0, 0], [i * 0.7, 1.12], [i, 1]];
    if (a === "pulse") { const beat = Math.max(4, Math.round(fps / (1.3 * (spec.speed || 1)))); for (let f = i + beat; f < last - o; f += beat) k.push([f - 2, 1], [f, 1.08], [f + 2, 1]); }
    k.push([last - o, 1], [last, 0.8]);
    L.push(`  anim(tr, "Size", ${lk(k)})`);
  } else if (a === "slam" || a === "strobe") {
    L.push(`  anim(tr, "Size", ${lk([[0, 2.6], [i * 0.5, 1], [last - o, 1], [last, 1.2]])})`);
    const sh = [], amp = (fpx * 0.12) / W;
    for (let f = Math.round(i * 0.5); f < Math.round(i * 0.5) + 10; f++) sh.push([f, [P[0] + Math.sin(f * 2.1) * amp * (1 - (f - i * 0.5) / 10), P[1] + Math.cos(f * 1.7) * amp * 0.8 * (1 - (f - i * 0.5) / 10)]]);
    sh.push([Math.round(i * 0.5) + 10, P]);
    L.push(`  anim(tr, "Center", ${lk(sh)}, true)`);
  } else if (a === "rise") {
    L.push(`  anim(tr, "Center", ${lk([[0, [P[0], P[1] - 0.06]], [i, P], [last - o, P], [last, [P[0], P[1] + 0.03]]])}, true)`);
  } else if (a === "slide") {
    const dx = spec.align === "right" ? 0.5 : -0.5;
    L.push(`  anim(tr, "Center", ${lk([[0, [P[0] + dx, P[1]]], [i, P], [last - o, P], [last, [P[0] - dx * 0.4, P[1]]]])}, true)`);
  }
  if (a === "blur") {
    L.push('  local bl = add("Blur", "GCXira")');
    L.push('  bl.Input = tr.Output');
    L.push(`  anim(bl, "XBlurSize", ${lk([[0, 30], [i, 0], [last - o, 0], [last, 20]])})`);
    L.push('  cur = bl');
  } else L.push('  cur = tr');
  // ko'rinish (shaffoflik): Merge.Blend
  L.push('  local bo = canvas("GCBosh")');
  L.push('  local kv = add("Merge", "GCKorinish")');
  L.push('  kv.Background = bo.Output');
  L.push('  kv.Foreground = cur.Output');
  const fadeIn = a === "pop" || a === "counter" || a === "timer" || a === "pulse" ? i * 0.4 : a === "slam" || a === "strobe" ? i * 0.2 : i;
  const blend = [[0, 0], [Math.max(1, fadeIn), 1]];
  if (a === "strobe") for (let f = Math.max(2, Math.round(fadeIn)) + 1; f < Math.min(last - o, i * 1.6); f += 2) blend.push([f, 0], [f + 1, 1]);
  blend.push([last - o, 1], [last, 0]);
  L.push(`  anim(kv, "Blend", ${lk(blend)})`);
  L.push("  mo.Input = kv.Output");
  return luaEnd(L);
}

function buildNativeLogoLua(spec, W, H, fps, statusPath, img) {
  const T = nativeTiming(spec, fps);
  const iw = (img && img.width) || 1000, ih = (img && img.height) || 1000;
  let hPx = 0.72 * spec.size * H;
  if (hPx * iw / ih > 0.9 * W) hPx = 0.9 * W * ih / iw;
  const wPx = hPx * iw / ih, K = 12, rot = spec.rot || 32;
  const dz = ((spec.depth || 0.16) * hPx) / W / (K - 1);
  const L = luaPrelude(fps, statusPath);
  L.push("local ok, err = pcall(function()");
  L.push('  local ld = add("Loader", "GCLogoRasm")');
  L.push(`  ld.Clip = ${luaStr(spec.logo)}`);
  L.push('  local dk = add("BrightnessContrast", "GCLogoYon")');
  L.push('  dk.Input = ld.Output');
  L.push('  set(dk, "Gain", 0.32)');
  L.push('  local m3 = add("Merge3D", "GCLogo3D")');
  L.push(`  for k = 0, ${K - 1} do`);
  L.push('    local p = add("ImagePlane3D", "GCLogoQatlam" .. k)');
  L.push('    p.MaterialInput = (k == 0) and ld.Output or dk.Output');
  L.push(`    p:SetInput("Transform3DOp.Translate.Z", -k * ${luaNum(dz)})`);
  L.push('    m3["SceneInput" .. (k + 1)] = p.Output');
  L.push("  end");
  L.push(`  set(m3, "Transform3DOp.Scale.X", ${luaNum(wPx / W)})`);
  L.push(`  set(m3, "Transform3DOp.Translate.X", ${luaNum(spec.x - 0.5)})`);
  L.push(`  set(m3, "Transform3DOp.Translate.Y", ${luaNum(((0.5 - spec.y) * H) / W)})`);
  const { i, o, last } = T;
  const ry = [[0, rot * 1.8], [i, 0]];
  for (let f = i + Math.round(fps * 0.5); f < last - o; f += Math.round(fps * 0.5)) ry.push([f, Math.sin((f - i) / fps * 1.1) * rot * 0.3]);
  ry.push([last - o, 0], [last, rot * 1.2]);
  L.push(`  anim(m3, "Transform3DOp.Rotate.Y", ${lk(ry)})`);
  L.push('  local r = add("Renderer3D", "GCLogoRender")');
  L.push('  r.SceneInput = m3.Output');
  L.push(`  set(r, "Width", ${Math.round(W)}) set(r, "Height", ${Math.round(H)})`);
  L.push('  local bo = add("Background", "GCBosh")');
  L.push(`  set(bo, "Width", ${Math.round(W)}) set(bo, "Height", ${Math.round(H)}) set(bo, "TopLeftAlpha", 0)`);
  L.push('  local tr = add("Transform", "GCHarakat")');
  L.push('  tr.Input = r.Output');
  L.push(`  anim(tr, "Size", ${lk([[0, 0.55], [i, 1], [last - o, 1], [last, 1.15]])})`);
  L.push('  local kv = add("Merge", "GCKorinish")');
  L.push('  kv.Background = bo.Output');
  L.push('  kv.Foreground = tr.Output');
  L.push(`  anim(kv, "Blend", ${lk([[0, 0], [Math.max(1, i * 0.25), 1], [last - o, 1], [last, 0]])})`);
  L.push("  mo.Input = kv.Output");
  return luaEnd(L);
}

/* Native qurilmasa: GeminiCut vositalarini o'chirib, PNG kadrlarni (MediaIn1) qayta ulaydi */
function buildNativeRestoreLua() {
  return [
    "local c = comp",
    "c:Lock()",
    `for _, n in ipairs({ ${NATIVE_TOOLS.map(luaStr).join(", ")} }) do local t = c:FindTool(n) if t then t:Delete() end end`,
    "for k = 0, 40 do local t = c:FindTool('GCLogoQatlam' .. k) if t then t:Delete() end end",
    'local mi = c:FindTool("MediaIn1")',
    'local mo = c:FindTool("MediaOut1")',
    "if mi and mo then mo.Input = mi.Output end",
    "c:Unlock()",
  ].join("\n");
}

function createHost(resolve, deps) {
  const fs = deps.fs, path = deps.path;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const state = { pendingZooms: null };

  async function env() {
    const pm = await resolve.GetProjectManager();
    const project = pm && (await pm.GetCurrentProject());
    if (!project) throw new Error("Resolve'da loyiha ochilmagan.");
    const tl = await project.GetCurrentTimeline();
    if (!tl) throw new Error("Timeline ochilmagan. Edit sahifasida timeline'ni oching.");
    let fps = parseFloat(await tl.GetSetting("timelineFrameRate")) || parseFloat(await project.GetSetting("timelineFrameRate")) || 25;
    const start = await tl.GetStartFrame();
    const end = await tl.GetEndFrame();
    const startTc = String(await tl.GetStartTimecode() || "");
    const drop = /;/.test(startTc) || /DF/i.test(String(await tl.GetSetting("timelineDropFrameTimecode") || ""));
    return { pm, project, tl, fps, start, end, drop, mp: await project.GetMediaPool() };
  }

  const sec = (e, frame) => (frame - e.start) / e.fps;
  const frameAt = (e, s) => e.start + Math.round(s * e.fps);

  async function playheadFrame(e) {
    const tc = await e.tl.GetCurrentTimecode();
    return tc ? tcToFrames(tc, e.fps) : e.start;
  }

  async function items(e, type, index1) {
    return (await e.tl.GetItemListInTrack(type, index1)) || [];
  }

  async function itemInfo(it) {
    return { it, start: await it.GetStart(), end: await it.GetEnd(), name: await it.GetName() };
  }

  async function itemAt(e, type, index1, frame) {
    for (const it of await items(e, type, index1)) {
      const a = await it.GetStart(), b = await it.GetEnd();
      if (a <= frame && b > frame) return it;
    }
    return null;
  }

  async function itemPath(it, keepCase) {
    try {
      const mpi = await it.GetMediaPoolItem();
      const p = mpi ? String(await mpi.GetClipProperty("File Path") || "") : "";
      return keepCase ? p : p.toLowerCase();
    } catch (e) { return ""; }
  }

  async function sourceStart(it) {
    if (typeof it.GetSourceStartFrame === "function") { const v = await it.GetSourceStartFrame(); if (Number.isFinite(v)) return v; }
    return (await it.GetLeftOffset()) || 0;
  }

  /* GeminiCut papkasini (bin) topadi yoki yaratadi */
  async function bin(e, sub) {
    const root = await e.mp.GetRootFolder();
    const find = async (parent, name) => {
      for (const f of (await parent.GetSubFolderList()) || []) if ((await f.GetName()) === name) return f;
      return e.mp.AddSubFolder(parent, name);
    };
    let f = await find(root, BIN);
    if (sub) f = await find(f, sub);
    return f;
  }

  /* Faylni Media Pool'ga bir marta import qiladi */
  async function importOnce(e, file, sub) {
    if (!fs.existsSync(file)) throw new Error("Fayl topilmadi: " + file);
    const folder = await bin(e, sub);
    const target = path.resolve(file).toLowerCase();
    for (const clip of (await folder.GetClipList()) || []) {
      const p = String(await clip.GetClipProperty("File Path") || "");
      if (p && path.resolve(p).toLowerCase() === target) return clip;
    }
    await e.mp.SetCurrentFolder(folder);
    const list = await e.mp.ImportMedia([file]);
    if (!list || !list.length) throw new Error("Import qilinmadi: " + path.basename(file));
    return list[0];
  }

  async function clipFrames(e, mpi) {
    const n = parseInt(await mpi.GetClipProperty("Frames"), 10);
    if (Number.isFinite(n) && n > 0) return n;
    const d = await mpi.GetClipProperty("Duration");
    return d ? tcToFrames(d, e.fps) : Math.round(e.fps);
  }

  async function markRange(e) {
    try {
      const mk = await e.tl.GetMarkInOut();
      const v = mk && (mk.video || mk.audio);
      if (v && Number.isFinite(v.in) && Number.isFinite(v.out) && v.out > v.in) {
        const base = v.in < e.start ? e.start : 0;
        return { in: v.in + base, out: v.out + base };
      }
    } catch (err) { /* 19 dan eski versiya */ }
    return null;
  }

  /* ---------------- motion ---------------- */

  /* Host formatidagi ops -> Fusion kalitlari (klip boshidan kadrlarda) */
  function opsToFusionKeys(op, info, fps) {
    const out = {};
    const rel = op.mode === "rel";
    const toF = (t) => Math.round((t - info.startSec) * fps);
    if (op.prop === "scale") out.size = op.keys.map(([t, v]) => [toF(t), v / 100]);
    if (op.prop === "position") out.center = op.keys.map(([t, v]) => (rel ? [toF(t), 0.5 + v[0], 0.5 - v[1]] : [toF(t), v[0], 1 - v[1]]));
    if (op.prop === "rotation") out.angle = op.keys.map(([t, v]) => [toF(t), -v]); // Fusion: soat strelkasiga teskari
    if (op.prop === "opacity") out.gain = op.keys.map(([t, v]) => [toF(t), Math.max(0, Math.min(100, v)) / 100]);
    return out;
  }

  /*
   * Comp.Execute: Resolve'ning Workflow Integration ko'prigi ba'zan skript bajarilgandan keyin uning natijasini
   * o'qiy olmaydi va "Execute: Parse - Unknown object type detected for key:result" xatosini tashlaydi.
   * Skript esa ishlagan bo'ladi - natija status fayli / tekshiruv orqali aniqlanadi, shuning uchun bu xato e'tiborsiz.
   */
  async function fusionRun(comp, lua) {
    try { return await comp.Execute(lua); }
    catch (err) {
      if (/Parse|Unknown object type|key:result/i.test(String((err && err.message) || err))) return null;
      throw err;
    }
  }

  async function fusionComp(it) {
    const count = typeof it.GetFusionCompCount === "function" ? await it.GetFusionCompCount() : 0;
    const comp = count > 0 ? await it.GetFusionCompByIndex(1) : await it.AddFusionComp();
    if (!comp || typeof comp.Execute !== "function") throw new Error("Fusion kompozitsiyasi ochilmadi");
    return comp;
  }

  async function motionCore(ops) {
    const e = await env();
    const groups = new Map(), errors = [];
    for (const op of ops) {
      const vt = op.track + 1;
      const list = await items(e, "video", vt);
      const target = frameAt(e, op.start);
      let found = null;
      for (const it of list) { const a = await it.GetStart(); if (Math.abs(a - target) <= 1) { found = it; break; } }
      if (!found) found = await itemAt(e, "video", vt, target + 1);
      if (!found) { errors.push(`klip topilmadi (V${vt}, ${op.start.toFixed(2)}s)`); continue; }
      const key = (await found.GetUniqueId?.()) || `${vt}:${await found.GetStart()}`;
      if (!groups.has(key)) groups.set(key, { it: found, startSec: sec(e, await found.GetStart()), keys: {} });
      const g = groups.get(key);
      Object.assign(g.keys, opsToFusionKeys(op, g, e.fps));
    }
    let applied = 0, keys = 0;
    for (const g of groups.values()) {
      try {
        const comp = await fusionComp(g.it);
        await fusionRun(comp, buildMotionLua(g.keys));
        applied++;
        keys += Object.values(g.keys).reduce((a, k) => a + k.length, 0);
      } catch (err) { errors.push(err.message); }
    }
    return { applied, keys, errors };
  }

  /* ---------------- panel chaqiradigan funksiyalar ---------------- */

  /* ---------------- rang va matn yordamchilari ---------------- */

  const AI_VERSION = "GeminiCut AI";
  state.origVersion = {};
  state.fusionGraded = {};

  function userLutDir() {
    if (deps.userLutDir) return deps.userLutDir;
    return path.join(require("os").homedir(), "Documents", "GeminiCut", "LUT");
  }

  function lutDir() {
    if (deps.lutDir) return deps.lutDir;
    if (process.platform === "darwin") return "/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/GeminiCut";
    return path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "Blackmagic Design", "DaVinci Resolve", "Support", "LUT", "GeminiCut");
  }

  const safeName = (s) => String(s || "clip").replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "clip";

  async function findItemById(e, id) {
    const nv = await e.tl.GetTrackCount("video");
    for (let v = 1; v <= nv; v++) {
      for (const it of await items(e, "video", v)) if (String(await it.GetUniqueId()) === String(id)) return it;
    }
    return null;
  }

  /* Klip GeminiCut AI versiyasida bo'lsa - asl versiyasini eslab qolib, unga qaytaradi */
  async function ensureOriginalVersion(it, id) {
    if (typeof it.GetCurrentVersion !== "function") return;
    const cur = await it.GetCurrentVersion();
    if (cur && cur.versionName && cur.versionName !== AI_VERSION) { state.origVersion[id] = cur; return; }
    if (cur && cur.versionName === AI_VERSION) {
      const orig = state.origVersion[id] || { versionName: "Version 1", versionType: 0 };
      await it.LoadVersionByName(orig.versionName, orig.versionType);
    }
  }

  async function isTextItem(it) {
    if (!it) return false;
    return /geminicut[\\/]+matn[\\/]/i.test(await itemPath(it, true));
  }

  /* Matn uchun video trek: o'sha vaqtdagi barcha kliplardan yuqorida, bo'sh va qulflanmagan; bo'lmasa yangi trek */
  async function overlayTrack(e, from, to) {
    const nv = await e.tl.GetTrackCount("video");
    const busy = async (v) => {
      for (const it of await items(e, "video", v)) { const a = await it.GetStart(), b = await it.GetEnd(); if (a < to && b > from) return true; }
      return false;
    };
    let top = 0;
    for (let v = 1; v <= nv; v++) if (await busy(v)) top = v;
    for (let v = top + 1; v <= nv; v++) if (!(await e.tl.GetIsTrackLocked("video", v)) && !(await busy(v))) return v;
    await e.tl.AddTrack("video");
    const n2 = await e.tl.GetTrackCount("video");
    if (n2 <= nv) throw new Error("Yangi video trek yaratilmadi.");
    return n2;
  }

  /* PNG ketma-ketligini Media Pool'ga olib, timeline'ga qo'yadi (almashtirishda eskisining o'rniga) */
  async function placeSequence(e, first, count, at, replace, name) {
    const m = /^(.*?)(\d+)(\.png)$/i.exec(String(first));
    if (!m || !fs.existsSync(first)) throw new Error("Kadrlar topilmadi: " + first);
    const folder = await bin(e, "Matn");
    await e.mp.SetCurrentFolder(folder);
    const startIdx = Number(m[2]);
    const list = await e.mp.ImportMedia([{ FilePath: m[1] + "%0" + m[2].length + "d" + m[3], StartIndex: startIdx, EndIndex: startIdx + count - 1 }]);
    if (!list || !list.length) throw new Error("PNG ketma-ketligi import qilinmadi.");
    const mpi = list[0];
    try { if (name && typeof mpi.SetClipProperty === "function") await mpi.SetClipProperty("Clip Name", name); } catch (err) { /* ixtiyoriy */ }
    let frames = await clipFrames(e, mpi);
    if (!(frames > 1)) frames = count;
    let rec = at >= 0 ? frameAt(e, at) : await playheadFrame(e);
    let idx;
    if (replace && replace.track >= 0) {
      idx = replace.track + 1;
      const old = await itemAt(e, "video", idx, frameAt(e, replace.start) + 1);
      if (old) {
        rec = await old.GetStart();
        if (typeof e.tl.DeleteClips !== "function" || !(await e.tl.DeleteClips([old], false))) throw new Error("Eski matnni o'chirib bo'lmadi. Uni qo'lda o'chiring.");
      }
    } else {
      idx = await overlayTrack(e, rec, rec + frames);
    }
    const placed = await e.mp.AppendToTimeline([{ mediaPoolItem: mpi, startFrame: 0, endFrame: frames - 1, trackIndex: idx, recordFrame: rec, mediaType: 1 }]);
    if (!placed || !placed.length) throw new Error("Matn timeline'ga qo'yilmadi. U Media Pool'da (GeminiCut → Matn).");
    return { item: placed[0], idx, rec, frames };
  }

  const api = {
    async gc_ping() {
      let v = "";
      try { v = await resolve.GetVersionString(); } catch (e) { /* eski */ }
      return { version: VERSION, host: "DaVinci Resolve " + v };
    },

    async gc_setKeyBase() { return {}; },

    async gc_getSequenceInfo() {
      const e = await env();
      const duration = (e.end - e.start) / e.fps;
      const audio = [], sig = [];
      let clipCount = 0;
      const na = await e.tl.GetTrackCount("audio");
      for (let a = 1; a <= na; a++) {
        const list = await items(e, "audio", a);
        let covered = 0;
        for (const it of list) {
          const s = await it.GetStart(), t = await it.GetEnd();
          covered += (t - s) / e.fps;
          sig.push(`a${a}:${s}-${t}`);
        }
        clipCount += list.length;
        audio.push({ index: a - 1, name: (await e.tl.GetTrackName("audio", a)) || `Audio ${a}`, clips: list.length,
          muted: !(await e.tl.GetIsTrackEnabled("audio", a)), locked: !!(await e.tl.GetIsTrackLocked("audio", a)),
          coverage: duration > 0 ? covered / duration : 0 });
      }
      const nv = await e.tl.GetTrackCount("video");
      for (let v = 1; v <= nv; v++) {
        const list = await items(e, "video", v);
        clipCount += list.length;
        for (const it of list) sig.push(`v${v}:${await it.GetStart()}-${await it.GetEnd()}`);
      }
      const mk = await markRange(e);
      return {
        id: String((await e.tl.GetUniqueId?.()) || (await e.tl.GetName())), name: await e.tl.GetName(),
        duration, inPoint: mk ? sec(e, mk.in) : 0, outPoint: mk ? sec(e, mk.out) : duration, hasRange: !!mk,
        fps: e.fps, width: Number(await e.tl.GetSetting("timelineResolutionWidth")) || 1920,
        height: Number(await e.tl.GetSetting("timelineResolutionHeight")) || 1080,
        playhead: sec(e, await playheadFrame(e)), audioTracks: audio, videoTracks: nv, clipCount, signature: sig.join("|"),
      };
    },

    async gc_findAudioPreset() { return { path: "resolve-render", scanned: 0 }; },

    /* Timeline audiosini Resolve render'i orqali WAV qiladi (faqat tanlangan nutq treklari) */
    async gc_exportAudio(outPath, preset, tracks, useInOut) {
      const e = await env();
      const na = await e.tl.GetTrackCount("audio");
      const saved = [];
      const dir = path.dirname(outPath), base = path.basename(outPath).replace(/\.wav$/i, "");
      let page = null, job = null;
      try { page = await resolve.GetCurrentPage(); } catch (err) { /* e'tiborsiz */ }
      try {
        for (let a = 1; a <= na; a++) {
          saved.push(await e.tl.GetIsTrackEnabled("audio", a));
          await e.tl.SetTrackEnable("audio", a, tracks.includes(a - 1));
        }
        const codecs = (await e.project.GetRenderCodecs("wav")) || {};
        const names = Object.values(codecs);
        const codec = names.find((c) => /pcm/i.test(c)) || names[0] || "LinearPCM";
        if (!(await e.project.SetCurrentRenderFormatAndCodec("wav", codec))) throw new Error("WAV render formati o'rnatilmadi.");
        try { await e.project.SetCurrentRenderMode(1); } catch (err) { /* e'tiborsiz */ }
        const mk = useInOut ? await markRange(e) : null;
        const settings = { TargetDir: dir, CustomName: base, ExportVideo: false, ExportAudio: true, AudioSampleRate: 48000, AudioBitDepth: 16 };
        if (mk) Object.assign(settings, { SelectAllFrames: false, MarkIn: mk.in, MarkOut: mk.out - 1 });
        else settings.SelectAllFrames = true;
        if (!(await e.project.SetRenderSettings(settings))) throw new Error("Render sozlamalari qabul qilinmadi.");
        job = await e.project.AddRenderJob();
        if (!job) throw new Error("Render ishi yaratilmadi.");
        await e.project.StartRendering([job], false);
        const t0 = Date.now();
        while (await e.project.IsRenderingInProgress()) {
          if (Date.now() - t0 > 30 * 60000) throw new Error("Audio render juda uzoq davom etdi.");
          await sleep(400);
        }
        const st = (await e.project.GetRenderJobStatus(job)) || {};
        if (st.JobStatus && !/complete/i.test(st.JobStatus)) throw new Error("Audio render yakunlanmadi: " + st.JobStatus + (st.Error ? " - " + st.Error : ""));
        let file = path.join(dir, base + ".wav");
        if (!fs.existsSync(file)) {
          const cand = fs.readdirSync(dir).filter((n) => n.startsWith(base) && /\.wav$/i.test(n));
          if (!cand.length) throw new Error("Render qilingan WAV topilmadi.");
          file = path.join(dir, cand[0]);
        }
        return { path: file, offset: mk ? sec(e, mk.in) : 0, end: mk ? sec(e, mk.out) : (e.end - e.start) / e.fps };
      } finally {
        for (let a = 1; a <= saved.length; a++) { try { await e.tl.SetTrackEnable("audio", a, saved[a - 1]); } catch (err) { /* e'tiborsiz */ } }
        if (job) { try { await e.project.DeleteRenderJob(job); } catch (err) { /* e'tiborsiz */ } }
        if (page) { try { await resolve.OpenPage(page); } catch (err) { /* e'tiborsiz */ } }
      }
    },

    /* SRT: Media Pool'ga import va subtitr trekiga qo'yish */
    async gc_importSrt(srtPath) {
      const e = await env();
      const item = await importOnce(e, srtPath, "Subtitrlar");
      try {
        if ((await e.tl.GetTrackCount("subtitle")) < 1) await e.tl.AddTrack("subtitle");
        const n = await e.tl.GetTrackCount("subtitle");
        const placed = await e.mp.AppendToTimeline([{ mediaPoolItem: item, recordFrame: e.start, trackIndex: n }]);
        if (placed && placed.length) return { item: await item.GetName() };
      } catch (err) { /* quyidagi xabar */ }
      throw new Error("SRT Media Pool'ga qo'shildi (GeminiCut → Subtitrlar). Uni timeline boshiga sudrab qo'ying - Resolve subtitr trekini o'zi yaratadi.");
    },

    async gc_applyMotion(ops) {
      const r = await motionCore(ops);
      if (!r.applied && r.errors.length) throw new Error("Motion qo'llanmadi: " + r.errors.join("; "));
      return r;
    },

    async gc_resetMotion(targets) {
      const e = await env();
      let reset = 0;
      for (const [track, start] of targets) {
        const it = await itemAt(e, "video", track + 1, frameAt(e, start) + 1);
        if (!it) continue;
        const count = typeof it.GetFusionCompCount === "function" ? await it.GetFusionCompCount() : 0;
        if (count > 0) { const comp = await it.GetFusionCompByIndex(1); await fusionRun(comp, buildResetLua()); }
        reset++;
      }
      return { reset };
    },

    /* Playhead ostidagi eng yuqori video klip (Resolve API'da selection yo'q) */
    async gc_getEditContext() {
      const e = await env();
      const ph = await playheadFrame(e);
      const clips = [];
      const nv = await e.tl.GetTrackCount("video");
      for (let v = nv; v >= 1; v--) {
        if (await e.tl.GetIsTrackLocked("video", v)) continue;
        const it = await itemAt(e, "video", v, ph);
        if (!it) continue;
        const i = await itemInfo(it);
        clips.push({ track: v - 1, start: sec(e, i.start), end: sec(e, i.end), name: i.name, inPoint: (await sourceStart(it)) / e.fps,
          speed: 1, path: await itemPath(it), scale: 100, position: [0.5, 0.5], rotation: 0, opacity: 100 });
        break;
      }
      return { clips, source: clips.length ? "playhead" : "none", playhead: sec(e, ph), fps: e.fps,
        width: Number(await e.tl.GetSetting("timelineResolutionWidth")) || 1920, height: Number(await e.tl.GetSetting("timelineResolutionHeight")) || 1080,
        name: await e.tl.GetName(), id: String((await e.tl.GetUniqueId?.()) || "") };
    },

    /* AI zoom: gapirayotgan odamning klipiga Fusion punch-in */
    async gc_applyZooms(zooms, speech) {
      const e = await env();
      state.pendingZooms = { zooms: zooms.slice(), speech: speech.slice(), tl: await e.tl.GetName() };
      const ramp = 0.35, ops = [];
      let skipped = 0;
      const nv = await e.tl.GetTrackCount("video");
      for (const [t0, pct, holdRaw] of zooms.slice().sort((a, b) => a[0] - b[0])) {
        const f0 = frameAt(e, t0);
        let speaker = "";
        for (const s of speech) { const ai = await itemAt(e, "audio", s + 1, f0); if (ai) { speaker = await itemPath(ai); break; } }
        let target = null, tIndex = -1, fallback = null, fIndex = -1;
        for (let v = 1; v <= nv; v++) {
          if (await e.tl.GetIsTrackLocked("video", v)) continue;
          const it = await itemAt(e, "video", v, f0);
          if (!it) continue;
          if (!fallback) { fallback = it; fIndex = v - 1; }
          if (speaker && (await itemPath(it)) === speaker) { target = it; tIndex = v - 1; break; }
        }
        if (!target) { target = fallback; tIndex = fIndex; }
        if (!target) { skipped++; continue; }
        const endSec = sec(e, await target.GetEnd()) - 1 / e.fps;
        const hold = Math.max(0.5, Math.min(8, holdRaw)), p = Math.max(102, Math.min(160, pct));
        const t3 = Math.min(t0 + ramp + hold + ramp, endSec);
        if (t3 - t0 < 0.3) { skipped++; continue; }
        const r = Math.min(ramp, (t3 - t0) / 3);
        ops.push({ track: tIndex, start: sec(e, await target.GetStart()), prop: "scale", mode: "rel", keys: [[t0, 100], [t0 + r, p], [t3 - r, p], [t3, 100]] });
      }
      if (!ops.length) return { applied: 0, skipped };
      const res = await motionCore(ops);
      if (!res.applied && res.errors.length) throw new Error("Zoom qo'llanmadi: " + res.errors.join("; "));
      return { applied: res.applied, skipped: skipped + ops.length - res.applied, errors: res.errors };
    },

    /*
     * Kesish: Resolve API'da blade yo'q - shuning uchun oraliqlarsiz YANGI timeline yaratiladi
     * (V1 dagi klip bo'laklari manbadan qayta yig'iladi, video+audio birga). Asl timeline saqlanadi.
     */
    async gc_applyCuts(ranges, speech) {
      const e = await env();
      const cut = ranges.map(([a, b]) => [frameAt(e, a), frameAt(e, b)]).filter(([a, b]) => b - a >= 2).sort((x, y) => x[0] - y[0]);
      if (!cut.length) return { applied: 0, seconds: 0 };
      const main = await items(e, "video", 1);
      if (!main.length) throw new Error("V1 trekida klip yo'q.");
      const infos = [];
      for (const it of main) {
        const s = await it.GetStart(), t = await it.GetEnd();
        const mpi = await it.GetMediaPoolItem();
        if (!mpi) continue;
        let pieces = [[s, t]];
        for (const [a, b] of cut) {
          pieces = pieces.flatMap(([p, q]) => (b <= p || a >= q ? [[p, q]] : [[p, a], [b, q]].filter(([x, y]) => y - x >= 1)));
        }
        const src = await sourceStart(it);
        for (const [p, q] of pieces) infos.push({ mediaPoolItem: mpi, startFrame: src + (p - s), endFrame: src + (q - s) - 1, _tl: [p, q] });
      }
      const name = (await e.tl.GetName()) + " (GeminiCut)";
      const origName = await e.tl.GetName();
      const newTl = await e.mp.CreateEmptyTimeline(name);
      if (!newTl) throw new Error("Yangi timeline yaratilmadi (bu nom band bo'lishi mumkin: " + name + ").");
      await e.project.SetCurrentTimeline(newTl);
      const placed = await e.mp.AppendToTimeline(infos.map(({ _tl, ...ci }) => ci));
      if (!placed || !placed.length) throw new Error("Yangi timeline'ga klip qo'shilmadi.");
      const removed = cut.reduce((a, [x, y]) => a + (y - x), 0) / e.fps;

      // Oldin so'ralgan zoom'lar yangi timeline vaqtiga o'tkazilib qayta qo'llanadi
      let zoomed = 0;
      const pz = state.pendingZooms;
      state.pendingZooms = null;
      if (pz && pz.tl === origName) {
        const shift = (t) => {
          const f = frameAt(e, t);
          let before = 0;
          for (const [a, b] of cut) { if (f >= a && f < b) return null; if (b <= f) before += b - a; }
          return (f - before - e.start) / e.fps;
        };
        const moved = pz.zooms.map(([t, p, h]) => [shift(t), p, h]).filter(([t]) => t !== null);
        if (moved.length) { try { zoomed = (await api.gc_applyZooms(moved, pz.speech)).applied; } catch (err) { /* asosiy natija - timeline */ } }
      }
      return { applied: cut.length, seconds: removed, newTimeline: name, zoomed };
    },

    async gc_setPlayhead(s) {
      const e = await env();
      await e.tl.SetCurrentTimecode(framesToTc(frameAt(e, Math.max(0, s)), e.fps, e.drop));
      return {};
    },

    /* SFX: playhead joyiga, bo'sh (nutq bo'lmagan) audio trekka; bo'sh trek bo'lmasa yangisi */
    async gc_insertSound(file, trackIndex, at, avoid) {
      const e = await env();
      const mpi = await importOnce(e, file, "SFX");
      const frames = await clipFrames(e, mpi);
      const rec = at >= 0 ? frameAt(e, at) : await playheadFrame(e);
      const free = async (a) => {
        for (const it of await items(e, "audio", a)) { if ((await it.GetStart()) < rec + frames && (await it.GetEnd()) > rec) return false; }
        return true;
      };
      let idx = -1;
      const na = await e.tl.GetTrackCount("audio");
      if (trackIndex >= 0) {
        if (trackIndex >= na) throw new Error(`A${trackIndex + 1} audio trek mavjud emas.`);
        if (await e.tl.GetIsTrackLocked("audio", trackIndex + 1)) throw new Error(`A${trackIndex + 1} qulflangan.`);
        if (!(await free(trackIndex + 1))) throw new Error(`A${trackIndex + 1} da bu joy band. Avtomatik trekni tanlang.`);
        idx = trackIndex + 1;
      } else {
        for (let a = 1; a <= na; a++) {
          if ((avoid || []).includes(a - 1) || (await e.tl.GetIsTrackLocked("audio", a))) continue;
          if (await free(a)) { idx = a; break; }
        }
        if (idx < 0) {
          await e.tl.AddTrack("audio", "stereo");
          const n2 = await e.tl.GetTrackCount("audio");
          if (n2 <= na) throw new Error("Bo'sh audio trek yo'q va yangisi yaratilmadi.");
          idx = n2;
        }
      }
      const placed = await e.mp.AppendToTimeline([{ mediaPoolItem: mpi, startFrame: 0, endFrame: frames - 1, trackIndex: idx, recordFrame: rec, mediaType: 2 }]);
      if (!placed || !placed.length) throw new Error("Effekt timeline'ga qo'yilmadi.");
      return { name: await mpi.GetName(), track: idx - 1, at: sec(e, rec), duration: frames / e.fps };
    },

    /* Kadrlarni PNG qilib eksport (Claude vision uchun); playhead joyi tiklanadi */
    async gc_exportFrames(base, times) {
      const e = await env();
      const saved = await e.tl.GetCurrentTimecode();
      const files = [];
      let page = "", switched = false;
      try {
        for (let i = 0; i < times.length; i++) {
          await e.tl.SetCurrentTimecode(framesToTc(frameAt(e, times[i]), e.fps, e.drop));
          const f = `${base}_${i}.png`;
          let ok = (await e.project.ExportCurrentFrameAsStill(f)) && fs.existsSync(f);
          // Ba'zi versiyalarda kadr faqat Color sahifasida eksport qilinadi
          if (!ok && !switched && typeof resolve.OpenPage === "function") {
            page = (await resolve.GetCurrentPage()) || "edit";
            switched = !!(await resolve.OpenPage("color"));
            if (switched) ok = (await e.project.ExportCurrentFrameAsStill(f)) && fs.existsSync(f);
          }
          if (ok) files.push(f);
        }
      } finally {
        if (saved) { try { await e.tl.SetCurrentTimecode(saved); } catch (err) { /* e'tiborsiz */ } }
        if (switched && page && page !== "color") { try { await resolve.OpenPage(page); } catch (err) { /* e'tiborsiz */ } }
      }
      if (!files.length && times.length) throw new Error("Kadr eksport qilinmadi. Resolve'da Color yoki Edit sahifasida timeline ochiq bo'lsin.");
      return { files };
    },

    /* ---------------- rang berish (ChatGPT) ---------------- */

    /*
     * Rang beriladigan kliplar. scope: "playhead" | "track" (playhead klipining treki) | "all".
     * Media'siz elementlar (titrlar, generatorlar) va GeminiCut matnlari o'tkazib yuboriladi.
     * GeminiCut AI versiyasi yoqilgan klip tahlil oldidan asl versiyasiga qaytariladi.
     */
    async gc_colorTargets(scope) {
      const e = await env();
      const ph = await playheadFrame(e);
      const nv = await e.tl.GetTrackCount("video");
      let tracks = [];
      let phTrack = 0;
      for (let v = nv; v >= 1 && !phTrack; v--) if (await itemAt(e, "video", v, ph) && !(await isTextItem(await itemAt(e, "video", v, ph)))) phTrack = v;
      if (scope === "all") for (let v = 1; v <= nv; v++) tracks.push(v);
      else tracks = [phTrack || 1];
      const clips = [];
      for (const v of tracks) {
        if (!(await e.tl.GetIsTrackEnabled("video", v))) continue;
        for (const it of await items(e, "video", v)) {
          const a = await it.GetStart(), b = await it.GetEnd();
          if (scope === "playhead" && !(a <= ph && b > ph)) continue;
          const mpi = await it.GetMediaPoolItem();
          if (!mpi || (await isTextItem(it))) continue;
          const id = String(await it.GetUniqueId());
          await ensureOriginalVersion(it, id);
          clips.push({ id, name: await it.GetName(), track: v - 1, start: sec(e, a), end: sec(e, b) });
        }
      }
      if (!clips.length) throw new Error(scope === "playhead" ? "Playhead ostida video klip yo'q." : "Rang beriladigan video klip topilmadi.");
      clips.sort((x, y) => x.track - y.track || x.start - y.start);
      return { clips, playhead: sec(e, ph), lutDir: lutDir() };
    },

    /*
     * Klipga LUT qo'yadi. item: { id, name, cube (matn), cdl }. opts.version - alohida "GeminiCut AI"
     * rang versiyasi yaratiladi (asl grade saqlanadi, istalgan payt qaytarish mumkin).
     */
    async gc_applyGrade(item, opts) {
      const e = await env();
      const it = await findItemById(e, item.id);
      if (!it) throw new Error("Klip topilmadi (timeline o'zgargan bo'lishi mumkin).");
      const o = opts || {};
      const method = o.method || "auto"; // auto: Color node LUT (tekshiriladi) -> Fusion LUT -> CDL
      const id = String(item.id);
      const steps = [];
      const name = `GC_${safeName(item.name)}_${Date.now().toString(36)}.cube`;
      // 1) LUT fayli: Resolve LUT papkasi (Color node uchun), bo'lmasa foydalanuvchi papkasi (Fusion uchun)
      let file = "", inLutDir = false;
      for (const dir of [lutDir(), userLutDir()]) {
        try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), item.cube); file = path.join(dir, name); inLutDir = dir === lutDir(); break; }
        catch (err) { steps.push("yozib bo'lmadi: " + dir); }
      }
      let mode = "", versioned = false;

      // 2) Color sahifasi: alohida "GeminiCut AI" versiyasi, 1-node'ga LUT, natija tekshiriladi
      if (method !== "fusion" && inLutDir) {
        await ensureOriginalVersion(it, id);
        if (o.version !== false && typeof it.AddVersion === "function") {
          await it.AddVersion(AI_VERSION, 0);
          versioned = !!(await it.LoadVersionByName(AI_VERSION, 0));
        }
        try { await e.project.RefreshLUTList(); } catch (err) { /* eski versiya */ }
        const rel = path.join(path.basename(lutDir()), name);
        const graph = typeof it.GetNodeGraph === "function" ? await it.GetNodeGraph() : null;
        const nodes = graph && typeof graph.GetNumNodes === "function" ? await graph.GetNumNodes() : -1;
        if (nodes === 0) steps.push("versiyada node yo'q");
        for (const p of nodes === 0 ? [] : [file, rel]) {
          let ok = false;
          if (graph && typeof graph.SetLUT === "function") ok = !!(await graph.SetLUT(1, p));
          if (!ok && typeof it.SetLUT === "function") ok = !!(await it.SetLUT(1, p));
          if (!ok) continue;
          // Haqiqatan qo'yildimi? (GetLUT bor bo'lsa)
          if (graph && typeof graph.GetLUT === "function") {
            const got = String((await graph.GetLUT(1)) || "");
            if (!got || path.basename(got.replace(/\\/g, "/")).toLowerCase() !== name.toLowerCase()) { steps.push("SetLUT tasdiqlanmadi"); continue; }
          }
          mode = "node"; break;
        }
        if (!mode) {
          steps.push("Color node LUT qo'yilmadi");
          // bo'sh AI versiyasini qoldirmaymiz
          if (versioned) {
            const orig = state.origVersion[id] || { versionName: "Version 1", versionType: 0 };
            await it.LoadVersionByName(orig.versionName, orig.versionType);
            if (typeof it.DeleteVersionByName === "function") await it.DeleteVersionByName(AI_VERSION, 0);
            versioned = false;
          }
        }
      }

      // 3) Fusion: FileLUT vositasi - Edit sahifasida darhol ko'rinadi
      if (!mode && method !== "node" && file) {
        try {
          const comp = await fusionComp(it);
          const statusFile = path.join(userLutDir(), `status_${id.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
          try { fs.mkdirSync(path.dirname(statusFile), { recursive: true }); fs.rmSync(statusFile, { force: true }); } catch (err) { /* e'tiborsiz */ }
          await fusionRun(comp, buildGradeLua(file, statusFile));
          let confirmed = false;
          for (let k = 0; k < 15 && !confirmed; k++) {
            if (fs.existsSync(statusFile)) confirmed = true; else await sleep(100);
          }
          mode = "fusion";
          if (!confirmed) steps.push("Fusion natijasi tasdiqlanmadi");
          try { fs.rmSync(statusFile, { force: true }); } catch (err) { /* e'tiborsiz */ }
          state.fusionGraded[id] = true;
        } catch (err) { steps.push("Fusion: " + err.message); }
      }

      // 4) Oxirgi zaxira: CDL
      if (!mode && item.cdl && typeof it.SetCDL === "function") {
        if (await it.SetCDL(Object.assign({ NodeIndex: "1" }, item.cdl))) mode = "cdl";
      }
      if (!mode) {
        throw new Error("Rang qo'yilmadi (" + steps.join("; ") + "). Sozlash → Usul: Fusion ni tanlab qayta urinib ko'ring.");
      }
      return { mode, versioned, lut: file, steps };
    },

    /* GeminiCut rangini olib tashlaydi: AI versiyasi o'chiriladi, Fusion GCGrade olib tashlanadi */
    async gc_revertGrade(ids) {
      const e = await env();
      let reverted = 0;
      for (const id of ids || []) {
        const it = await findItemById(e, id);
        if (!it) continue;
        let done = false;
        if (typeof it.GetCurrentVersion === "function") {
          const cur = await it.GetCurrentVersion();
          const orig = state.origVersion[id] || { versionName: "Version 1", versionType: 0 };
          if (cur && cur.versionName === AI_VERSION && (await it.LoadVersionByName(orig.versionName, orig.versionType))) {
            if (typeof it.DeleteVersionByName === "function") await it.DeleteVersionByName(AI_VERSION, 0);
            done = true;
          }
        }
        if (state.fusionGraded[id] || (typeof it.GetFusionCompCount === "function" && (await it.GetFusionCompCount()) > 0)) {
          try {
            const comp = await it.GetFusionCompByIndex(1);
            if (comp) { await fusionRun(comp, buildGradeResetLua()); if (state.fusionGraded[id]) done = true; }
          } catch (err) { /* e'tiborsiz */ }
          delete state.fusionGraded[id];
        }
        if (done) reverted++;
      }
      return { reverted };
    },

    /* ---------------- animatsion matn (PNG ketma-ketligi) ---------------- */

    /*
     * gc_0000.png ... ketma-ketligini Media Pool'ga (GeminiCut > Matn) import qilib, kerakli joyga qo'yadi.
     * at < 0 -> playhead. replace = { track, start } bo'lsa - o'sha joydagi eski matn almashtiriladi.
     */
    async gc_importSequence(first, count, fps, at, replace, name) {
      const e = await env();
      const p = await placeSequence(e, first, count, at, replace, name);
      return { track: p.idx - 1, seconds: sec(e, p.rec), duration: p.frames / e.fps };
    },

    /*
     * Tahrirlanadigan matn/logo: PNG kadrlar zaxira sifatida qo'yiladi, so'ng klipga Fusion kompozitsiya
     * qo'shilib, ichida Text+ / 3D sahna quriladi. Qurilmasa - PNG klip o'zi qoladi (mode: "png").
     */
    async gc_insertNative(spec, first, count, fps, at, replace, name) {
      const e = await env();
      const p = await placeSequence(e, first, count, at, replace, name);
      const base = { track: p.idx - 1, seconds: sec(e, p.rec), duration: p.frames / e.fps };
      if (!p.item) return Object.assign(base, { mode: "png", reason: "Qo'yilgan klip topilmadi" });
      const statusFile = path.join(path.dirname(first), "native-status.txt");
      try { fs.unlinkSync(statusFile); } catch (err) { /* yo'q */ }
      let reason = "";
      try {
        const W = Number(spec.W) || Number(await e.tl.GetSetting("timelineResolutionWidth")) || 1920;
        const H = Number(spec.H) || Number(await e.tl.GetSetting("timelineResolutionHeight")) || 1080;
        const comp = await fusionComp(p.item);
        await fusionRun(comp, spec.logo ? buildNativeLogoLua(spec, W, H, e.fps, statusFile, spec.img) : buildNativeTextLua(spec, W, H, e.fps, statusFile));
        let txt = "";
        for (let k = 0; k < 20 && !txt; k++) {
          if (fs.existsSync(statusFile)) txt = String(fs.readFileSync(statusFile, "utf8"));
          else await sleep(100);
        }
        if (/^ok/.test(txt)) return Object.assign(base, { mode: "native", warnings: txt.split(/\r?\n/).slice(1).filter(Boolean) });
        reason = txt ? txt.replace(/^xato:\s*/, "") : "Fusion javob bermadi";
        await fusionRun(comp, buildNativeRestoreLua());
      } catch (err) {
        reason = (err && err.message) || String(err);
      }
      return Object.assign(base, { mode: "png", reason });
    },

    /* Playhead ostidagi GeminiCut matni (tahrirlash uchun) */
    async gc_textAtPlayhead() {
      const e = await env();
      const ph = await playheadFrame(e);
      const nv = await e.tl.GetTrackCount("video");
      for (let v = nv; v >= 1; v--) {
        const it = await itemAt(e, "video", v, ph);
        if (it && (await isTextItem(it))) {
          return { track: v - 1, start: sec(e, await it.GetStart()), end: sec(e, await it.GetEnd()), path: await itemPath(it, true) };
        }
      }
      throw new Error("Playhead ostida GeminiCut matni yo'q. Playhead'ni matn ustiga qo'ying.");
    },
  };

  /* Har bir funksiya {ok:true,...} yoki {ok:false,error} qaytaradi (Premiere versiyasi bilan bir xil) */
  const wrapped = {};
  for (const [name, fn] of Object.entries(api)) {
    wrapped[name] = async (...args) => {
      try { return Object.assign({ ok: true }, await fn(...args)); }
      catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
    };
  }
  return wrapped;
}

module.exports = { createHost, buildMotionLua, buildResetLua, buildGradeLua, buildGradeResetLua, buildNativeTextLua, buildNativeLogoLua, buildNativeRestoreLua, tcToFrames, framesToTc, VERSION };
