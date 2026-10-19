"""ZCode Live Bridge：装进用户的 Blender GUI，让 ZCode 直连正在运行的 Blender。

与官方插件的 headless 通道（bridge.py，stdin/stdout，Blender 由 ZCode 拉起）互补：
本插件在 Blender 里开一个本地 TCP 服务（默认 127.0.0.1:9878），live-server.mjs
以 MCP stdio 服务的形式转发工具调用。架构参考 mcp-for-blender（MIT）：
socket 线程收请求 → queue → 主线程唯一 persistent timer 统一执行（bpy.app.timers
不是线程安全的，绝不能从 socket 线程注册 timer）。

协议：TCP 上每行一个 JSON 请求 {"id", "cmd", "args"}，每行一个 JSON 响应
{"id", "ok", "result"|"error"}。端口用 9878 以避开上游 blender-mcp 的 9876。

命令：ping / get_scene_info / get_object_info / execute_code / viewport_screenshot /
polyhaven_status / polyhaven_search / polyhaven_import / addon_status。
PolyHaven 只做无 key 的三件套（模型/贴图/HDRI），AI 生成类（Tripo/Hyper3D 等）
需要各自 API key，本插件不内置。
"""

import base64
import gzip
import hashlib
import io
import json
import os
import queue
import re
import socket
import tempfile
import threading
import time
import traceback
import urllib.parse
import urllib.request
from contextlib import redirect_stdout

import bpy

bl_info = {
    "name": "ZCode Live Bridge",
    "author": "sanqiuyef",
    "version": (0, 3, 0),
    "blender": (3, 2, 0),
    "location": "3D 视口侧栏（N 面板）> ZCode Live",
    "description": "在运行中的 Blender GUI 里开本地 socket 服务，供 ZCode 执行代码、截视口、查场景、导入 PolyHaven 资产",
    "category": "Interface",
}

ADDON_VERSION = ".".join(str(v) for v in bl_info["version"])
DEFAULT_PORT = 9878
SHOT_DIR = os.path.join(tempfile.gettempdir(), "zcode_live_bridge")

POLYHAVEN_API = "https://api.polyhaven.com"
POLYHAVEN_SITE = "https://polyhaven.com"
POLYHAVEN_TIMEOUT = 20
POLYHAVEN_FILE_TIMEOUT = 300
POLYHAVEN_CHUNK = 1 << 16
# /files 的 map 键 → Principled 输入。键名大小写在 API 里是 load-bearing 的。
POLYHAVEN_TEXTURE_MAPS = {
    "Diffuse": "base_color",
    "Rough": "roughness",
    "Metal": "metallic",
    "Displacement": "displacement",
    "nor_gl": "normal",
    "nor_dx": "normal",
}
POLYHAVEN_COLOR_ROLES = {"base_color"}
POLYHAVEN_SUPPORTED_FORMATS = {"hdris": ("hdr", "exr"), "textures": ("jpg", "png", "exr"), "models": ("blend",)}
POLYHAVEN_DEFAULT_FORMATS = {"hdris": "hdr", "textures": "jpg", "models": "blend"}
POLYHAVEN_SLUG_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")

_META_CACHE = {}  # asset_type -> {"fetched": ts, "data": {slug: record}}
_META_TTL = 600


class LiveError(Exception):
    pass


# ---------------------------------------------------------------------------
# PolyHaven HTTP（urllib，Blender 自带 Python 不保证有 requests）
# ---------------------------------------------------------------------------


