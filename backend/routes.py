import asyncio
import copy
import json
import logging
import math
import os
import posixpath
import random
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote

from aiohttp import web

import execution
from server import PromptServer

try:  # 脱离 ComfyUI 跑单测时允许缺失，相关接口会自动降级。
    import folder_paths
except Exception:  # pragma: no cover - 只在没有 ComfyUI 运行时的场景触发
    folder_paths = None

from .tag_locator import find_tags_file

logger = logging.getLogger("ComfyUI-PocketNAI")

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = PLUGIN_ROOT / "dist"
WORKFLOWS_DIR = PLUGIN_ROOT / "saved_workflows"
ACTIVE_META_FILE = WORKFLOWS_DIR / "_active.json"
CONFIG_VERSION = "2.0.0"
MAX_SEED = 1125899906842624
MAX_SLOT_TARGETS = 64
MAX_TRIGGER_WORDS = 16
WORKFLOW_ID_MAX_LENGTH = 80

# 伴随文件嗅探：Lora-Manager / Civitai Helper 的命名习惯。
PREVIEW_EXTS = (
    ".preview.png",
    ".preview.jpg",
    ".preview.jpeg",
    ".preview.webp",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
)
METADATA_EXTS = (".metadata.json", ".civitai.info", ".json")
LORA_FILE_EXTS = (".safetensors", ".ckpt", ".pt", ".pth", ".bin")
PREVIEW_MIME_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".jxl"}
# Windows 保留文件名，避免工作流落盘时直接写失败。
WINDOWS_RESERVED_NAMES = {
    "con",
    "prn",
    "aux",
    "nul",
    *(f"com{index}" for index in range(1, 10)),
    *(f"lpt{index}" for index in range(1, 10)),
}
SLOT_TYPES = {
    "prompt",
    "negative",
    "text",
    "seed",
    "slider",
    "number",
    "toggle",
    "combo",
    "lm_loras",
    "pv_tiles",
    "resolution",
}
RESOLUTION_ALIGNMENTS = (8, 16, 32, 64)
RESOLUTION_CANVAS_LIMITS = (2048, 4096, 8192)
RESOLUTION_MIN = 16
RESOLUTION_MAX = 16384
# 探测可选外部插件时使用的路由：插件没装时对应入口在移动端整体隐藏。
INTEGRATION_ROUTES = {
    "prompt_vault": "/prompt_vault/api/library",
}

_state = {
    "api_prompt": None,
    "config": None,
    "updated_at": None,
}
_state_lock = threading.RLock()


def _error(message: str, status: int = 400, details=None, node_errors=None):
    body = {"error": {"message": message, "details": details or ""}, "node_errors": node_errors or {}}
    return web.json_response(body, status=status)


def _as_bool(value, label: str) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str) and value.lower() in {"true", "1", "on", "yes"}:
        return True
    if isinstance(value, str) and value.lower() in {"false", "0", "off", "no"}:
        return False
    raise ValueError(f"{label} 必须是布尔值")


def _as_float(value, label: str) -> float:
    if isinstance(value, bool) or value is None or value == "":
        raise ValueError(f"{label} 必须是数字")
    try:
        return float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} 必须是数字") from None


def _coerce_lora_entries(value) -> dict:
    """把移动端的 LoRA 托盘转换为 LoraLoaderLM 的 loras 输入。

    LoraLoaderLM 在执行阶段丢弃 text 控件，只读取 loras 数组，所以这里必须
    输出完整条目；同时 ComfyUI 的 graphToPrompt 会把数组控件包成 {"__value__": [...]}，
    注入时保持同样的包装，校验阶段才会把它还原成数组而不是误判为节点连线。
    脏条目就地丢弃或补默认值，避免一条坏数据阻塞整个任务。
    """
    if not isinstance(value, list):
        return {"__value__": []}
    entries = []
    for raw in value:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        if not name:
            continue
        try:
            strength = _as_float(raw.get("strength", 1.0), f"{name} 的 strength")
        except ValueError:
            strength = 1.0
        try:
            clip_strength = _as_float(raw.get("clipStrength", strength), f"{name} 的 clipStrength")
        except ValueError:
            clip_strength = strength
        try:
            active = _as_bool(raw.get("active", True), f"{name} 的 active")
        except ValueError:
            active = True
        entries = [entry for entry in entries if entry["name"] != name]
        entries.append(
            {
                "name": name,
                "strength": strength,
                "clipStrength": clip_strength,
                "active": active,
            }
        )
    return {"__value__": entries}


def _coerce_tile_entries(value) -> str:
    """把移动端的磁贴数组序列化为 PromptVaultSelector 的 selected_tiles_data 字符串。

    无法解析的数据退化为空列表；单条坏磁贴只补默认值或丢弃，不影响整次生成。
    """
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            value = []
    if not isinstance(value, list):
        value = []

    tiles = []
    seen = set()
    for raw in value:
        if not isinstance(raw, dict):
            continue
        tile = copy.deepcopy(raw)
        instance_id = str(raw.get("instance_id") or uuid.uuid4().hex)
        if instance_id in seen:
            continue
        seen.add(instance_id)
        tile["instance_id"] = instance_id
        try:
            tile["enabled"] = _as_bool(raw.get("enabled", True), "磁贴的 enabled")
        except ValueError:
            tile["enabled"] = True
        try:
            tile["weight"] = _as_float(raw.get("weight", 1.0), "磁贴的 weight")
        except ValueError:
            tile["weight"] = 1.0
        tiles.append(tile)
    return json.dumps(tiles, ensure_ascii=False)


def _resolution_int(value, label: str) -> int:
    if isinstance(value, bool) or value is None or value == "":
        raise ValueError(f"{label} 必须是整数")
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f"{label} 必须是整数") from None
    if not math.isfinite(number):
        raise ValueError(f"{label} 必须是整数")
    return int(round(number))


