"""
host.js yaratadigan Fusion Lua skriptlarini haqiqiy Lua'da (lupa) Fusion taqlidiga qarshi ishga tushiradi:
sintaksis, zanjir ulanishi (MediaIn -> GCTransform -> GCFade -> MediaOut), kalitlar va reset tekshiriladi.
  python3 tests/fusion_lua_check.py
"""
import json, subprocess, sys, os
from lupa import LuaRuntime

here = os.path.dirname(os.path.abspath(__file__))
js = r"""
const h = require(process.argv[1]);
const lua = h.buildMotionLua({ size: [[0, 1], [9, 1.15], [50, 1]], center: [[0, 0.5, 0.5], [50, 0.485, 0.495]], angle: [[0, 0], [10, 3]], gain: [[0, 0], [12, 1]] });
const lua2 = h.buildMotionLua({ size: [[0, 1], [20, 1.2]] });
const st = require('path').join(require('os').tmpdir(), 'gc_grade_status.txt');
try { require('fs').unlinkSync(st); } catch (e) {}
console.log(JSON.stringify({ lua, lua2, reset: h.buildResetLua(), grade: h.buildGradeLua('C:\\LUT\\GeminiCut\\GC_a.cube', st), gradeReset: h.buildGradeResetLua(), status: st }));
"""
out = json.loads(subprocess.check_output(["node", "-e", js, os.path.join(here, "..", "host.js")]))

STUB = r"""
local function Output(tool) return { tool = tool, inputs = {}, GetConnectedInputs = function(self) local r = {} for _, i in ipairs(self.inputs) do table.insert(r, i) end return r end } end
local function Input(owner)
  local inp = { owner = owner, src = nil }
  function inp:GetConnectedOutput() return self.src end
  function inp:ConnectTo(o) if self.src then for k, v in ipairs(self.src.inputs) do if v == self then table.remove(self.src.inputs, k) break end end end self.src = o if o then table.insert(o.inputs, self) end end
  return inp
end
local tools = {}
local function Tool(name, kind)
  local t = { name = name, kind = kind, attrs = {}, values = {} }
  t.Output = Output(t)
  local inputObj = Input(t)
  local mt = {}
  mt.__index = function(self, k)
    if k == "Input" then return inputObj end
    return rawget(self.values, k)
  end
  mt.__newindex = function(self, k, v)
    if k == "Input" then inputObj:ConnectTo(v) return end
    rawset(self.values, k, v)
  end
  t.SetAttrs = function(self, a) if a.TOOLS_Name then tools[self.name] = nil; self.name = a.TOOLS_Name; tools[self.name] = self end end
  t.Delete = function(self) inputObj:ConnectTo(nil) tools[self.name] = nil end
  t.GetInput = function(self, k) return rawget(self.values, k) end
  setmetatable(t, mt)
  tools[name] = t
  return t
end
local mi = Tool("MediaIn1", "MediaIn")
local mo = Tool("MediaOut1", "MediaOut")
mo.Input = mi.Output
local n = 0
comp = {
  locked = 0,
  Lock = function(self) self.locked = self.locked + 1 end,
  Unlock = function(self) self.locked = self.locked - 1 end,
  FindTool = function(self, name) return tools[name] end,
  AddTool = function(self, kind) n = n + 1 return Tool(kind .. n, kind) end,
  GetAttrs = function(self) return { COMPN_RenderStart = 1000 } end,
  BezierSpline = function(self) return setmetatable({ keys = {} }, { __newindex = function(s, k, v) rawget(s, "keys")[k] = v end }) end,
  XYPath = function(self) return setmetatable({ keys = {} }, { __newindex = function(s, k, v) rawget(s, "keys")[k] = v end }) end,
}
function chainNames()
  local names, o = {}, tools["MediaOut1"].Input:GetConnectedOutput()
  while o do table.insert(names, 1, o.tool.name) o = o.tool.Input:GetConnectedOutput() end
  return table.concat(names, " > ")
end
function keysOf(tool, input)
  local sp = tools[tool] and tools[tool].values[input]
  if not sp then return "" end
  local ks = {}
  for k, v in pairs(sp.keys) do table.insert(ks, k) end
  table.sort(ks)
  local parts = {}
  for _, k in ipairs(ks) do local v = sp.keys[k] if type(v) == "table" then v = v[1] .. "/" .. v[2] end table.insert(parts, k .. "=" .. tostring(v)) end
  return table.concat(parts, ",")
end
"""