def _http_get(url, timeout=POLYHAVEN_TIMEOUT):
    request = urllib.request.Request(url, headers={"User-Agent": "zcode-live-bridge"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def _polyhaven_api(path):
    payload = _http_get(f"{POLYHAVEN_API}/{path}", POLYHAVEN_TIMEOUT)
    return json.loads(payload.decode("utf-8"))


def _polyhaven_download(file_info, dest_path):
    """流式下载一个文件并校验 API 给出的 md5。"""
    response = urllib.request.urlopen(
        urllib.request.Request(file_info["url"], headers={"User-Agent": "zcode-live-bridge"}),
        timeout=POLYHAVEN_FILE_TIMEOUT,
    )
    digest = hashlib.md5()
    try:
        with open(dest_path, "wb") as handle:
            while True:
                chunk = response.read(POLYHAVEN_CHUNK)
                if not chunk:
                    break
                digest.update(chunk)
                handle.write(chunk)
    finally:
        response.close()
    expected = file_info.get("md5")
    if expected and digest.hexdigest() != expected:
        try:
            os.unlink(dest_path)
        except OSError:
            pass
        raise LiveError(f"{os.path.basename(dest_path)} 下载不完整（md5 不匹配）")


def _polyhaven_meta(asset_types):
    """按类型取 /assets 元数据并缓存；返回 {slug: record}。"""
    result = {}
    now = time.time()
    for asset_type in asset_types:
        entry = _META_CACHE.get(asset_type)
        if entry is None or now - entry["fetched"] > _META_TTL:
            entry = {"fetched": now, "data": _polyhaven_api(f"assets?t={asset_type}")}
            _META_CACHE[asset_type] = entry
        result.update(entry["data"])
    return result


def _polyhaven_summarize(slug, record, asset_type):
    thumb = record.get("thumbnail") or ""
    if thumb and "width=" in thumb:
        # CDN 支持按 query 参数缩放，顺便压小预览图。
        thumb = re.sub(r"width=\d+", "width=256", thumb)
        thumb = re.sub(r"height=\d+", "height=256", thumb)
    return {
        "id": slug,
        "type": asset_type,
        "name": record.get("name") or slug,
        "categories": (record.get("categories") or [])[:4],
        "tags": (record.get("tags") or [])[:5],
        "resolutions": sorted((record.get("resolutions") or []), reverse=True)[:6],
        "thumbnail": thumb,
        "url": f"{POLYHAVEN_SITE}/a/{slug}",
    }


def _polyhaven_search(query, asset_type, limit):
    """/search 返回的顺序就是融合排序，不许再按 score 重排。"""
    asset_types = ["models", "textures", "hdris"] if asset_type in (None, "", "all") else [asset_type]
    ranked = {}
    try:
        params = urllib.parse.urlencode({"q": query})
        payload = _polyhaven_api(f"search?{params}")
        for i, row in enumerate(payload.get("results") or []):
            slug = row.get("slug")
            if slug:
                ranked[slug] = i
    except Exception as error:  # noqa: BLE001 - 搜索失败退回本地关键词匹配
        ranked = None
        search_error = str(error)

    meta = _polyhaven_meta(asset_types)
    if ranked is None:
        terms = [t for t in query.lower().split() if t]
        scored = []
        for slug, record in meta.items():
            haystack = " ".join([
                slug.replace("_", " "),
                str(record.get("name") or ""),
                " ".join(record.get("tags") or []),
                " ".join(record.get("categories") or []),
            ]).lower()
            hits = sum(1 for term in terms if term in haystack)
            if hits:
                scored.append((hits, record.get("download_count", 0), slug))
        scored.sort(reverse=True)
        slugs = [s for *_rest, s in scored]
        search_error = None
    else:
        slugs = [s for s, _i in sorted(ranked.items(), key=lambda kv: kv[1])]

    items = []
    for slug in slugs:
        record = meta.get(slug)
        if not isinstance(record, dict) or "name" not in record:
            continue
        items.append(_polyhaven_summarize(slug, record, record.get("type_name") or _type_name_of(record)))
        if len(items) >= limit:
            break
    result = {"query": query, "count": len(items), "items": items}
    if search_error:
        result["note"] = f"在线搜索不可用（{search_error}），已退回本地关键词匹配"
    return result


def _type_name_of(record):
    return {0: "hdris", 1: "textures", 2: "models"}.get(record.get("type"), "models")


def _polyhaven_authors(asset_id):
    try:
        record = _polyhaven_api(f"info/{urllib.parse.quote(asset_id, safe='')}")
    except Exception:  # noqa: BLE001 - 作者信息拿不到不阻塞导入
        return []
    authors = record.get("authors") or {}
    return [value.get("author") or key for key, value in authors.items()]


def _polyhaven_tag(datablocks, asset_id, resolution):
    authors = _polyhaven_authors(asset_id)
    for block in datablocks:
        if block is None:
            continue
        block["polyhaven_id"] = asset_id
        block["polyhaven_url"] = f"{POLYHAVEN_SITE}/a/{asset_id}"
        block["polyhaven_authors"] = ", ".join(authors)
        block["polyhaven_resolution"] = resolution


def _blend_version(path):
    """读 .blend 头部的版本号；返回 (major, minor) 或 None。"""
    try:
        with open(path, "rb") as handle:
            head = handle.read(15)
        if head[:2] == b"\x1f\x8b":
            with gzip.open(path, "rb") as gz:
                head = gz.read(15)
        if head[:7] != b"BLENDER":
            return None
        return int(head[9:10]), int(head[10:11]) + int(head[11:12]) / 10
    except Exception:  # noqa: BLE001
        return None


def _append_blend_collection(blend_path, asset_id):
    """只 append 资产自己的集合；LOD 取 LOD0 全精度版。"""
    with bpy.data.libraries.load(blend_path, link=False) as (data_from, data_to):
        available = list(data_from.collections)
        wanted = next((name for name in (f"{asset_id}_LOD0", asset_id) if name in available), None)
        if wanted:
            data_to.collections = [wanted]
        else:
            data_to.objects = data_from.objects
    linked = []
    for collection in data_to.collections:
        if collection is not None:
            bpy.context.scene.collection.children.link(collection)
            linked.append(collection)
    if not linked:
        for obj in data_to.objects:
            if obj is not None:
                bpy.context.collection.objects.link(obj)
    return linked


def _build_principled_material(asset_id, maps):
    """从 {map键: (角色, image)} 搭一个 Principled 材质。"""
    material = bpy.data.materials.new(name=asset_id)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new(type="ShaderNodeOutputMaterial")
    output.location = (500, 0)
    principled = nodes.new(type="ShaderNodeBsdfPrincipled")
    principled.location = (200, 0)
    links.new(principled.outputs[0], output.inputs["Surface"])
    tex_coord = nodes.new(type="ShaderNodeTexCoord")
    tex_coord.location = (-700, 0)
    y = 300
    wired = []
    for map_key, (role, image) in maps.items():
        tex = nodes.new(type="ShaderNodeTexImage")
        tex.location = (-400, y)
        tex.image = image
        image.colorspace_settings.name = "sRGB" if role in POLYHAVEN_COLOR_ROLES else "Non-Color"
        links.new(tex_coord.outputs["UV"], tex.inputs["Vector"])
        y -= 300
        if role == "base_color":
            links.new(tex.outputs["Color"], principled.inputs["Base Color"])
        elif role == "roughness":
            links.new(tex.outputs["Color"], principled.inputs["Roughness"])
        elif role == "metallic":
            links.new(tex.outputs["Color"], principled.inputs["Metallic"])
        elif role == "normal":
            normal_map = nodes.new(type="ShaderNodeNormalMap")
            normal_map.location = (-100, y + 300)
            links.new(tex.outputs["Color"], normal_map.inputs["Color"])
            links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])
        elif role == "displacement":
            disp = nodes.new(type="ShaderNodeDisplacement")
            disp.location = (200, y + 300)
            disp.inputs["Midlevel"].default_value = 0.5
            disp.inputs["Scale"].default_value = 0.1
            links.new(tex.outputs["Color"], disp.inputs["Height"])
            links.new(disp.outputs["Displacement"], output.inputs["Displacement"])
            if hasattr(material, "displacement_method"):
                material.displacement_method = "BOTH"
        else:
            continue
        wired.append(map_key)
    return material, wired