def _resolution_alignment(value) -> int:
    try:
        alignment = int(value)
    except (TypeError, ValueError, OverflowError):
        return 8
    return alignment if alignment in RESOLUTION_ALIGNMENTS else 8


def _align_resolution(value: int, alignment: int) -> int:
    minimum = math.ceil(RESOLUTION_MIN / alignment) * alignment
    clamped = min(RESOLUTION_MAX, max(minimum, value))
    # Aaalice 前端用 Math.round（.5 向上），Python 的 round 是银行家舍入；
    # 这里显式保持与画布一致，避免 20/8 这类边界值在两端算出不同宽度。
    aligned = math.floor(clamped / alignment + 0.5) * alignment
    return int(min(RESOLUTION_MAX, max(minimum, aligned)))


def _normalize_resolution_state(value) -> dict:
    """把移动端/Aaalice 的分辨率状态收敛成执行与回写都安全的形状。

    执行阶段只读取 width/height，但配置里保留 alignment/canvasMax/presetId，
    这样手机改完写回 PC 时画布框选、对齐和预设高亮都不会丢失。
    """
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            raise ValueError("分辨率数据必须是 JSON 对象") from None
    if not isinstance(value, dict):
        raise ValueError("分辨率数据必须是对象")

    alignment = _resolution_alignment(value.get("alignment"))
    width = _align_resolution(_resolution_int(value.get("width"), "宽度"), alignment)
    height = _align_resolution(_resolution_int(value.get("height"), "高度"), alignment)
    minimum_canvas = next(
        (limit for limit in RESOLUTION_CANVAS_LIMITS if max(width, height) <= limit),
        RESOLUTION_CANVAS_LIMITS[-1],
    )
    try:
        requested_canvas = int(value.get("canvasMax"))
    except (TypeError, ValueError, OverflowError):
        requested_canvas = RESOLUTION_CANVAS_LIMITS[0]
    if requested_canvas not in RESOLUTION_CANVAS_LIMITS:
        requested_canvas = RESOLUTION_CANVAS_LIMITS[0]
    canvas_max = max(minimum_canvas, requested_canvas)
    preset_id = value.get("presetId")
    if not isinstance(preset_id, str) or not preset_id.strip():
        preset_id = None
    else:
        preset_id = preset_id.strip()

    return {
        "version": 1,
        "width": width,
        "height": height,
        "alignment": alignment,
        "canvasMax": canvas_max,
        "presetId": preset_id,
    }


def _coerce_resolution_json(value) -> str:
    state = _normalize_resolution_state(value)
    return json.dumps(
        {"version": 1, "width": state["width"], "height": state["height"]},
        separators=(",", ":"),
    )


def _resolution_state_candidate(value):
    """识别一个值是否像 ResolutionPreset 的状态（含旧版 text 降级后的字符串）。"""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return None
    if not isinstance(value, dict):
        return None
    if value.get("version") != 1 or "width" not in value or "height" not in value:
        return None
    try:
        _resolution_int(value.get("width"), "宽度")
        _resolution_int(value.get("height"), "高度")
    except ValueError:
        return None
    return value


def _clean_resolution_presets(value) -> list:
    if not isinstance(value, list):
        return []
    presets = []
    seen = set()
    for raw in value[:128]:
        if not isinstance(raw, dict):
            continue
        preset_id = str(raw.get("id") or "").strip()
        if not preset_id or preset_id in seen:
            continue
        try:
            width = _resolution_int(raw.get("width"), "宽度")
            height = _resolution_int(raw.get("height"), "高度")
        except ValueError:
            continue
        if not (RESOLUTION_MIN <= width <= RESOLUTION_MAX):
            continue
        if not (RESOLUTION_MIN <= height <= RESOLUTION_MAX):
            continue
        group = str(raw.get("group") or "square")
        if group not in {"square", "portrait", "landscape", "personal"}:
            group = "square"
        seen.add(preset_id)
        presets.append(
            {
                "id": preset_id[:120],
                "name": str(raw.get("name") or f"{width}×{height}")[:48],
                "width": width,
                "height": height,
                "alignment": _resolution_alignment(raw.get("alignment")),
                "group": group,
            }
        )
    return presets


def _clean_resolution_choices(value, allowed, default) -> list:
    if not isinstance(value, list):
        return list(default)
    cleaned = set()
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            continue
        if not math.isfinite(item):
            continue
        number = int(item)
        if number in allowed:
            cleaned.add(number)
    return sorted(cleaned) or list(default)


def _default_resolution_state() -> dict:
    return {
        "version": 1,
        "width": 1024,
        "height": 1024,
        "alignment": 8,
        "canvasMax": 2048,
        "presetId": None,
    }


def _clean_targets(value):
    if not isinstance(value, list):
        return None
    targets = []
    seen = set()
    for raw in value:
        if not isinstance(raw, dict):
            continue
        node_id = str(raw.get("node_id", "")).strip()
        field = str(raw.get("field", "")).strip()
        if not node_id or not field:
            continue
        key = (node_id, field)
        if key in seen:
            continue
        seen.add(key)
        targets.append({"node_id": node_id, "field": field})
        if len(targets) >= MAX_SLOT_TARGETS:
            break
    return targets or None


def _slot_targets(slot: dict):
    targets = slot.get("targets")
    if isinstance(targets, list) and targets:
        return [(target["node_id"], target["field"]) for target in targets]
    return [(slot["node_id"], slot["field"])]


def _plain_slot_value(slot: dict, value):
    if slot["type"] == "lm_loras":
        return value.get("__value__", []) if isinstance(value, dict) else []
    if slot["type"] == "pv_tiles":
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return []
    if slot["type"] == "resolution":
        try:
            return _normalize_resolution_state(value)
        except ValueError:
            return _default_resolution_state()
    return value


def _is_link(value) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[1], int)
        and not isinstance(value[1], bool)
        and isinstance(value[0], (str, int))
    )


