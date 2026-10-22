# PocketNAI 全流程脱离 PC & 双向数据一致性改造技术规格文档

## (Headless Workflow Persistence, LoRA Decoupling & Metadata Sidecar Spec)

本文档面向**具备高工程实现能力、专注于代码落地的开发者/编程模型**。文档定义了 `ComfyUI-suski-PocketNAI` 彻底脱离 PC 浏览器画布运行、修复 LoRA/磁贴状态不一致、引入服务端工作流持久化以及读取 Lora-Manager 伴随元数据进行优雅降级的高阶技术规格与实施代码。

---

## 目录

- [一、背景与核心痛点](#一背景与核心痛点)
- [二、总体架构变迁（从伴侣到独立控制台）](#二总体架构变迁从伴侣到独立控制台)
- [三、模块一：PC 端双向一致性修复（彻底根治旧 LoRA 死灰复燃）](#三模块一pc-端双向一致性修复彻底根治旧-lora-死灰复燃)
- [四、模块二：服务端工作流持久化存储（Workflow Store）](#四模块二服务端工作流持久化存储workflow-store)
- [五、模块三：LoRA 伴随元数据嗅探与优雅降级服务](#五模块三lora-伴随元数据嗅探与优雅降级服务)
- [六、模块四：移动端交互与 UI 改造（工作流切换 &amp; 原生 LoRA 选配）](#六模块四移动端交互与-ui-改造工作流切换--原生-lora-选配)
- [七、实施与验证清单（Verification Checklist）](#七实施与验证清单verification-checklist)

---

## 一、背景与核心痛点

当前系统存在以下三大致命痛点：

1. **工作流不同步与 LoRA 死灰复燃**：
   在移动端删除已挂载的 LoRA 后，PC 端节点的内部文本输入框（`inputWidget`）未被同步清理。一旦后续再次添加新 LoRA，Lora-Manager 会将旧文本与新文本拼接后重新解析，导致被删除的旧 LoRA 再次复活。此外，移动端改动未触发工作流落盘，重启后修改全失。
2. **过度依赖 PC 端画布活跃状态**：
   通过 Lora-Manager 添加 LoRA 强依赖 PC 端浏览器中的 `lora_loader.js` 监听 WebSocket 广播 `lora_code_update`。当 PC 端未开启时，移动端点击“发送到工作流”彻底失效。
3. **移动端无法独立使用与切换工作流**：
   工作流模板仅存在于 Python 后端的内存单例 `_state` 中，只有 PC 画布切换时才被动覆盖。移动端无法查看历史工作流列表，更无法自主切换。

---

## 二、总体架构变迁（从伴侣到独立控制台）

```text
【改造前：极长且脆弱的依赖链路】
移动端 iframe 打开 /loras ---> 点击发送到工作流 ---> 后端 WebSocket 广播
                                                            |
                                                            v
移动端呈现 <--- 后端内存 _state <--- PC 端重新 graphToPrompt <--- 【必须活跃】PC 端画布接收并改写
（PC 浏览器一关，全链路瘫痪）

【改造后：独立服务端闭环架构】
                           ┌──> 磁盘工作流持久化库 (saved_workflows/*.json)
                           │       ▲ (重启自动恢复 / 自由切换)
                           │       │
[移动端 PocketNAI] <=====> [PocketNAI 后端 Python API]
   - 切换工作流抽屉              - /suski/api/workflows (列出/切换)
   - 本地 LoRA 选配面板          - /suski/api/loras (嗅探本地 .metadata.json / 封面 / 触发词)
   - 结构化槽位参数编辑          - /suski/api/apply_slots (实时落盘)
                                 │
                                 ▼ (可选同步，PC 开则协同，不开完全不影响)
                           [PC 端浏览器画布 (suski_pc_hook.js)]
```

---

## 三、模块一：PC 端双向一致性修复（彻底根治旧 LoRA 死灰复燃）

### 3.1 根因与机理

`Lora Loader (LoraManager)` 节点在 LiteGraph 中维护两个属性：

1. `widgets["loras"]`：结构体数组 `[{name, strength, clipStrength, active}]`；
2. `node.inputWidget` 或 `widgets["text"]`：形如 `<lora:model_a:1.0> <lora:model_b:0.8>` 的纯文本。

当移动端删除 `model_a` 并通知 PC 时，原有的 `applyListValue` 只修改了 `loras` 数组，**未清理 `text` 控件**。后续 Lora-Manager 触发更新时执行 `inputWidget.value = currentValue + " <lora:model_c:1.0>"`，旧的 `model_a` 被重新解析注入。

### 3.2 代码修改实现

**文件位置**：`web/suski_pc_hook.js`
找到 `applyListValue` 函数（约第 614 行），替换为以下高健壮性实现：

```javascript
// web/suski_pc_hook.js

function applyListValue(node, widget, type, value) {
  const list = Array.isArray(value) ? value : [];
  
  if (type === "lm_loras") {
    const existing = Array.isArray(widget.value) ? widget.value : [];
    const merged = list.map((entry) => {
      const old = existing.find((item) => item?.name === entry?.name);
      if (old) return { ...old, ...entry };
      return {
        name: entry.name,
        strength: Number(entry.strength),
        clipStrength: Number(entry.clipStrength ?? entry.strength),
        active: entry.active !== false,
        expanded: false,
        locked: false,
        selected: false,
      };
    });

    // 1. 更新结构体数组控件
    widget.value = merged;
    widget.callback?.(merged);

    // 2. 【核心修复】：同步清洗并重构节点的 inputWidget / text 纯文本控件
    // 只保留处于启用状态且合法存在的 LoRA 标签，切断旧数据复活根源
    const reconstructedText = merged
      .filter((item) => item && item.active !== false && item.name)
      .map((item) => {
        const s = Number(item.strength);
        const cs = Number(item.clipStrength ?? item.strength);
        return s === cs ? `<lora:${item.name}:${s}>` : `<lora:${item.name}:${s}:${cs}>`;
      })
      .join(" ");

    const textWidget = node.inputWidget || (node.widgets || []).find((w) => w.name === "text");
    if (textWidget) {
      textWidget.value = reconstructedText;
      if (textWidget.inputEl) {
        textWidget.inputEl.value = reconstructedText;
      }
    }

    return merged;
  }

  if (type === "pv_tiles") {
    const existing = vaultTiles(widget);
    const merged = list.map((tile) => {
      const old = existing.find((item) => item?.instance_id && item.instance_id === tile.instance_id);
      return old ? { ...old, ...tile } : tile;
    });

    const serialized = JSON.stringify(merged);
    const state = node._vaultState;
    if (state && typeof state.loadFromSerialized === "function") {
      state.loadFromSerialized(serialized);
    }
    widget.value = serialized;
    if (widget.inputEl) {
      widget.inputEl.value = serialized;
    }
    widget.callback?.(widget.value);
    return merged;
  }

  return list;
}
```

---

## 四、模块二：服务端工作流持久化存储（Workflow Store）

### 4.1 核心需求

1. 不再依赖内存 `_state`；
2. 每次 PC 同步或移动端修改，自动落盘；
3. ComfyUI 启动时自动恢复上次活跃的工作流模板；
4. 提供工作流列表查询与一键切换 API。

### 4.2 具体实现

**文件位置**：`backend/routes.py`

在 `backend/routes.py` 中引入 `WorkflowStore`，并修改 `sync_template`、`apply_slots` 与 `register_routes`：

```python
# backend/routes.py 顶部引入
import re

WORKFLOWS_DIR = PLUGIN_ROOT / "saved_workflows"
WORKFLOWS_DIR.mkdir(parents=True, exist_ok=True)
ACTIVE_META_FILE = WORKFLOWS_DIR / "_active.json"


class WorkflowStore:
    @staticmethod
    def _safe_id(title: str) -> str:
        # 去除非法字符并统一小写
        cleaned = re.sub(r'[\\/*?:"<>| ]+', "_", str(title).strip()).strip("_")
        return cleaned or "default_workflow"

    @classmethod
    def save(cls, title: str, api_prompt: dict, config: dict, updated_at: str) -> str:
        file_id = cls._safe_id(title)
        file_path = WORKFLOWS_DIR / f"{file_id}.json"
        payload = {
            "id": file_id,
            "title": str(title)[:120],
            "api_prompt": api_prompt,
            "suski_config": config,
            "updated_at": updated_at,
        }
        file_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        ACTIVE_META_FILE.write_text(
            json.dumps({"active_id": file_id}, ensure_ascii=False), encoding="utf-8"
        )
        return file_id

    @classmethod
    def list_all(cls) -> list:
        results = []
        for path in WORKFLOWS_DIR.glob("*.json"):
            if path.name.startswith("_"):
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                results.append(
                    {
                        "id": data.get("id", path.stem),
                        "title": data.get("title", path.stem),
                        "slots_count": len(
                            data.get("suski_config", {}).get("slots", [])
                        ),
                        "updated_at": data.get("updated_at", ""),
                    }
                )
            except Exception:
                continue
        # 按更新时间倒序
        return sorted(results, key=lambda x: x.get("updated_at", ""), reverse=True)

    @classmethod
    def load(cls, file_id: str) -> dict:
        target = WORKFLOWS_DIR / f"{file_id}.json"
        if not target.is_file():
            raise FileNotFoundError(f"找不到工作流: {file_id}")
        data = json.loads(target.read_text(encoding="utf-8"))
        ACTIVE_META_FILE.write_text(
            json.dumps({"active_id": file_id}, ensure_ascii=False), encoding="utf-8"
        )
        return data

    @classmethod
    def restore_active(cls) -> dict:
        active_id = None
        if ACTIVE_META_FILE.is_file():
            try:
                active_id = json.loads(
                    ACTIVE_META_FILE.read_text(encoding="utf-8")
                ).get("active_id")
            except Exception:
                pass
        if active_id:
            try:
                return cls.load(active_id)
            except Exception:
                pass
        items = cls.list_all()
        if items:
            return cls.load(items[0]["id"])
        return None


# 服务启动时执行自动恢复
_restored = WorkflowStore.restore_active()
if _restored:
    with _state_lock:
        _state["api_prompt"] = _restored["api_prompt"]
        _state["config"] = _restored["suski_config"]
        _state["updated_at"] = _restored["updated_at"]
    logger.info("PocketNAI 自动恢复活跃工作流: 「%s」", _restored["title"])
```

在 `sync_template` 和 `apply_slots` 成功注入后，追加落盘：

```python
# 在 sync_template 成功后：
WorkflowStore.save(config["display_title"], _state["api_prompt"], config, updated_at)

# 在 apply_slots 成功后：
WorkflowStore.save(config["display_title"], _state["api_prompt"], config, updated_at)
```

### 4.3 新增工作流切换 API

在 `register_routes()` 中追加：

```python
@routes.get("/suski/api/workflows")
async def get_workflows(request: web.Request):
    with _state_lock:
        current_title = (
            _state["config"].get("display_title") if _state["config"] else None
        )
    return web.json_response(
        {
            "ok": True,
            "active_title": current_title,
            "workflows": WorkflowStore.list_all(),
        }
    )


@routes.post("/suski/api/workflows/switch")
async def switch_workflow(request: web.Request):
    try:
        data = await request.json()
    except Exception:
        return _error("非法 JSON 请求")

    target_id = str(data.get("id") or "").strip()
    if not target_id:
        return _error("缺少 workflow id")

    try:
        wf = WorkflowStore.load(target_id)
    except FileNotFoundError:
        return _error("指定的工作流不存在", status=404)

    with _state_lock:
        _state["api_prompt"] = copy.deepcopy(wf["api_prompt"])
        _state["config"] = copy.deepcopy(wf["suski_config"])
        _state["updated_at"] = wf["updated_at"]

    PromptServer.instance.send_sync(
        "suski:template_synced",
        {
            "title": _state["config"]["display_title"],
            "slots": len(_state["config"]["slots"]),
            "updated_at": _state["updated_at"],
        },
    )
    return web.json_response({"ok": True, "title": _state["config"]["display_title"]})
```

---

## 五、模块三：LoRA 伴随元数据嗅探与优雅降级服务

### 5.1 伴随文件嗅探与解析规范

**文件位置**：`backend/routes.py`

支持 Lora-Manager 及 Civitai Helper 生成的伴随文件：

- 封面图：`.preview.png`, `.preview.jpg`, `.png`, `.jpg`, `.webp`, `.jpeg`
- 元数据：`.metadata.json`, `.civitai.info`, `.json`

实现零外网请求的纯本地高效解析器：

```python
# backend/routes.py
import folder_paths

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


def _inspect_lora_metadata(lora_relative_path: str) -> dict:
    full_path = folder_paths.get_full_path("loras", lora_relative_path)
    base_info = {
        "name": lora_relative_path,
        "base_name": Path(lora_relative_path).stem,
        "has_meta": False,
        "trigger_words": [],
        "preferred_weight": 1.0,
        "base_model": None,
        "preview_url": None,
    }
    if not full_path or not os.path.isfile(full_path):
        return base_info

    p = Path(full_path)
    base_no_ext = p.parent / p.stem

    # 1. 嗅探本地预览图
    for ext in PREVIEW_EXTS:
        candidate = base_no_ext.with_name(f"{p.stem}{ext}")
        if candidate.is_file():
            # 采用相对 loras 目录的路径作为参数
            base_info["preview_url"] = (
                f"/suski/api/lora_preview?name={folder_paths.strip_path(str(p.parent), candidate.name)}"
            )
            break

    # 2. 嗅探并解析伴随 JSON
    meta_json = None
    for ext in METADATA_EXTS:
        candidate = base_no_ext.with_name(f"{p.stem}{ext}")
        if candidate.is_file():
            try:
                meta_json = json.loads(candidate.read_text(encoding="utf-8"))
                break
            except Exception:
                continue

    if isinstance(meta_json, dict):
        base_info["has_meta"] = True

        # 提取触发词
        words = meta_json.get("trainedWords") or meta_json.get("trigger_words") or []
        if isinstance(words, list):
            base_info["trigger_words"] = [
                str(w).strip() for w in words if str(w).strip()
            ][:16]

        # 提取推荐权重
        weight = (
            meta_json.get("preferredWeight")
            or meta_json.get("weight")
            or meta_json.get("recommended_weight")
        )
        try:
            if weight is not None:
                base_info["preferred_weight"] = round(float(weight), 2)
        except (TypeError, ValueError):
            pass

        # 提取底模版本
        base_model = meta_json.get("baseModel") or meta_json.get("base_model")
        if not base_model and isinstance(meta_json.get("modelVersion"), dict):
            base_model = meta_json["modelVersion"].get("baseModel")
        if base_model:
            base_info["base_model"] = str(base_model)

    return base_info
```

### 5.2 注册路由服务

在 `register_routes()` 中追加：

```python
@routes.get("/suski/api/loras")
async def list_available_loras(request: web.Request):
    try:
        names = folder_paths.get_filename_list("loras")
    except Exception:
        names = []

    items = []
    for name in sorted(names):
        try:
            items.append(_inspect_lora_metadata(name))
        except Exception:
            items.append(
                {
                    "name": name,
                    "base_name": Path(name).stem,
                    "has_meta": False,
                    "trigger_words": [],
                    "preferred_weight": 1.0,
                    "base_model": None,
                    "preview_url": None,
                }
            )
    return web.json_response({"ok": True, "loras": items})


@routes.get("/suski/api/lora_preview")
async def serve_lora_preview(request: web.Request):
    name = request.query.get("name", "")
    if not name:
        return web.Response(status=404)
    full_path = folder_paths.get_full_path("loras", name)
    if not full_path or not os.path.isfile(full_path):
        return web.Response(status=404)
    return web.FileResponse(full_path)
```

---

## 六、模块四：移动端交互与 UI 改造（工作流切换 & 原生 LoRA 选配）

### 6.1 前端 API 封装

**文件位置**：`mobile_web/src/api.js`，追加：

```javascript
// mobile_web/src/api.js

export async function fetchWorkflows() {
  return requestJson("/suski/api/workflows");
}

export async function switchWorkflow(id) {
  return requestJson("/suski/api/workflows/switch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

export async function fetchAvailableLoras() {
  return requestJson("/suski/api/loras");
}
```

### 6.2 移动端原生 LoRA 选择器与触发词注入

**文件位置**：`mobile_web/src/components/ActiveLoraTray.vue`

改造托盘组件：

1. 顶部提供“➕ 添加 LoRA”按钮；
2. 弹出原生抽屉面板，支持搜索 LoRA、底模、触发词；
3. 卡片展示封面图、底模徽章、推荐权重；
4. 点击触发词标签，向父组件抛出 `insert-prompt` 事件，方便一键填词。

```vue
<!-- mobile_web/src/components/ActiveLoraTray.vue 核心交互 -->
<script setup>
import { ref, computed } from "vue";
import { fetchAvailableLoras } from "../api.js";
import { LORA_MAX, LORA_MIN, LORA_STEP, clampStrength, formatStrength } from "../integrations/loraManager.js";

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
});

const emit = defineEmits(["update:modelValue", "insert-prompt"]);

const entries = computed(() => props.modelValue || []);
const showPicker = ref(false);
const searchQuery = ref("");
const availableLoras = ref([]);
const loadingLoras = ref(false);

async function openPicker() {
  showPicker.value = true;
  if (!availableLoras.value.length) {
    loadingLoras.value = true;
    try {
      const res = await fetchAvailableLoras();
      availableLoras.value = res.loras || [];
    } finally {
      loadingLoras.value = false;
    }
  }
}

const filteredLoras = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return availableLoras.value;
  return availableLoras.value.filter((item) =>
    item.name.toLowerCase().includes(q) ||
    (item.base_model && item.base_model.toLowerCase().includes(q)) ||
    item.trigger_words.some((w) => w.toLowerCase().includes(q))
  );
});

function addLora(item) {
  if (entries.value.some((e) => e.name === item.name)) return;
  const initial = Number.isFinite(item.preferred_weight) ? item.preferred_weight : 1.0;
  emit("update:modelValue", [
    ...entries.value,
    {
      name: item.name,
      strength: initial,
      clipStrength: initial,
      active: true,
    },
  ]);
  showPicker.value = false;
}

function onTriggerClick(word, event) {
  event.stopPropagation();
  emit("insert-prompt", word);
}
</script>

<template>
  <div class="lora-tray">
    <div class="tray-toolbar">
      <button class="add-lora-btn" type="button" @click="openPicker">
        ➕ 添加 LoRA 模型
      </button>
    </div>

    <!-- 现有的已挂载卡片列表保持原样 -->
    <article v-for="(entry, index) in entries" :key="entry.name" class="lora-card">
      <!-- 原有逻辑 -->
    </article>

    <!-- 原生 LoRA 选配抽屉 -->
    <div v-if="showPicker" class="picker-overlay" @click.self="showPicker = false">
      <div class="picker-sheet">
        <header class="picker-head">
          <input
            v-model="searchQuery"
            type="search"
            class="picker-input"
            placeholder="搜索模型、底模 (如 SDXL) 或触发词..."
            autofocus
          />
          <button class="picker-close" @click="showPicker = false">✕</button>
        </header>

        <div v-if="loadingLoras" class="picker-state">正在检索本地 LoRA 库...</div>

        <div v-else class="picker-list">
          <div
            v-for="item in filteredLoras"
            :key="item.name"
            class="picker-item"
            :class="{ added: entries.some((e) => e.name === item.name) }"
            @click="addLora(item)"
          >
            <div class="picker-thumb">
              <img v-if="item.preview_url" :src="item.preview_url" loading="lazy" alt="preview" />
              <div v-else class="picker-thumb-none">🎨</div>
              <span v-if="item.base_model" class="model-badge">{{ item.base_model }}</span>
            </div>

            <div class="picker-details">
              <div class="picker-title">{{ item.base_name }}</div>
              <div v-if="item.preferred_weight !== 1.0" class="picker-rec">
                推荐权重: {{ item.preferred_weight }}
              </div>
              <div v-if="item.trigger_words.length" class="picker-words">
                <span
                  v-for="word in item.trigger_words"
                  :key="word"
                  class="word-tag"
                  @click="onTriggerClick(word, $event)"
                >
                  + {{ word }}
                </span>
              </div>
            </div>

            <div class="picker-btn-box">
              <span v-if="entries.some((e) => e.name === item.name)" class="tag-added">已挂载</span>
              <button v-else type="button" class="btn-use">选用</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
```

### 6.3 移动端工作流切换抽屉与触发词注入

**文件位置**：`mobile_web/src/App.vue`

1. **Header 挂载工作流切换触发器**：
   在顶部标题栏绑定点击事件打开 `state.workflowDrawer = true`。
2. **连接 `@insert-prompt` 事件**：
   在 `<ActiveLoraTray>` 上监听 `@insert-prompt="handleInsertWord"`，直接将触发词插入正向提示词。
3. **工作流抽屉与切换逻辑**：
   ```javascript
   // mobile_web/src/App.vue
   const workflowList = ref([]);
   const loadingWorkflows = ref(false);

   async function openWorkflowDrawer() {
     state.workflowDrawer = true;
     loadingWorkflows.value = true;
     try {
       const res = await fetchWorkflows();
       workflowList.value = res.workflows || [];
     } finally {
       loadingWorkflows.value = false;
     }
   }

   async function handleSwitch(wfId) {
     try {
       state.loading = true;
       await switchWorkflow(wfId);
       await reloadConfig({ quiet: false });
       showToast("工作流切换成功", "success");
       state.workflowDrawer = false;
     } catch (err) {
       showToast(`切换失败: ${err.message}`, "error");
     } finally {
       state.loading = false;
     }
   }

   function handleInsertWord(word) {
     const promptSlot = state.config?.slots.find((s) => s.type === "prompt");
     if (!promptSlot) return;
     const key = slotKey(promptSlot);
     const cur = values[key] || "";
     const trimmed = cur.trim();
     const nextVal = trimmed
       ? /[,，]$/.test(trimmed) ? `${trimmed} ${word},` : `${trimmed}, ${word},`
       : `${word},`;
     setValue(key, nextVal);
     showToast(`已插入触发词: ${word}`, "info");
   }
   ```

---

## 七、实施与验证清单（Verification Checklist）

执行模型在完成代码变更后，应自检以下测试项：

- [ ] **PC Hook 文本同步验证**：
  1. 在手机端添加 LoRA `A` 与 `B`；
  2. 在手机端删除 `A`，检查 PC 对应节点上 `text` 控件中是否只保留了 `<lora:B:...>`；
  3. 再次添加 `C`，验证 `A` 是否彻底消失（**决不能复活**）。
- [ ] **无 PC 端情况下的冷启动出图**：
  1. 完全关闭所有 PC 端浏览器标签页；
  2. 重启 ComfyUI 进程；
  3. 手机打开 PocketNAI 页面，验证是否正常恢复上次使用的工作流模板，点击“立即生成”可正常排队出图。
- [ ] **无 PC 端情况下的 LoRA 原生选配**：
  1. 在 PC 浏览器关闭状态下，在手机端点击“➕ 添加 LoRA”；
  2. 验证本地 LoRA 卡片列表是否正常显示封面、底模与推荐权重；
  3. 点击触发词标签，验证是否正确注入正面提示词框；
  4. 选用后调节权重并生成，验证后端生成的 API Prompt 中包含了新挂载的 LoRA。
- [ ] **多工作流持久化切换**：
  1. 在手机端打开工作流抽屉，切换至另一个保存的工作流；
  2. 验证页面槽位是否立即切换更新，生成参数与目标流程完全一致。