# ---------------------------------------------------------------------------
# 命令实现（全部在主线程跑）
# ---------------------------------------------------------------------------


def _vec(v, digits=4):
    return [round(float(x), digits) for x in v]


def cmd_ping(args):
    scene = bpy.context.scene
    return {
        "addon": ADDON_VERSION,
        "blender": bpy.app.version_string,
        "scene": scene.name,
        "objects": len(scene.objects),
        "file": bpy.data.filepath or None,
        "polyhaven": bool(scene.zcode_live.polyhaven_enabled),
    }


def cmd_addon_status(args):
    scene = bpy.context.scene
    reachable = None
    try:
        _http_get(f"{POLYHAVEN_API}/status", 5)
        reachable = True
    except Exception:  # noqa: BLE001
        reachable = False
    return {
        "addon": ADDON_VERSION,
        "blender": bpy.app.version_string,
        "engine": scene.render.engine,
        "camera": scene.camera.name if scene.camera else None,
        "objects": len(scene.objects),
        "scenes": len(bpy.data.scenes),
        "polyhaven_enabled": bool(bpy.context.scene.zcode_live.polyhaven_enabled),
        "polyhaven_api_reachable": reachable,
    }


def cmd_get_scene_info(args):
    scene = bpy.context.scene
    objects = []
    for obj in scene.objects:
        entry = {
            "name": obj.name,
            "type": obj.type,
            "location": _vec(obj.matrix_world.translation),
            "dimensions": _vec(obj.dimensions),
            "materials": [slot.material.name for slot in obj.material_slots if slot.material],
        }
        if obj.type == "MESH":
            entry["faces"] = len(obj.data.polygons)
        objects.append(entry)
    return {
        "scene": scene.name,
        "file": bpy.data.filepath or None,
        "objects": objects,
        "counts": {"objects": len(objects), "meshes": sum(1 for o in objects if o["type"] == "MESH")},
        "camera": scene.camera.name if scene.camera else None,
        "engine": scene.render.engine,
        "world": scene.world.name if scene.world else None,
        "frame": scene.frame_current,
    }