def _clean_slot(raw: dict) -> dict:
    node_id = str(raw.get("node_id", "")).strip()
    field = str(raw.get("field", "")).strip()
    if not node_id or not field:
        raise ValueError("每个槽位都必须包含 node_id 与 field")

    slot_type = str(raw.get("type", "text"))
    # 旧版本后端不认识 resolution，会把槽位写成 text；只要落点仍是
    # resolution_json 且默认值像分辨率状态，就在加载时自动纠正回来。
    default_candidate = _resolution_state_candidate(raw.get("default_val"))
    if slot_type != "resolution" and field == "resolution_json" and default_candidate is not None:
        slot_type = "resolution"
    if slot_type not in SLOT_TYPES:
        slot_type = "text"

    slot = {
        "node_id": node_id,
        "field": field,
        "label": str(raw.get("label") or field),
        "type": slot_type,
        "default_val": copy.deepcopy(raw.get("default_val")),
    }
    if raw.get("node_title"):
        slot["node_title"] = str(raw["node_title"])
    if raw.get("value_kind") in {"int", "float"}:
        slot["value_kind"] = raw["value_kind"]
    for key in ("min", "max", "step"):
        if raw.get(key) is not None:
            slot[key] = raw[key]
    if isinstance(raw.get("options"), list):
        slot["options"] = copy.deepcopy(raw["options"])
    if slot_type == "resolution":
        default_source = default_candidate if default_candidate is not None else raw.get("default_val")
        try:
            slot["default_val"] = _normalize_resolution_state(default_source)
        except ValueError:
            slot["default_val"] = _default_resolution_state()
        # 预设元数据可能因为旧版 text 降级被塞进 default_val，优先从中恢复。
        presets_value = raw.get("presets")
        if not isinstance(presets_value, list) and default_candidate is not None:
            presets_value = default_candidate.get("presets")
        alignments_value = raw.get("alignments")
        if not isinstance(alignments_value, list) and default_candidate is not None:
            alignments_value = default_candidate.get("alignments")
        limits_value = raw.get("canvas_limits")
        if not isinstance(limits_value, list) and default_candidate is not None:
            limits_value = default_candidate.get("canvas_limits")
        slot["presets"] = _clean_resolution_presets(presets_value)
        slot["alignments"] = _clean_resolution_choices(
            alignments_value, RESOLUTION_ALIGNMENTS, RESOLUTION_ALIGNMENTS
        )
        slot["canvas_limits"] = _clean_resolution_choices(
            limits_value, RESOLUTION_CANVAS_LIMITS, RESOLUTION_CANVAS_LIMITS
        )
    targets = _clean_targets(raw.get("targets"))
    if targets:
        slot["targets"] = targets
    return slot


def _clean_config(raw: dict) -> dict:
    slots = raw.get("slots", [])
    if not isinstance(slots, list):
        raise ValueError("pocket_config.slots 必须是数组")

    cleaned_slots = []
    seen = set()
    for raw_slot in slots:
        if not isinstance(raw_slot, dict):
            continue
        slot = _clean_slot(raw_slot)
        key = (slot["node_id"], slot["field"])
        if key in seen:
            continue
        seen.add(key)
        cleaned_slots.append(slot)

    config = {
        "version": CONFIG_VERSION,
        "display_title": str(raw.get("display_title") or "ComfyUI 工作流")[:120],
        "output_node_id": None,
        "slots": cleaned_slots,
    }
    output_node_id = raw.get("output_node_id")
    if output_node_id is not None and str(output_node_id).strip():
        config["output_node_id"] = str(output_node_id)
    if raw.get("output_node_title"):
        config["output_node_title"] = str(raw["output_node_title"])[:120]
    return config


def _coerce_value(slot: dict, value):
    slot_type = slot["type"]

    if slot_type in {"prompt", "negative", "text"}:
        return "" if value is None else str(value)

    if slot_type == "toggle":
        return _as_bool(value, slot["label"])

    if slot_type == "lm_loras":
        return _coerce_lora_entries(value)

    if slot_type == "pv_tiles":
        return _coerce_tile_entries(value)

    if slot_type == "resolution":
        return _coerce_resolution_json(value)

    if slot_type in {"seed", "slider", "number"}:
        if isinstance(value, bool) or value is None or value == "":
            raise ValueError(f"{slot['label']} 必须是数字")
        if slot.get("value_kind") == "float" or slot_type == "slider" and any(
            isinstance(slot.get(key), float) and not float(slot[key]).is_integer()
            for key in ("min", "max", "step")
        ):
            try:
                return float(value)
            except (TypeError, ValueError):
                raise ValueError(f"{slot['label']} 必须是数字") from None
        try:
            return int(float(value))
        except (TypeError, ValueError, OverflowError):
            raise ValueError(f"{slot['label']} 必须是整数") from None

    if slot_type == "combo":
        options = slot.get("options") or []
        for option in options:
            if str(option) == str(value):
                return option
        return value

    return value


def _random_seed() -> int:
    return random.randint(1, MAX_SEED)


def _format_lora_strength(value) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = 1.0
    text = f"{number:.2f}".rstrip("0").rstrip(".")
    return text or "0"


def _lora_syntax(entries) -> str:
    """把 loras 数组还原成 `<lora:name:strength[:clip]>` 文本。

    Lora-Manager 的 `text` 控件是 loras 数组之外的第二个真值来源：文本里残留的
    标签会在下一次文本回调时被重新解析回数组。后端注入时保持两者一致，模板就不会
    带着已删除的 LoRA 继续在服务端流转。
    """
    if isinstance(entries, dict):
        entries = entries.get("__value__", [])
    if not isinstance(entries, list):
        return ""
    parts = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if not name or entry.get("active") is False:
            continue
        strength = _format_lora_strength(entry.get("strength", 1.0))
        clip = _format_lora_strength(entry.get("clipStrength", entry.get("strength", 1.0)))
        parts.append(
            f"<lora:{name}:{strength}>" if strength == clip else f"<lora:{name}:{strength}:{clip}>"
        )
    return " ".join(parts)


