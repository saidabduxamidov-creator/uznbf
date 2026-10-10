/**
 * Python run inside Blender (`blender -b --python-expr`). The scripts are constants: user values
 * never become code, they arrive as JSON in the LMP_BLENDER_PARAMS environment variable.
 */

/** Builds an animated 3D title on a transparent background and renders it as a PNG sequence. */
export const TEXT3D_SCRIPT = String.raw`
import bpy, json, math, os, sys
p = json.loads(os.environ["LMP_BLENDER_PARAMS"])

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = {"eevee": "BLENDER_EEVEE_NEXT" if bpy.app.version >= (4, 2, 0) else "BLENDER_EEVEE", "cycles": "CYCLES", "workbench": "BLENDER_WORKBENCH"}[p["engine"]]
if p["engine"] == "cycles":
    scene.cycles.samples = p["samples"]
    scene.cycles.use_denoising = True
elif p["engine"] == "eevee":
    try:
        scene.eevee.taa_render_samples = p["samples"]
    except AttributeError:
        pass
scene.render.resolution_x = p["width"]
scene.render.resolution_y = p["height"]
scene.render.resolution_percentage = 100
scene.render.fps = p["fps"]
scene.frame_start = 1
scene.frame_end = p["frames"]
scene.render.film_transparent = True
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.filepath = os.path.join(p["outputDir"], "title_")

bpy.ops.object.text_add(location=(0, 0, 0))
obj = bpy.context.object
obj.data.body = p["text"]
obj.data.align_x = "CENTER"
obj.data.align_y = "CENTER"
obj.data.extrude = p["extrude"]
obj.data.bevel_depth = p["bevel"]
obj.data.bevel_resolution = 4
obj.data.space_line = 1.1
if p.get("font"):
    obj.data.font = bpy.data.fonts.load(p["font"])
obj.rotation_euler = (math.radians(90), 0, 0)

mat = bpy.data.materials.new("Title")
mat.use_nodes = True
bsdf = mat.node_tree.nodes.get("Principled BSDF")
r, g, b = p["color"]
bsdf.inputs["Base Color"].default_value = (r, g, b, 1)
bsdf.inputs["Metallic"].default_value = p["metallic"]
bsdf.inputs["Roughness"].default_value = p["roughness"]
obj.data.materials.append(mat)

# Fit the camera to the text block.
bpy.context.view_layer.update()
dims = obj.dimensions
cam_data = bpy.data.cameras.new("Camera")
cam_data.lens = 50
cam = bpy.data.objects.new("Camera", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
aspect = p["width"] / p["height"]
span = max(dims.x / aspect, dims.y if dims.y > 0 else dims.z, 0.5) * 1.6
distance = span * cam_data.lens / cam_data.sensor_width * max(1.0, aspect)
cam.location = (0, -distance, 0)
cam.rotation_euler = (math.radians(90), 0, 0)

def light(name, kind, energy, loc, rot):
    data = bpy.data.lights.new(name, kind)
    data.energy = energy
    o = bpy.data.objects.new(name, data)
    o.location = loc
    o.rotation_euler = rot
    scene.collection.objects.link(o)

light("Key", "AREA", 400 * span, (span, -distance, span), (math.radians(60), 0, math.radians(30)))
light("Fill", "AREA", 150 * span, (-span, -distance, 0), (math.radians(80), 0, math.radians(-30)))
light("Rim", "AREA", 300 * span, (0, distance, span), (math.radians(-60), 0, 0))
world = bpy.data.worlds.new("World")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
scene.world = world

end_in = max(2, int(p["frames"] * 0.4))
def key(frame, **values):
    for attr, value in values.items():
        setattr(obj, attr, value)
        obj.keyframe_insert(data_path=attr, frame=frame)

anim = p["animation"]
if anim == "spin":
    key(1, rotation_euler=(math.radians(90), 0, math.radians(-180)), scale=(0.2, 0.2, 0.2))
    key(end_in, rotation_euler=(math.radians(90), 0, 0), scale=(1, 1, 1))
elif anim == "rise":
    key(1, location=(0, 0, -span * 0.6))
    key(end_in, location=(0, 0, 0))
elif anim == "pop":
    key(1, scale=(0.01, 0.01, 0.01))
    key(max(2, int(end_in * 0.7)), scale=(1.12, 1.12, 1.12))
    key(end_in, scale=(1, 1, 1))
elif anim == "swing":
    key(1, rotation_euler=(math.radians(90), math.radians(-35), 0))
    key(end_in, rotation_euler=(math.radians(90), 0, 0))
if anim != "none":
    key(p["frames"], rotation_euler=tuple(obj.rotation_euler) if anim != "spin" else (math.radians(90), 0, math.radians(8)))
    for fc in (obj.animation_data.action.fcurves if obj.animation_data and obj.animation_data.action else []):
        for kp in fc.keyframe_points:
            kp.interpolation = "BEZIER"
            kp.easing = "EASE_OUT"

bpy.ops.render.render(animation=True)
print("LMP_DONE", json.dumps({"frames": p["frames"], "dir": p["outputDir"]}))
sys.stdout.flush()
`;

/** Prints scene facts of a .blend file as one JSON line. */
export const INSPECT_SCRIPT = String.raw`
import bpy, json
s = bpy.context.scene
print("LMP_INFO", json.dumps({
    "version": bpy.app.version_string,
    "scene": s.name,
    "engine": s.render.engine,
    "frameStart": s.frame_start,
    "frameEnd": s.frame_end,
    "fps": s.render.fps / s.render.fps_base,
    "width": s.render.resolution_x * s.render.resolution_percentage // 100,
    "height": s.render.resolution_y * s.render.resolution_percentage // 100,
    "camera": s.camera.name if s.camera else None,
    "scenes": [x.name for x in bpy.data.scenes],
    "objects": len(s.objects),
}))
`;