def cmd_get_object_info(args):
    name = args.get("name")
    obj = bpy.data.objects.get(name) if name else None
    if obj is None:
        raise LiveError(f"找不到对象：{name}")
    return {
        "name": obj.name,
        "type": obj.type,
        "parent": obj.parent.name if obj.parent else None,
        "children": [child.name for child in obj.children],
        "location": _vec(obj.matrix_world.translation),
        "rotation_deg": [round(v, 3) for v in obj.rotation_euler],
        "scale": _vec(obj.scale),
        "dimensions": _vec(obj.dimensions),
        "modifiers": [{"name": m.name, "type": m.type} for m in obj.modifiers],
        "materials": [slot.material.name for slot in obj.material_slots if slot.material],
        "custom_properties": {k: obj[k] for k in obj.keys() if not k.startswith("_")},
        "matrix_world": [list(row) for row in obj.matrix_world],
    }


def cmd_execute_code(args):
    code = args.get("code")
    if not code or not isinstance(code, str):
        raise LiveError("code 必须是非空字符串")
    stdout = io.StringIO()
    namespace = {"bpy": bpy}
    try:
        with redirect_stdout(stdout):
            exec(compile(code, "<zcode_live>", "exec"), namespace)  # noqa: S102 - 实时通道的核心能力
    except Exception:  # noqa: BLE001 - 完整 traceback 回给模型自己修
        raise LiveError(traceback.format_exc(limit=8))
    return {"stdout": stdout.getvalue()[-16000:]}


def cmd_viewport_screenshot(args):
    """优先 GPUOffScreen 离屏渲染视口（不依赖窗口前台/合成状态），失败退回窗口截取。"""
    max_size = int(args.get("maxSize") or 800)
    save_path = args.get("savePath")
    if save_path:
        save_path = os.path.abspath(save_path)
        os.makedirs(os.path.dirname(save_path), exist_ok=True)
    else:
        os.makedirs(SHOT_DIR, exist_ok=True)
        save_path = os.path.join(SHOT_DIR, f"shot_{int(time.time() * 1000)}.png")

    area = region = space = None
    for a in bpy.context.screen.areas:
        if a.type == "VIEW_3D":
            area = a
            space = a.spaces.active
            region = next((r for r in a.regions if r.type == "WINDOW"), None)
            break
    if not area or region is None or space is None:
        raise LiveError("找不到 3D 视口")

    method = "offscreen"
    try:
        import gpu
        import numpy as np

        r3d = space.region_3d
        src_w, src_h = region.width, region.height
        if max(src_w, src_h) > max_size:
            scale = max_size / max(src_w, src_h)
            width, height = max(1, int(src_w * scale)), max(1, int(src_h * scale))
        else:
            width, height = src_w, src_h

        offscreen = gpu.types.GPUOffScreen(width, height)
        try:
            offscreen.draw_view3d(
                bpy.context.scene, bpy.context.view_layer, space, region,
                r3d.view_matrix, r3d.window_matrix, do_color_management=True,
            )
            buf = offscreen.texture_color.read()
        finally:
            offscreen.free()
        buf.dimensions = width * height * 4
        pixels = np.asarray(buf, dtype=np.float32) / 255.0
        image = bpy.data.images.new("zcode_live_shot", width, height, alpha=True)
        image.pixels.foreach_set(pixels.ravel())
        image.filepath_raw = save_path
        image.file_format = "PNG"
        image.save()
        bpy.data.images.remove(image)
    except Exception as error:  # noqa: BLE001 - 没有 GPU 上下文时退回窗口截取
        method = "window_grab"
        with bpy.context.temp_override(area=area):
            bpy.ops.screen.screenshot_area(filepath=save_path)
        image = bpy.data.images.load(save_path)
        width, height = image.size
        if max(width, height) > max_size:
            scale = max_size / max(width, height)
            width, height = int(width * scale), int(height * scale)
            image.scale(width, height)
            image.save()
        bpy.data.images.remove(image)
        del error

    with open(save_path, "rb") as handle:
        encoded = base64.b64encode(handle.read()).decode("ascii")
    return {
        "width": width,
        "height": height,
        "filepath": save_path,
        "method": method,
        "image_base64": encoded,
    }


