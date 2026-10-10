/**
 * Photoshop automation through its COM interface (Windows): a PowerShell host receives one
 * request (operation + parameters) as base64 JSON on stdin and calls Photoshop's DoJavaScript with
 * a constant ExtendScript. Parameters reach ExtendScript as a JSON literal argument, so user values
 * stay data: JSON.stringify escapes every quote and backslash, and the two characters ES3 treats
 * as line breaks inside strings are escaped too.
 */

/** ExtendScript prelude: parses the request and serialises the reply (ES3 has no JSON object). */
const ES_PRELUDE = `
var P = eval("(" + arguments[0] + ")");
function q(s) { return '"' + String(s).replace(/[\\\\"]/g, function (c) { return "\\\\" + c; }).replace(/[\\u0000-\\u001f\\u2028\\u2029]/g, function (c) { return "\\\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4); }) + '"'; }
function J(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return q(v);
  if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(J(v[i])); return "[" + a.join(",") + "]"; }
  var o = []; for (var k in v) if (v.hasOwnProperty(k)) o.push(q(k) + ":" + J(v[k])); return "{" + o.join(",") + "}";
}
app.displayDialogs = DialogModes.NO;
function openDoc(path) { var f = new File(path); if (!f.exists) throw new Error("File not found: " + path); return app.open(f); }
function findLayer(container, name) {
  for (var i = 0; i < container.layers.length; i++) {
    var l = container.layers[i];
    if (l.name === name) return l;
    if (l.typename === "LayerSet") { var r = findLayer(l, name); if (r) return r; }
  }
  return null;
}
function exportDoc(doc, path, format, quality, longSide) {
  var copy = doc.duplicate();
  try {
    if (longSide) {
      var w = copy.width.as("px"), h = copy.height.as("px"), s = longSide / Math.max(w, h);
      if (s < 1) copy.resizeImage(UnitValue(Math.round(w * s), "px"), UnitValue(Math.round(h * s), "px"), copy.resolution, ResampleMethod.BICUBICSHARPER);
    }
    var f = new File(path);
    if (format === "png") { var o = new PNGSaveOptions(); o.compression = 6; copy.saveAs(f, o, true, Extension.LOWERCASE); }
    else { if (copy.mode !== DocumentMode.RGB) copy.changeMode(ChangeMode.RGB); copy.flatten(); var j = new JPEGSaveOptions(); j.quality = quality; j.embedColorProfile = true; copy.saveAs(f, j, true, Extension.LOWERCASE); }
    return { path: f.fsName, width: copy.width.as("px"), height: copy.height.as("px") };
  } finally { copy.close(SaveOptions.DONOTSAVECHANGES); }
}
`;

export const ES_OPERATIONS = {
  status: `${ES_PRELUDE}
var docs = []; for (var i = 0; i < app.documents.length; i++) { var d = app.documents[i]; docs.push({ name: d.name, width: d.width.as("px"), height: d.height.as("px"), path: (function () { try { return d.fullName.fsName; } catch (e) { return null; } })() }); }
J({ version: app.version, documents: docs, active: app.documents.length ? app.activeDocument.name : null });`,

  replaceText: `${ES_PRELUDE}
var doc = openDoc(P.template);
var done = [], missing = [];
try {
  for (var name in P.texts) {
    if (!P.texts.hasOwnProperty(name)) continue;
    var layer = findLayer(doc, name);
    if (!layer || layer.kind !== LayerKind.TEXT) { missing.push(name); continue; }
    layer.textItem.contents = P.texts[name].replace(/\\n/g, "\\r");
    done.push(name);
  }
  for (var hname in P.visibility) if (P.visibility.hasOwnProperty(hname)) { var hl = findLayer(doc, hname); if (hl) hl.visible = P.visibility[hname]; else missing.push(hname); }
  var out = exportDoc(doc, P.output, P.format, P.quality, P.longSide);
} finally { doc.close(SaveOptions.DONOTSAVECHANGES); }
J({ replaced: done, missing: missing, output: out });`,

  runAction: `${ES_PRELUDE}
var results = [];
for (var i = 0; i < P.files.length; i++) {
  var doc = openDoc(P.files[i]);
  try {
    app.doAction(P.action, P.set);
    var base = doc.name.replace(/\\.[^.]+$/, "");
    results.push(exportDoc(doc, P.outputDir + "/" + base + P.suffix + "." + (P.format === "png" ? "png" : "jpg"), P.format, P.quality, P.longSide));
  } finally { doc.close(SaveOptions.DONOTSAVECHANGES); }
}
J({ files: results });`,

  layers: `${ES_PRELUDE}
var doc = openDoc(P.path);
var out = [];
function walk(c, prefix) { for (var i = 0; i < c.layers.length; i++) { var l = c.layers[i]; out.push({ name: l.name, path: prefix + l.name, kind: l.typename === "LayerSet" ? "group" : String(l.kind).replace("LayerKind.", "").toLowerCase(), visible: l.visible, text: (l.typename !== "LayerSet" && l.kind === LayerKind.TEXT) ? l.textItem.contents : null }); if (l.typename === "LayerSet") walk(l, prefix + l.name + "/"); } }
try { walk(doc, ""); var info = { width: doc.width.as("px"), height: doc.height.as("px") }; } finally { doc.close(SaveOptions.DONOTSAVECHANGES); }
J({ width: info.width, height: info.height, layers: out });`,
} as const;

export type EsOperation = keyof typeof ES_OPERATIONS;

/** PowerShell COM host. Exit code 5: Photoshop is not installed (no COM registration). */
export const PS_HOST = `
$ErrorActionPreference = 'Stop'
$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json
try { $ps = New-Object -ComObject Photoshop.Application } catch { [Console]::Error.Write('Photoshop is not installed (COM class Photoshop.Application is not registered).'); exit 5 }
try {
  $result = $ps.DoJavaScript($req.code, @($req.params), 1)
} catch {
  [Console]::Error.Write("Photoshop: " + $_.Exception.Message); exit 6
}
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$result)))
`;

/** JSON for embedding in ExtendScript via eval: valid ES3 expression, data only. */
export function esJson(value: unknown): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
