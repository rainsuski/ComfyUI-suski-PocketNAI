import copy
import json
import logging
import random
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from aiohttp import web

import execution
from server import PromptServer

from .tag_locator import find_tags_file

logger = logging.getLogger("ComfyUI-suski-PocketNAI")

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = PLUGIN_ROOT / "dist"
CONFIG_VERSION = "2.0.0"
MAX_SEED = 1125899906842624
MAX_SLOT_TARGETS = 64
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
}
# 探测可选外部插件时使用的路由：插件没装时对应入口在移动端整体隐藏。
INTEGRATION_ROUTES = {
    "lora_manager": "/loras",
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
    targets = _clean_targets(raw.get("targets"))
    if targets:
        slot["targets"] = targets
    return slot


def _clean_config(raw: dict) -> dict:
    slots = raw.get("slots", [])
    if not isinstance(slots, list):
        raise ValueError("suski_config.slots 必须是数组")

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
            if not isinstance(inputs, dict) or target_field not in inputs:
                if supplied:
                    skipped.append(f"{slot['label']}（节点 {target_node_id} 缺少 {target_field}）")
                continue
            if supplied and _is_link(inputs[target_field]):
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
        response.headers["Service-Worker-Allowed"] = "/suski/"
    return response


def _missing_build_response() -> web.Response:
    return web.Response(
        status=503,
        text="PocketNAI 前端尚未构建，请在 mobile_web 目录执行 npm install && npm run build。",
        content_type="text/plain",
    )


def register_routes():
    routes = PromptServer.instance.routes

    @routes.get("/suski/api/config")
    async def get_config(request: web.Request):
        return await _config_response()

    @routes.get("/suski/api/integrations")
    async def get_integrations(request: web.Request):
        registered = {resource.canonical for resource in PromptServer.instance.app.router.resources()}
        return web.json_response(
            {name: path in registered for name, path in INTEGRATION_ROUTES.items()}
        )

    @routes.post("/suski/api/sync_template")
    async def sync_template(request: web.Request):
        try:
            data = await request.json()
        except (json.JSONDecodeError, ValueError):
            return _error("请求体不是合法 JSON")
        if not isinstance(data, dict):
            return _error("请求体必须是 JSON 对象")

        api_prompt = data.get("api_prompt")
        raw_config = data.get("suski_config")
        if not isinstance(api_prompt, dict):
            return _error("api_prompt 必须是对象")
        if not isinstance(raw_config, dict):
            return _error("suski_config 必须是对象")

        try:
            config = _clean_config(raw_config)
        except ValueError as err:
            return _error("suski_config 格式错误", details=str(err))

        updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with _state_lock:
            _state["api_prompt"] = copy.deepcopy(api_prompt)
            _state["config"] = config
            _state["updated_at"] = updated_at

        logger.info(
            "PocketNAI 已同步模板「%s」，槽位 %d 个",
            config["display_title"],
            len(config["slots"]),
        )
        PromptServer.instance.send_sync(
            "suski:template_synced",
            {
                "title": config["display_title"],
                "slots": len(config["slots"]),
                "updated_at": updated_at,
            },
        )
        return web.json_response(
            {
                "ok": True,
                "title": config["display_title"],
                "slots": len(config["slots"]),
                "updated_at": updated_at,
            }
        )

    @routes.post("/suski/api/apply_slots")
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

        if skipped:
            logger.warning(
                "PocketNAI 写回时跳过 %d 个失效槽位：%s",
                len(skipped),
                "；".join(skipped[:6]),
            )
        PromptServer.instance.send_sync("suski:apply_slots", {"slots_data": plain_updates})
        return web.json_response(
            {
                "ok": True,
                "applied": len(requested),
                "skipped": len(skipped),
                "updated_at": updated_at,
            }
        )

    @routes.get("/suski/api/tags.csv")
    async def get_tags(request: web.Request):
        path = find_tags_file()
        if not path.is_file():
            return _error("找不到 Danbooru 词库", status=404)
        # FileResponse 自带 ETag / Last-Modified，重复访问只回 304，同时避免
        # 每次请求都把整个词库读进内存。
        response = web.FileResponse(path)
        response.headers["Cache-Control"] = "no-cache"
        return response

    @routes.post("/suski/api/execute")
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
            # ComfyUI's execution loop consumes (number, prompt_id, prompt,
            # extra_data, outputs, sensitive).
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

    @routes.get("/suski")
    @routes.get("/suski/")
    async def mobile_index(request: web.Request):
        if not (DIST_DIR / "index.html").is_file():
            return _missing_build_response()
        return _static_file("index.html", cache=False)

    @routes.get("/suski/{tail:.*}")
    async def mobile_static(request: web.Request):
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