def cmd_polyhaven_status(args):
    props = bpy.context.scene.zcode_live
    reachable = None
    try:
        _http_get(f"{POLYHAVEN_API}/status", 5)
        reachable = True
    except Exception:  # noqa: BLE001
        reachable = False
    return {
        "enabled": bool(props.polyhaven_enabled),
        "api_reachable": reachable,
        "message": "PolyHaven 可用（CC0，无需 API key）" if props.polyhaven_enabled else "PolyHaven 未启用：在 N 面板 ZCode Live 勾选后重连",
    }


def cmd_polyhaven_search(args):
    query = (args.get("query") or "").strip()
    if not query:
        raise LiveError("query 不能为空")
    asset_type = (args.get("assetType") or "all").lower()
    if asset_type not in ("all",) | set(POLYHAVEN_SUPPORTED_FORMATS):
        raise LiveError(f"assetType 只能是 all/{'/'.join(POLYHAVEN_SUPPORTED_FORMATS)}")
    limit = max(1, min(int(args.get("limit") or 8), 20))
    return _polyhaven_search(query, asset_type, limit)


def _polyhaven_import_hdri(asset_id, files_data, resolution, file_format):
    file_info = files_data.get("hdri", {}).get(resolution, {}).get(file_format)
    if not file_info:
        raise LiveError(f"HDRI {asset_id} 没有 {resolution} {file_format} 版本")
    os.makedirs(SHOT_DIR, exist_ok=True)
    dest_path = os.path.join(SHOT_DIR, f"{asset_id}_{resolution}.{file_format}")
    _polyhaven_download(file_info, dest_path)

    world = bpy.data.worlds.new(f"PolyHaven {asset_id}")
    bpy.context.scene.world = world
    world.use_nodes = True
    tree = world.node_tree
    tree.nodes.clear()
    tex_coord = tree.nodes.new(type="ShaderNodeTexCoord")
    mapping = tree.nodes.new(type="ShaderNodeMapping")
    env_tex = tree.nodes.new(type="ShaderNodeTexEnvironment")
    env_tex.image = bpy.data.images.load(dest_path, check_existing=True)
    env_tex.image.name = f"{asset_id}_{resolution}"
    env_tex.image.pack()  # 打包进 .blend，换机器也能渲染
    background = tree.nodes.new(type="ShaderNodeBackground")
    output = tree.nodes.new(type="ShaderNodeOutputWorld")
    tree.links.new(tex_coord.outputs["Generated"], mapping.inputs["Vector"])
    tree.links.new(mapping.outputs["Vector"], env_tex.inputs["Vector"])
    tree.links.new(env_tex.outputs["Color"], background.inputs["Color"])
    tree.links.new(background.outputs["Background"], output.inputs["Surface"])
    _polyhaven_tag([world, env_tex.image], asset_id, resolution)
    os.unlink(dest_path)
    return {"success": True, "world": world.name, "image": env_tex.image.name, "url": f"{POLYHAVEN_SITE}/a/{asset_id}"}