def _sync_lora_text_input(inputs: dict, value) -> None:
    """把同一节点上的 `text` 纯文本控件同步成 loras 数组的语法。

    只在目标节点本来就带字符串 `text` 输入时改写，绝不新增输入项，避免
    `validate_prompt` 因未知输入报错。
    """
    if not isinstance(inputs, dict):
        return
    current = inputs.get("text")
    if not isinstance(current, str):
        return
    next_text = _lora_syntax(value)
    if current != next_text:
        inputs["text"] = next_text


def _inject_slots(prompt: dict, config: dict, slots_data: dict, randomize_seed: bool = True, coerced: bool = False) -> list:
    skipped = []
    for slot in config["slots"]:
        node_id = slot["node_id"]
        field = slot["field"]
        supplied = isinstance(slots_data.get(node_id), dict) and field in slots_data[node_id]

        usable = []
        for target_node_id, target_field in _slot_targets(slot):
            node = prompt.get(target_node_id)
            if not isinstance(node, dict):
                if supplied:
                    skipped.append(f"{slot['label']}（节点 {target_node_id} 不在当前模板）")
                continue
            inputs = node.get("inputs")
            # ResolutionPreset 通过 accept_all_inputs 接收 resolution_json，
            # 该键由前端 graphToPrompt 钩子动态补上；旧模板里节点可能只有
            # 空 inputs，此时允许直接创建这个输入，避免槽位被误判为失效。
            if not isinstance(inputs, dict) and slot["type"] == "resolution":
                inputs = {}
                node["inputs"] = inputs
            if not isinstance(inputs, dict):
                if supplied:
                    skipped.append(f"{slot['label']}（节点 {target_node_id} 缺少 inputs）")
                continue
            if target_field not in inputs and not (
                slot["type"] == "resolution" and target_field == "resolution_json"
            ):
                if supplied:
                    skipped.append(f"{slot['label']}（节点 {target_node_id} 缺少 {target_field}）")
                continue
            if supplied and target_field in inputs and _is_link(inputs[target_field]):
                skipped.append(f"{slot['label']}（{target_field} 已被连线）")
                continue
            usable.append((inputs, target_field))

        if supplied and not usable:
            skipped.append(f"{slot['label']}（没有可写入的目标）")
            continue

        value = None
        if supplied:
            if coerced:
                value = slots_data[node_id][field]
            else:
                try:
                    value = _coerce_value(slot, slots_data[node_id][field])
                except ValueError as err:
                    raise ValueError(f"{slot['label']}：{err}") from None

        seed_value = None
        for inputs, target_field in usable:
            if supplied:
                inputs[target_field] = value
                if slot["type"] == "lm_loras":
                    _sync_lora_text_input(inputs, value)
            if randomize_seed and slot["type"] == "seed" and inputs[target_field] == -1:
                if seed_value is None:
                    seed_value = _random_seed()
                inputs[target_field] = seed_value
    return skipped


async def _config_response() -> web.Response:
    with _state_lock:
        config = copy.deepcopy(_state["config"])
        updated_at = _state["updated_at"]
    return web.json_response(
        {
            "config": config,
            "has_template": config is not None,
            "updated_at": updated_at,
        }
    )


def _static_file(tail: str, cache: bool) -> web.FileResponse:
    root = DIST_DIR.resolve()
    target = (root / tail).resolve()
    if not target.is_relative_to(root):
        raise web.HTTPNotFound()
    if not target.is_file():
        raise web.HTTPNotFound()

    response = web.FileResponse(target)
    if cache:
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    else:
        response.headers["Cache-Control"] = "no-cache"
    if target.name == "sw.js":
        response.headers["Service-Worker-Allowed"] = "/pocket/"
    return response


def _missing_build_response() -> web.Response:
    return web.Response(
        status=503,
        text="PocketNAI 前端尚未构建，请在 mobile_web 目录执行 npm install && npm run build。",
        content_type="text/plain",
    )