def run(*scripts):
    lua = LuaRuntime(unpack_returned_tuples=True)
    lua.execute(STUB)
    for s in scripts:
        lua.execute(s)
    return lua

ok = True
def check(cond, msg):
    global ok
    print(("  ✓ " if cond else "  ✗ ") + msg)
    ok = ok and cond

L = run(out["lua"])
g = L.globals()
check(g.chainNames() == "MediaIn1 > GCTransform > GCFade", "zanjir: MediaIn1 > GCTransform > GCFade > MediaOut1 (" + g.chainNames() + ")")
check(g.keysOf("GCTransform", "Size") == "1000=1,1009=1.15,1050=1", "Size kalitlari COMPN_RenderStart (1000) ga nisbatan: " + g.keysOf("GCTransform", "Size"))
check(g.keysOf("GCTransform", "Center") == "1000=0.5/0.5,1050=0.485/0.495", "Center (XYPath): " + g.keysOf("GCTransform", "Center"))
check(g.keysOf("GCTransform", "Angle") == "1000=0,1010=3", "Angle: " + g.keysOf("GCTransform", "Angle"))
check(g.keysOf("GCFade", "Gain") == "1000=0,1012=1", "Fade Gain: " + g.keysOf("GCFade", "Gain"))
check(g.comp.locked == 0, "Lock/Unlock muvozanatda")

L = run(out["lua"], out["lua2"])
g = L.globals()
check(g.chainNames() == "MediaIn1 > GCTransform > GCFade", "qayta qo'llash yangi vosita qo'shmaydi")
check(g.keysOf("GCTransform", "Size") == "1000=1,1020=1.2", "Size yangilandi, eskisi almashtirildi")
check(g.keysOf("GCTransform", "Center") != "", "boshqa parametrlar (Center) saqlanib qoldi")

L = run(out["lua"], out["reset"])
g = L.globals()
check(g.chainNames() == "MediaIn1", "reset: GeminiCut vositalari o'chirildi, MediaIn1 > MediaOut1 tiklandi (" + g.chainNames() + ")")

# --- rang (Fusion FileLUT zaxirasi) ---
L = run(out["grade"])
g = L.globals()
check(g.chainNames() == "MediaIn1 > GCGrade", "rang: MediaIn1 > GCGrade(FileLUT) > MediaOut1 (" + g.chainNames() + ")")
gt = L.eval('comp:FindTool("GCGrade")')
check(gt["kind"] == "FileLUT" and gt["values"]["LUTFile"] == "C:\\LUT\\GeminiCut\\GC_a.cube", "FileLUT vositasi, LUTFile yo'li to'g'ri: " + str(gt["values"]["LUTFile"]))
check(os.path.exists(out["status"]) and open(out["status"]).read().endswith("GC_a.cube"), "tekshiruv fayli (io.open) yozildi")
check(g.comp.locked == 0, "rang: Lock/Unlock muvozanatda")
L = run(out["lua"], out["grade"], out["grade"])
check(L.globals().chainNames() == "MediaIn1 > GCGrade > GCTransform > GCFade", "motion + rang: rang MediaIn'dan keyin, takrorlanmaydi (" + L.globals().chainNames() + ")")
L = run(out["grade"], out["lua"])
check(L.globals().chainNames() == "MediaIn1 > GCGrade > GCTransform > GCFade", "rang + motion: tartib to'g'ri (" + L.globals().chainNames() + ")")
L = run(out["lua"], out["grade"], out["gradeReset"])
check(L.globals().chainNames() == "MediaIn1 > GCTransform > GCFade", "rangni olib tashlash motion'ga tegmaydi (" + L.globals().chainNames() + ")")

print("\nHammasi muvaffaqiyatli." if ok else "\nXATO bor.")
sys.exit(0 if ok else 1)