def _polyhaven_import_texture(asset_id, files_data, resolution, file_format, apply_to):
    maps = {}
    for key, role in POLYHAVEN_TEXTURE_MAPS.items():
        by_resolution = files_data.get(key)
        if isinstance(by_resolution, dict) and file_format in by_resolution.get(resolution, {}):
            maps[key] = (role, by_resolution[resolution][file_format])
    if "nor_gl" in maps and "nor_dx" in maps:
        maps.pop("nor_dx", None)
    if not any(role == "base_color" for _role, _img in maps.values()):
        for key in sorted(files_data):
            if not key.lower().startswith(("col", "diff")):
                continue
            by_resolution = files_data.get(key)
            if isinstance(by_resolution, dict) and file_format in by_resolution.get(resolution, {}):
                maps[key] = ("base_color", by_resolution[resolution][file_format])
                break
    if not maps:
        raise LiveError(f"贴图 {asset_id} 在 {resolution} {file_format} 下没有任何可用的 map")

    os.makedirs(SHOT_DIR, exist_ok=True)
    images = {}
    try:
        for key, (role, file_info) in maps.items():
            dest_path = os.path.join(SHOT_DIR, f"{asset_id}_{key}_{resolution}.{file_format}")
            _polyhaven_download(file_info, dest_path)
            image = bpy.data.images.load(dest_path, check_existing=True)
            image.name = f"{asset_id}_{key}"
            image.colorspace_settings.name = "sRGB" if role in POLYHAVEN_COLOR_ROLES else "Non-Color"
            image.pack()
            images[key] = (role, image)
            os.unlink(dest_path)
        material, wired = _build_principled_material(asset_id, images)
    except Exception:
        for _role, image in images.values():
            try:
                bpy.data.images.remove(image)
            except Exception:  # noqa: BLE001
                pass
        raise

    applied = None
    if apply_to:
        obj = bpy.data.objects.get(apply_to)
        if obj is None or obj.type != "MESH":
            raise LiveError(f"apply_to 指向的 {apply_to!r} 不是网格对象")
        obj.data.materials.clear()
        obj.data.materials.append(material)
        applied = obj.name
    _polyhaven_tag([material] + [img for _role, img in images.values()], asset_id, resolution)
    return {
        "success": True,
        "material": material.name,
        "applied_to": applied,
        "wired_maps": wired,
        "url": f"{POLYHAVEN_SITE}/a/{asset_id}",
    }


def _polyhaven_import_model(asset_id, files_data, resolution):
    main_info = files_data.get("blend", {}).get(resolution, {}).get("blend")
    if not main_info:
        raise LiveError(f"模型 {asset_id} 没有 {resolution} blend 版本")
    os.makedirs(SHOT_DIR, exist_ok=True)
    dest_path = os.path.join(SHOT_DIR, f"{asset_id}_{resolution}.blend")
    _polyhaven_download(main_info, dest_path)

    version = _blend_version(dest_path)
    if version and version > bpy.app.version[:2]:
        # 新版 Blender 写的 .blend 打不开，直接退 glTF，避免 append 半途留下脏数据。
        return _polyhaven_import_model_gltf(asset_id, files_data, resolution, reason=f"模型由 Blender {version[0]}.{version[1]} 保存")
    try:
        before = {obj.name for obj in bpy.data.objects}
        linked = _append_blend_collection(dest_path, asset_id)
    except Exception as error:  # noqa: BLE001 - append 失败退 glTF
        return _polyhaven_import_model_gltf(asset_id, files_data, resolution, reason=str(error))
    finally:
        try:
            os.unlink(dest_path)
        except OSError:
            pass

    imported = [obj.name for obj in bpy.data.objects if obj.name not in before]
    if not imported:
        raise LiveError(f"导入 {asset_id} 后场景里没有新对象，该 .blend 可能缺少预期集合")
    _polyhaven_tag(list(linked) + [bpy.data.objects[n] for n in imported[:8]], asset_id, resolution)
    return {
        "success": True,
        "collection": linked[0].name if linked else None,
        "imported_objects": imported,
        "url": f"{POLYHAVEN_SITE}/a/{asset_id}",
    }


def _polyhaven_import_model_gltf(asset_id, files_data, resolution, reason):
    gltf_info = files_data.get("gltf", {}).get(resolution, {}).get("gltf")
    if not gltf_info:
        raise LiveError(f"{asset_id} 的 .blend 导入失败（{reason}），且没有 {resolution} glTF 可回退")
    os.makedirs(SHOT_DIR, exist_ok=True)
    dest_path = os.path.join(SHOT_DIR, f"{asset_id}_{resolution}.glb")
    _polyhaven_download(gltf_info, dest_path)
    before = {obj.name for obj in bpy.data.objects}
    bpy.ops.import_scene.gltf(filepath=dest_path)
    imported = [obj.name for obj in bpy.data.objects if obj.name not in before]
    os.unlink(dest_path)
    _polyhaven_tag([bpy.data.objects[n] for n in imported[:8]], asset_id, resolution)
    return {
        "success": True,
        "fallback": True,
        "note": f".blend 导入失败（{reason}），已用 glTF 导入；材质是转换产物，不是作者原始节点",
        "imported_objects": imported,
        "url": f"{POLYHAVEN_SITE}/a/{asset_id}",
    }