def _write_json_atomic(path: Path, payload) -> None:
    """先写临时文件再替换，避免进程中断留下半截 JSON。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp_path, path)


def _read_json_file(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None


class WorkflowStore:
    """服务端工作流持久化：每条工作流一个 JSON，另有 `_active.json` 记录活动项。

    目录结构：

        saved_workflows/
            _active.json          {"active_id": "<id>"}
            <id>.json             {"id", "title", "api_prompt", "pocket_config", "updated_at"}

    `_state` 依然是运行时缓存，但重启后可以从这里恢复，移动端也能列出并切换历史工作流。
    """

    lock = threading.RLock()

    @staticmethod
    def _safe_id(title: str) -> str:
        """把任意标题收敛成跨平台安全的文件名（不含扩展名）。"""
        cleaned = re.sub(r'[\x00-\x1f\x7f\\/*?:"<>|]+', "_", str(title or ""))
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        cleaned = re.sub(r"[^\w\-. ]+", "_", cleaned, flags=re.UNICODE)
        cleaned = cleaned.strip(" ._")
        if not cleaned:
            return "default_workflow"
        cleaned = cleaned[:WORKFLOW_ID_MAX_LENGTH].strip(" ._") or "default_workflow"
        if cleaned.casefold() in WINDOWS_RESERVED_NAMES:
            cleaned = f"wf_{cleaned}"
        return cleaned.casefold()

    @classmethod
    def _path(cls, file_id: str) -> Path:
        return WORKFLOWS_DIR / f"{file_id}.json"

    @classmethod
    def save(cls, title: str, api_prompt: dict, config: dict, updated_at: str) -> str:
        file_id = cls._safe_id(title)
        payload = {
            "id": file_id,
            "title": str(title or config.get("display_title") or file_id)[:120],
            "api_prompt": api_prompt,
            "pocket_config": config,
            "updated_at": updated_at,
        }
        with cls.lock:
            _write_json_atomic(cls._path(file_id), payload)
            _write_json_atomic(ACTIVE_META_FILE, {"active_id": file_id})
        return file_id

    @classmethod
    def list_all(cls) -> list:
        if not WORKFLOWS_DIR.is_dir():
            return []
        results = []
        for path in WORKFLOWS_DIR.glob("*.json"):
            if path.name.startswith(("_", ".")):
                continue
            data = _read_json_file(path)
            if not isinstance(data, dict):
                continue
            config = data.get("pocket_config")
            if not isinstance(config, dict):
                config = {}
            slots = config.get("slots")
            if not isinstance(slots, list):
                slots = []
            results.append(
                {
                    "id": str(data.get("id") or path.stem),
                    "title": str(data.get("title") or config.get("display_title") or path.stem),
                    "slots_count": len(slots),
                    "updated_at": str(data.get("updated_at") or ""),
                }
            )
        # 按更新时间倒序；时间戳相同的按标题稳定排序。
        results.sort(key=lambda item: (item["updated_at"], item["title"]), reverse=True)
        return results

    @classmethod
    def active_id(cls) -> str | None:
        data = _read_json_file(ACTIVE_META_FILE)
        if not isinstance(data, dict):
            return None
        active = str(data.get("active_id") or "").strip()
        return active or None

    @classmethod
    def mark_active(cls, file_id: str) -> None:
        """只更新活动项指针，用于切换工作流时与 `_state` 在同一临界区落盘。"""
        with cls.lock:
            _write_json_atomic(ACTIVE_META_FILE, {"active_id": str(file_id)})

    @classmethod
    def load(cls, file_id: str) -> dict:
        """读取并校验一条工作流，成功时把它标记为活动项。"""
        raw_id = str(file_id or "").strip()
        candidates = []
        # 先按文件名原样匹配（兼容手工放入或旧版本写下的文件），再退回规范化 id。
        if raw_id and not raw_id.startswith(".") and not re.search(r'[\\/*?:"<>|]', raw_id):
            candidates.append(raw_id)
        normalized_id = cls._safe_id(raw_id)
        if normalized_id not in candidates:
            candidates.append(normalized_id)

        target = next(
            (cls._path(candidate) for candidate in candidates if cls._path(candidate).is_file()),
            None,
        )
        if target is None:
            raise FileNotFoundError(f"找不到工作流: {file_id}")
        cleaned_id = target.stem
        data = _read_json_file(target)
        if not isinstance(data, dict):
            raise ValueError(f"工作流文件不是合法 JSON: {target.name}")

        api_prompt = data.get("api_prompt")
        raw_config = data.get("pocket_config")
        if not isinstance(api_prompt, dict):
            raise ValueError(f"工作流缺少 api_prompt: {target.name}")
        if not isinstance(raw_config, dict):
            raise ValueError(f"工作流缺少 pocket_config: {target.name}")

        try:
            config = _clean_config(raw_config)
        except ValueError as err:
            raise ValueError(f"工作流槽位数据损坏: {err}") from None

        with cls.lock:
            _write_json_atomic(ACTIVE_META_FILE, {"active_id": cleaned_id})
        return {
            "id": cleaned_id,
            "title": str(data.get("title") or config["display_title"])[:120],
            "api_prompt": api_prompt,
            "pocket_config": config,
            "updated_at": str(data.get("updated_at") or ""),
        }

    @classmethod
    def restore_active(cls) -> dict | None:
        """启动时恢复上次活动的工作流；文件损坏时依次回退到其他可用项。"""
        candidates = []
        active_id = cls.active_id()
        if active_id:
            candidates.append(active_id)
        candidates.extend(item["id"] for item in cls.list_all())
        for file_id in dict.fromkeys(candidates):
            try:
                return cls.load(file_id)
            except (FileNotFoundError, ValueError) as err:
                logger.warning("PocketNAI 跳过无法恢复的工作流 %s：%s", file_id, err)
        return None


def _restore_active_workflow() -> None:
    try:
        restored = WorkflowStore.restore_active()
    except Exception:  # 恢复失败不能阻止 ComfyUI 启动
        logger.exception("PocketNAI 恢复活动工作流时发生异常")
        return
    if not restored:
        return
    cfg = restored["pocket_config"]
    with _state_lock:
        _state["api_prompt"] = restored["api_prompt"]
        _state["config"] = cfg
        _state["updated_at"] = restored["updated_at"]
    logger.info(
        "PocketNAI 已恢复活跃工作流「%s」（%d 个槽位）",
        cfg["display_title"],
        len(cfg["slots"]),
    )


def _store_workflow_safely(api_prompt: dict, config: dict, updated_at: str) -> str | None:
    """落盘失败只记日志：磁盘只读或路径异常不应阻断同步/生成。"""
    try:
        return WorkflowStore.save(config["display_title"], api_prompt, config, updated_at)
    except Exception:
        logger.exception("PocketNAI 工作流落盘失败（标题「%s」）", config.get("display_title"))
        return None


# 模块导入即代表插件加载，此时恢复上次的活动工作流。
_restore_active_workflow()


# ---------------------------------------------------------------------------
# LoRA 伴随元数据嗅探
# ---------------------------------------------------------------------------

_lora_meta_cache: dict[str, tuple[tuple, dict]] = {}
_lora_meta_lock = threading.Lock()


def _lora_identifier(name: str) -> str:
    """把相对文件路径转成 loras 数组里使用的名字（去掉模型扩展名，统一 `/`）。"""
    normalized = str(name or "").replace("\\", "/")
    lowered = normalized.lower()
    for ext in LORA_FILE_EXTS:
        if lowered.endswith(ext):
            return normalized[: -len(ext)]
    return normalized


def _lora_preview_url(preview_rel: str) -> str:
    return f"/pocket/api/lora_preview?name={quote(preview_rel)}"


def _first_text(value) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return None


def _iter_metadata_sources(meta: dict):
    """Yield 顶层与常见嵌套层，兼容 .metadata.json / .civitai.info 两种结构。"""
    yield meta
    for key in ("civitai", "modelVersion", "model", "version"):
        nested = meta.get(key)
        if isinstance(nested, dict):
            yield nested


def _extract_trigger_words(meta: dict) -> list:
    words: list[str] = []
    seen = set()
    for source in _iter_metadata_sources(meta):
        for key in ("trainedWords", "trigger_words", "triggerWords", "activation_text", "activationText"):
            raw = source.get(key)
            if isinstance(raw, str):
                raw = re.split(r"[,\n;，；]", raw)
            if not isinstance(raw, list):
                continue
            for item in raw:
                word = str(item).strip()
                if not word or word in seen:
                    continue
                seen.add(word)
                words.append(word)
                if len(words) >= MAX_TRIGGER_WORDS:
                    return words
    return words


def _extract_preferred_weight(meta: dict) -> float:
    for source in _iter_metadata_sources(meta):
        for key in ("preferredWeight", "preferred_weight", "recommended_weight", "weight"):
            candidate = source.get(key)
            if candidate is None or isinstance(candidate, bool):
                continue
            try:
                return round(float(candidate), 2)
            except (TypeError, ValueError):
                continue
        # Lora-Manager 把推荐权重写在 usage_tips 这个 JSON 字符串里。
        tips = source.get("usage_tips") or source.get("usageTips")
        if isinstance(tips, str):
            try:
                tips = json.loads(tips)
            except (json.JSONDecodeError, TypeError):
                tips = None
        if isinstance(tips, dict):
            for key in ("strength", "clipStrength", "weight"):
                candidate = tips.get(key)
                if candidate is None or isinstance(candidate, bool):
                    continue
                try:
                    return round(float(candidate), 2)
                except (TypeError, ValueError):
                    continue
    return 1.0


def _extract_base_model(meta: dict) -> str | None:
    for source in _iter_metadata_sources(meta):
        for key in ("base_model", "baseModel"):
            value = _first_text(source.get(key))
            if value:
                return value
    return None


def _read_lora_sidecar(meta_path: Path) -> dict | None:
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _lora_cache_signature(full_path: Path) -> tuple:
    try:
        return (full_path.stat().st_mtime_ns, full_path.parent.stat().st_mtime_ns)
    except OSError:
        return (0, 0)


def _empty_lora_info(lora_name: str) -> dict:
    normalized = str(lora_name or "").replace("\\", "/")
    folder = posixpath.dirname(normalized)
    return {
        "name": _lora_identifier(normalized),
        "file_name": normalized,
        "base_name": Path(normalized).stem,
        "folder": folder,
        "has_meta": False,
        "trigger_words": [],
        "preferred_weight": 1.0,
        "base_model": None,
        "preview_url": None,
    }


def _inspect_lora_metadata(lora_name: str) -> dict:
    """零外网请求地读取 LoRA 的本地伴随文件（封面 / .metadata.json / .civitai.info）。"""
    info = _empty_lora_info(lora_name)
    if folder_paths is None:
        return info

    try:
        full_path = folder_paths.get_full_path("loras", str(lora_name))
    except Exception:
        logger.exception("PocketNAI 解析 LoRA 路径失败：%s", lora_name)
        return info
    if not full_path or not os.path.isfile(full_path):
        return info

    path = Path(full_path)
    signature = _lora_cache_signature(path)
    with _lora_meta_lock:
        cached = _lora_meta_cache.get(str(lora_name))
    if cached and cached[0] == signature:
        return copy.deepcopy(cached[1])

    directory = posixpath.dirname(str(lora_name).replace("\\", "/"))

    def sidecar_relative(file_name: str) -> str:
        return f"{directory}/{file_name}" if directory else file_name

    # 1. 本地封面：<stem>.preview.png / <stem>.png ...
    for ext in PREVIEW_EXTS:
        candidate = path.with_name(f"{path.stem}{ext}")
        if candidate.is_file():
            info["preview_url"] = _lora_preview_url(sidecar_relative(candidate.name))
            break

    # 2. 伴随元数据：<stem>.metadata.json / <stem>.civitai.info / <stem>.json
    for ext in METADATA_EXTS:
        candidate = path.with_name(f"{path.stem}{ext}")
        if not candidate.is_file():
            continue
        meta = _read_lora_sidecar(candidate)
        if meta is None:
            continue
        info["has_meta"] = True
        info["trigger_words"] = _extract_trigger_words(meta)
        info["preferred_weight"] = _extract_preferred_weight(meta)
        info["base_model"] = _extract_base_model(meta)
        break

    with _lora_meta_lock:
        _lora_meta_cache[str(lora_name)] = (signature, info)
    return copy.deepcopy(info)


def _build_lora_list() -> list:
    if folder_paths is None:
        return []
    try:
        names = folder_paths.get_filename_list("loras")
    except Exception:
        logger.exception("PocketNAI 读取 LoRA 列表失败")
        return []

    items = []
    for name in sorted(names):
        try:
            items.append(_inspect_lora_metadata(name))
        except Exception:
            logger.exception("PocketNAI 解析 LoRA 元数据失败：%s", name)
            items.append(_empty_lora_info(name))
    return items


def register_routes():
    routes = PromptServer.instance.routes

    def _route(method: str, suffix: str):
        """统一的 /pocket 命名空间注册器，避免逐个写装饰器时漏改前缀。"""

        def decorator(handler):
            routes.route(method, f"/pocket{suffix}")(handler)
            return handler

        return decorator

    @_route("GET", "/api/config")
    async def get_config(request: web.Request):
        return await _config_response()

    @_route("GET", "/api/integrations")
    async def get_integrations(request: web.Request):
        registered = {resource.canonical for resource in PromptServer.instance.app.router.resources()}
        return web.json_response(
            {name: path in registered for name, path in INTEGRATION_ROUTES.items()}
        )

    @_route("GET", "/api/workflows")
    async def get_workflows(request: web.Request):
        with _state_lock:
            current_title = _state["config"].get("display_title") if _state["config"] else None
        workflows = await asyncio.to_thread(WorkflowStore.list_all)
        active_id = await asyncio.to_thread(WorkflowStore.active_id)
        return web.json_response(
            {
                "ok": True,
                "active_id": active_id,
                "active_title": current_title,
                "workflows": workflows,
            }
        )

    @_route("POST", "/api/workflows/switch")
    async def switch_workflow(request: web.Request):
        try:
            data = await request.json()
        except (json.JSONDecodeError, ValueError):
            return _error("非法 JSON 请求")
        if not isinstance(data, dict):
            return _error("请求体必须是 JSON 对象")

        target_id = str(data.get("id") or "").strip()
        if not target_id:
            return _error("缺少 workflow id")

        try:
            workflow = await asyncio.to_thread(WorkflowStore.load, target_id)
        except FileNotFoundError:
            return _error("指定的工作流不存在", status=404)
        except ValueError as err:
            return _error("工作流数据损坏", details=str(err))

        config = workflow["pocket_config"]
        with _state_lock:
            _state["api_prompt"] = workflow["api_prompt"]
            _state["config"] = config
            _state["updated_at"] = workflow["updated_at"]
            try:
                WorkflowStore.mark_active(workflow["id"])
            except OSError:
                logger.exception("PocketNAI 写入活动工作流指针失败")

        logger.info(
            "PocketNAI 已切换到工作流「%s」（%d 个槽位）",
            config["display_title"],
            len(config["slots"]),
        )
        sync_payload = {
            "title": config["display_title"],
            "slots": len(config["slots"]),
            "updated_at": workflow["updated_at"],
        }
        PromptServer.instance.send_sync("pocket:template_synced", sync_payload)
        return web.json_response(
            {
                "ok": True,
                "id": workflow["id"],
                "title": config["display_title"],
                "slots": len(config["slots"]),
                "updated_at": workflow["updated_at"],
            }
        )

    @_route("GET", "/api/loras")
    async def list_available_loras(request: web.Request):
        if request.query.get("refresh"):
            with _lora_meta_lock:
                _lora_meta_cache.clear()
        items = await asyncio.to_thread(_build_lora_list)
        return web.json_response({"ok": True, "loras": items})

    @_route("GET", "/api/lora_preview")
    async def serve_lora_preview(request: web.Request):
        name = str(request.query.get("name") or "").strip()
        if not name or folder_paths is None:
            return web.Response(status=404)
        if Path(name).suffix.lower() not in PREVIEW_MIME_EXTS:
            return web.Response(status=404)
        try:
            full_path = folder_paths.get_full_path("loras", name)
        except Exception:
            logger.exception("PocketNAI 读取 LoRA 封面失败：%s", name)
            return web.Response(status=404)
        if not full_path or not os.path.isfile(full_path):
            return web.Response(status=404)
        response = web.FileResponse(full_path)
        response.headers["Cache-Control"] = "public, max-age=3600"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @_route("POST", "/api/sync_template")
    async def sync_template(request: web.Request):
        try:
            data = await request.json()
        except (json.JSONDecodeError, ValueError):
            return _error("请求体不是合法 JSON")
        if not isinstance(data, dict):
            return _error("请求体必须是 JSON 对象")

        api_prompt = data.get("api_prompt")
        raw_config = data.get("pocket_config")
        if not isinstance(api_prompt, dict):
            return _error("api_prompt 必须是对象")
        if not isinstance(raw_config, dict):
            return _error("pocket_config 必须是对象")

        try:
            config = _clean_config(raw_config)
        except ValueError as err:
            return _error("pocket_config 格式错误", details=str(err))

        updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        api_copy = copy.deepcopy(api_prompt)
        with _state_lock:
            _state["api_prompt"] = api_copy
            _state["config"] = config
            _state["updated_at"] = updated_at
            workflow_id = _store_workflow_safely(api_copy, config, updated_at)

        logger.info(
            "PocketNAI 已同步模板「%s」，槽位 %d 个",
            config["display_title"],
            len(config["slots"]),
        )
        sync_payload = {
            "title": config["display_title"],
            "slots": len(config["slots"]),
            "updated_at": updated_at,
        }
        PromptServer.instance.send_sync("pocket:template_synced", sync_payload)
        return web.json_response(
            {
                "ok": True,
                "id": workflow_id,
                "title": config["display_title"],
                "slots": len(config["slots"]),
                "updated_at": updated_at,
            }
        )

    @_route("POST", "/api/apply_slots")
    async def apply_slots(request: web.Request):
        try:
            data = await request.json()
        except (json.JSONDecodeError, ValueError):
            return _error("请求体不是合法 JSON")
        if not isinstance(data, dict):
            return _error("请求体必须是 JSON 对象")
        slots_data = data.get("slots_data", {})
        if not isinstance(slots_data, dict):
            return _error("slots_data 必须是对象")

        with _state_lock:
            template = copy.deepcopy(_state["api_prompt"])
            config = copy.deepcopy(_state["config"])
            if template is None or config is None:
                return _error("尚未同步工作流模板，请先在 PC 端打开并保存工作流", status=409)

            slot_map = {(slot["node_id"], slot["field"]): slot for slot in config["slots"]}
            requested = {}
            for node_id, fields in slots_data.items():
                if not isinstance(fields, dict):
                    continue
                for field, raw in fields.items():
                    slot = slot_map.get((str(node_id), str(field)))
                    if slot is None:
                        continue
                    key = (slot["node_id"], slot["field"])
                    try:
                        requested[key] = _coerce_value(slot, raw)
                    except ValueError as err:
                        return _error("槽位参数不合法", details=f"{slot['label']}：{err}")

            if not requested:
                return web.json_response({"ok": True, "applied": 0, "skipped": 0})

            filtered = {}
            for slot in config["slots"]:
                key = (slot["node_id"], slot["field"])
                if key not in requested:
                    continue
                filtered.setdefault(slot["node_id"], {})[slot["field"]] = requested[key]

            try:
                skipped = _inject_slots(template, config, filtered, randomize_seed=False, coerced=True)
            except ValueError as err:
                return _error("槽位参数不合法", details=str(err))

            plain_updates = {}
            for slot in config["slots"]:
                key = (slot["node_id"], slot["field"])
                if key not in requested:
                    continue
                slot["default_val"] = _plain_slot_value(slot, requested[key])
                plain_updates.setdefault(slot["node_id"], {})[slot["field"]] = slot["default_val"]

            updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
            _state["api_prompt"] = template
            _state["config"] = config
            _state["updated_at"] = updated_at
            workflow_id = _store_workflow_safely(template, config, updated_at)

        if skipped:
            logger.warning(
                "PocketNAI 写回时跳过 %d 个失效槽位：%s",
                len(skipped),
                "；".join(skipped[:6]),
            )
        PromptServer.instance.send_sync("pocket:apply_slots", {"slots_data": plain_updates})
        return web.json_response(
            {
                "ok": True,
                "id": workflow_id,
                "applied": len(requested),
                "skipped": len(skipped),
                "updated_at": updated_at,
            }
        )

    @_route("GET", "/api/tags.csv")
    async def get_tags(request: web.Request):
        path = find_tags_file()
        if not path.is_file():
            return _error("找不到 Danbooru 词库", status=404)
        response = web.FileResponse(path)
        response.headers["Cache-Control"] = "no-cache"
        return response

    @_route("POST", "/api/execute")
    async def execute(request: web.Request):
        try:
            data = await request.json()
        except (json.JSONDecodeError, ValueError):
            return _error("请求体不是合法 JSON")
        if not isinstance(data, dict):
            return _error("请求体必须是 JSON 对象")

        with _state_lock:
            template = copy.deepcopy(_state["api_prompt"])
            config = copy.deepcopy(_state["config"])
        if template is None or config is None:
            return _error("尚未同步工作流模板，请先在 PC 端打开并保存工作流", status=409)

        slots_data = data.get("slots_data", {})
        if not isinstance(slots_data, dict):
            return _error("slots_data 必须是对象")
        client_id = str(data.get("client_id") or uuid.uuid4().hex)[:128]

        prompt = template
        try:
            skipped = _inject_slots(prompt, config, slots_data)
        except ValueError as err:
            return _error("槽位参数不合法", details=str(err))
        if skipped:
            logger.warning(
                "PocketNAI 跳过 %d 个失效槽位：%s",
                len(skipped),
                "；".join(skipped[:6]),
            )

        prompt_id = str(uuid.uuid4())
        try:
            valid = await execution.validate_prompt(prompt_id, prompt, None)
        except Exception as err:
            logger.exception("PocketNAI 校验模板时发生异常")
            return _error("模板校验失败", status=500, details=str(err))

        if not valid[0]:
            return _error("模板校验未通过", details=str(valid[1]), node_errors=valid[3] if len(valid) > 3 else {})

        outputs = valid[2]
        server = PromptServer.instance
        extra_data = {"client_id": client_id, "create_time": int(time.time() * 1000)}
        with _state_lock:
            number = server.number
            server.number += 1
            server.prompt_queue.put((number, prompt_id, prompt, extra_data, outputs, {}))

        logger.info("PocketNAI 已提交任务 %s（模板「%s」）", prompt_id, config["display_title"])
        return web.json_response(
            {
                "prompt_id": prompt_id,
                "number": number,
                "title": config["display_title"],
                "skipped": len(skipped),
            }
        )

    @_route("POST", "/api/cancel")
    async def cancel_generation(request: web.Request):
        try:
            data = await request.json()
        except (json.JSONDecodeError, ValueError):
            return _error("请求体不是合法 JSON")
        if not isinstance(data, dict):
            return _error("请求体必须是 JSON 对象")
        prompt_id = str(data.get("prompt_id") or "").strip()
        if not prompt_id:
            return _error("缺少 prompt_id")

        queue = PromptServer.instance.prompt_queue
        interrupted = False
        removed = False

        interrupt = getattr(queue, "interrupt_if_running", None)
        try:
            if callable(interrupt):
                interrupted = bool(interrupt(prompt_id))
            else:
                import nodes

                nodes.interrupt_processing()
                interrupted = True
        except Exception:
            logger.exception("PocketNAI 中断任务失败：%s", prompt_id)

        try:
            removed = bool(queue.delete_queue_item(lambda item: item[1] == prompt_id))
        except Exception:
            logger.exception("PocketNAI 清理排队任务失败：%s", prompt_id)

        stopped = interrupted or removed
        if stopped:
            logger.info(
                "PocketNAI 已停止任务 %s（interrupt=%s, dequeue=%s）",
                prompt_id,
                interrupted,
                removed,
            )
        else:
            logger.info("PocketNAI 任务 %s 已结束，无需停止", prompt_id)
        return web.json_response(
            {
                "ok": True,
                "stopped": stopped,
                "interrupted": interrupted,
                "removed": removed,
            }
        )

    @routes.get("/pocket")
    @routes.get("/pocket/")
    async def pocket_index(request: web.Request):
        if not (DIST_DIR / "index.html").is_file():
            return _missing_build_response()
        return _static_file("index.html", cache=False)

    @routes.get("/pocket/{tail:.*}")
    async def pocket_static(request: web.Request):
        tail = request.match_info.get("tail", "")
        if tail.startswith("api/"):
            return _error("接口不存在", status=404)
        if not DIST_DIR.is_dir():
            return _missing_build_response()
        cache = tail.startswith("assets/")
        try:
            return _static_file(tail, cache=cache)
        except web.HTTPNotFound:
            return _error("文件不存在", status=404)