def cmd_polyhaven_import(args):
    if not bpy.context.scene.zcode_live.polyhaven_enabled:
        raise LiveError("PolyHaven 未启用：在 N 面板 ZCode Live 勾选后重连")
    asset_id = args.get("assetId") or ""
    if not POLYHAVEN_SLUG_RE.match(asset_id):
        raise LiveError(f"非法 assetId：{asset_id!r}")
    asset_type = (args.get("assetType") or "").lower()
    if asset_type not in POLYHAVEN_SUPPORTED_FORMATS:
        raise LiveError(f"assetType 必须是 {'/'.join(POLYHAVEN_SUPPORTED_FORMATS)}")
    resolution = args.get("resolution") or "1k"
    try:
        files_data = _polyhaven_api(f"files/{urllib.parse.quote(asset_id, safe='')}")
    except Exception as error:  # noqa: BLE001
        raise LiveError(f"拿不到 {asset_id} 的文件清单：{error}")
    if asset_type == "hdris":
        file_format = (args.get("fileFormat") or POLYHAVEN_DEFAULT_FORMATS["hdris"]).lower()
        return _polyhaven_import_hdri(asset_id, files_data, resolution, file_format)
    if asset_type == "textures":
        file_format = (args.get("fileFormat") or POLYHAVEN_DEFAULT_FORMATS["textures"]).lower()
        if file_format not in POLYHAVEN_SUPPORTED_FORMATS["textures"]:
            raise LiveError(f"textures 只支持 {'/'.join(POLYHAVEN_SUPPORTED_FORMATS['textures'])}")
        return _polyhaven_import_texture(asset_id, files_data, resolution, file_format, args.get("applyTo"))
    return _polyhaven_import_model(asset_id, files_data, resolution)


COMMANDS = {
    "ping": cmd_ping,
    "addon_status": cmd_addon_status,
    "get_scene_info": cmd_get_scene_info,
    "get_object_info": cmd_get_object_info,
    "execute_code": cmd_execute_code,
    "viewport_screenshot": cmd_viewport_screenshot,
    "polyhaven_status": cmd_polyhaven_status,
    "polyhaven_search": cmd_polyhaven_search,
    "polyhaven_import": cmd_polyhaven_import,
}


# ---------------------------------------------------------------------------
# TCP 服务：socket 线程 → queue → 主线程 timer
# ---------------------------------------------------------------------------


class LiveServer:
    def __init__(self):
        self.running = False
        self.socket = None
        self.thread = None
        self.port = DEFAULT_PORT
        self.command_queue = queue.Queue()
        self._clients = set()
        self._clients_lock = threading.Lock()

    def start(self, port):
        if bpy.app.background:
            raise LiveError("后台模式（blender -b）下没有意义，请在 GUI 里启动")
        if self.running:
            raise LiveError("服务已在运行")
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.socket.bind(("127.0.0.1", port))
        self.socket.listen(5)
        self.port = port
        self.running = True
        self.thread = threading.Thread(target=self._server_loop, daemon=True)
        self.thread.start()
        if not bpy.app.timers.is_registered(self._drain):
            bpy.app.timers.register(self._drain, persistent=True)

    def stop(self):
        self.running = False
        try:
            if bpy.app.timers.is_registered(self._drain):
                bpy.app.timers.unregister(self._drain)
        except Exception:  # noqa: BLE001
            pass
        if self.socket:
            try:
                self.socket.close()
            except Exception:  # noqa: BLE001
                pass
            self.socket = None
        with self._clients_lock:
            clients = list(self._clients)
            self._clients.clear()
        for client in clients:  # 先踢掉 recv 里的线程，避免 daemon 线程赖着重启后的连接
            try:
                client.shutdown(socket.SHUT_RDWR)
            except Exception:  # noqa: BLE001
                pass
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass
        while True:
            try:
                self.command_queue.get_nowait()
            except queue.Empty:
                break
        if self.thread:
            self.thread.join(timeout=1.0)
            self.thread = None

    def _server_loop(self):
        self.socket.settimeout(1.0)
        while self.running:
            try:
                client, _address = self.socket.accept()
                threading.Thread(target=self._handle_client, args=(client,), daemon=True).start()
            except socket.timeout:
                continue
            except OSError:
                if self.running:
                    time.sleep(0.5)

    def _handle_client(self, client):
        client.settimeout(1.0)
        with self._clients_lock:
            self._clients.add(client)
        buffer = b""
        try:
            while self.running:
                try:
                    data = client.recv(65536)
                    if not data:
                        break
                    buffer += data
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        if not line.strip():
                            continue
                        try:
                            command = json.loads(line.decode("utf-8"))
                        except (json.JSONDecodeError, UnicodeDecodeError) as error:
                            self._send(client, {"id": None, "ok": False, "error": f"bad request: {error}"})
                            continue
                        self.command_queue.put((command, client))
                except socket.timeout:
                    continue
                except OSError:
                    break
        finally:
            with self._clients_lock:
                self._clients.discard(client)
            try:
                client.close()
            except Exception:  # noqa: BLE001
                pass

    @staticmethod
    def _send(client, payload):
        try:
            client.sendall(json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n")
        except OSError:
            pass

    def _drain(self):
        """主线程唯一 timer：排空队列、执行、回包。返回轮询间隔让 Blender 持续调用。"""
        if not self.running:
            return None
        while True:
            try:
                command, client = self.command_queue.get_nowait()
            except queue.Empty:
                break
            req_id = command.get("id")
            handler = COMMANDS.get(command.get("cmd"))
            if handler is None:
                self._send(client, {"id": req_id, "ok": False, "error": f"unknown command: {command.get('cmd')}"})
                continue
            try:
                result = handler(command.get("args") or {})
                self._send(client, {"id": req_id, "ok": True, "result": result})
            except LiveError as error:
                self._send(client, {"id": req_id, "ok": False, "error": str(error)})
            except Exception as error:  # noqa: BLE001 - 异常必须回包，不能让客户端干等
                self._send(client, {"id": req_id, "ok": False, "error": f"{type(error).__name__}: {error}",
                                    "traceback": traceback.format_exc(limit=5)})
        return 0.05


SERVER = LiveServer()


# ---------------------------------------------------------------------------
# UI：N 面板
# ---------------------------------------------------------------------------


class ZCodeLiveProps(bpy.types.PropertyGroup):
    port: bpy.props.IntProperty(  # noqa: A003 - PropertyGroup 字段
        name="端口", description="本地 TCP 端口（默认 9878，避开 blender-mcp 的 9876）",
        default=DEFAULT_PORT, min=1024, max=65535)
    polyhaven_enabled: bpy.props.BoolProperty(  # noqa: A003
        name="启用 PolyHaven 资产", description="允许搜索/导入 PolyHaven 的 CC0 模型、贴图与 HDRI",
        default=True)


class ZCODELIVE_OT_start(bpy.types.Operator):
    bl_idname = "zcodelive.start"
    bl_label = "连接 ZCode"
    bl_description = "在本机 127.0.0.1 上启动 Live Bridge 服务"

    def execute(self, context):
        try:
            SERVER.start(context.scene.zcode_live.port)
        except Exception as error:  # noqa: BLE001
            self.report({"ERROR"}, f"启动失败：{error}")
            return {"CANCELLED"}
        self.report({"INFO"}, f"ZCode Live Bridge 已在 127.0.0.1:{SERVER.port} 监听")
        return {"FINISHED"}


class ZCODELIVE_OT_stop(bpy.types.Operator):
    bl_idname = "zcodelive.stop"
    bl_label = "断开"
    bl_description = "停止 Live Bridge 服务"

    def execute(self, context):
        SERVER.stop()
        self.report({"INFO"}, "ZCode Live Bridge 已停止")
        return {"FINISHED"}


class ZCODELIVE_PT_panel(bpy.types.Panel):
    bl_label = "ZCode Live"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "ZCode Live"

    def draw(self, context):
        layout = self.layout
        props = context.scene.zcode_live
        if SERVER.running:
            layout.label(text=f"已连接 · 127.0.0.1:{SERVER.port}", icon="LINKED")
            layout.operator("zcodelive.stop", icon="X")
        else:
            layout.label(text="未连接", icon="UNLINKED")
            layout.prop(props, "port")
            layout.operator("zcodelive.start", icon="PLAY")
        layout.separator()
        layout.prop(props, "polyhaven_enabled")


_CLASSES = (ZCodeLiveProps, ZCODELIVE_OT_start, ZCODELIVE_OT_stop, ZCODELIVE_PT_panel)


def register():
    for cls in _CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Scene.zcode_live = bpy.props.PointerProperty(type=ZCodeLiveProps)


def unregister():
    SERVER.stop()
    del bpy.types.Scene.zcode_live
    for cls in reversed(_CLASSES):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()
