import { api } from "/scripts/api.js";
import { app } from "/scripts/app.js";

const VERSION = "2.0.0";
const CONFIG_KEY = "pocket_config";
const SYNC_URL = "/pocket/api/sync_template";
const DEFAULT_TITLE = "ComfyUI 工作流";
const OUTPUT_TYPES = new Set(["SaveImage", "PreviewImage"]);
const INTERNAL_WIDGETS = new Set(["control_after_generate", "control_before_generate"]);
const LORA_NODE_CLASS = "Lora Loader (LoraManager)";
const LORA_FIELD = "loras";
const VAULT_NODE_CLASS = "PromptVaultSelector";
const VAULT_FIELD = "selected_tiles_data";
// Aaalice-Nodes 的 ResolutionPreset 没有原生输入控件：预设、宽高与画布上限
// 都存在 node.properties 里，执行前由扩展把 {version,width,height} 写成
// API Prompt 的 resolution_json。槽位因此也以该输入名为落点。
const RESOLUTION_NODE_CLASS = "ResolutionPreset";
const RESOLUTION_FIELD = "resolution_json";
const RESOLUTION_PROPERTY = "resolutionPresetState";
const RESOLUTION_ALIGNMENTS = Object.freeze([8, 16, 32, 64]);
const RESOLUTION_CANVAS_LIMITS = Object.freeze([2048, 4096, 8192]);
const RESOLUTION_MIN = 16;
const RESOLUTION_MAX = 16384;

let nativeGraphToPrompt = null;
let nativeQueuePrompt = null;
let syncTimer = null;
let syncInFlight = null;
let syncDirty = false;
let collectingPrompt = false;
let domBadgeObserver = null;
let domBadgeFrame = 0;

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function activeWorkflowName() {
  let workflow = app.extensionManager?.workflow?.activeWorkflow;
  if (workflow?.value) workflow = workflow.value;
  let name = workflow?.name;
  if (name?.value) name = name.value;
  let filename = workflow?.filename;
  if (filename?.value) filename = filename.value;
  const resolved = name || filename?.replace(/\.json$/i, "");
  return typeof resolved === "string" && resolved.trim() ? resolved.trim() : DEFAULT_TITLE;
}

function configOf(graph) {
  const extra = graph.extra || (graph.extra = {});
  let config = extra[CONFIG_KEY];
  if (!config || typeof config !== "object") {
    config = { version: VERSION, display_title: activeWorkflowName(), output_node_id: null, slots: [] };
    extra[CONFIG_KEY] = config;
  }
  if (!Array.isArray(config.slots)) config.slots = [];
  config.version = VERSION;
  if (!config.display_title) config.display_title = activeWorkflowName();
  if (!("output_node_id" in config)) config.output_node_id = null;
  return config;
}

function peekConfig(graph) {
  const config = graph?.extra?.[CONFIG_KEY];
  return config && Array.isArray(config.slots) ? config : null;
}

function nodeById(nodeId) {
  if (nodeId === null || nodeId === undefined) return null;
  return app.graph?.getNodeById?.(Number(nodeId)) ?? app.graph?.getNodeById?.(String(nodeId)) ?? null;
}

function nodeWidget(node, field) {
  if (field === RESOLUTION_FIELD && isResolutionNode(node)) return resolutionWidget(node);
  return (node?.widgets || []).find((widget) => widget.name === field) || null;
}

function nodeClass(node) {
  return node?.comfyClass || node?.type || "";
}

function isResolutionNode(node) {
  const classes = [
    node?.comfyClass,
    node?.type,
    node?.constructor?.comfyClass,
    node?.constructor?.nodeData?.name,
  ];
  return classes.includes(RESOLUTION_NODE_CLASS);
}

function isResolutionWidget(node, widget) {
  return isResolutionNode(node) && widget?.name === RESOLUTION_FIELD;
}

function alignResolutionDimension(value, alignment) {
  const unit = RESOLUTION_ALIGNMENTS.includes(Number(alignment)) ? Number(alignment) : 8;
  const minimum = Math.ceil(RESOLUTION_MIN / unit) * unit;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return minimum;
  const clamped = Math.min(RESOLUTION_MAX, Math.max(minimum, Math.round(numeric)));
  return Math.min(RESOLUTION_MAX, Math.max(minimum, Math.round(clamped / unit) * unit));
}

function resolutionPresetMatches(preset, width, height, alignment) {
  return Number(preset?.width) === width
    && Number(preset?.height) === height
    && (preset?.group !== "personal" || Number(preset?.alignment) === alignment);
}

function resolutionPresets(node) {
  let raw = [];
  try {
    raw = node?._aaaliceResolutionControl?.getPresets?.() ?? [];
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const presets = [];
  for (const preset of raw) {
    if (!preset || typeof preset !== "object") continue;
    const id = String(preset.id || "").trim();
    const width = Number(preset.width);
    const height = Number(preset.height);
    if (!id || seen.has(id)) continue;
    if (!Number.isInteger(width) || !Number.isInteger(height)) continue;
    if (width < RESOLUTION_MIN || height < RESOLUTION_MIN) continue;
    if (width > RESOLUTION_MAX || height > RESOLUTION_MAX) continue;
    seen.add(id);
    presets.push({
      id,
      name: String(preset.name || `${width}×${height}`).slice(0, 48),
      width,
      height,
      alignment: RESOLUTION_ALIGNMENTS.includes(Number(preset.alignment)) ? Number(preset.alignment) : 8,
      group: ["square", "portrait", "landscape", "personal"].includes(preset.group)
        ? String(preset.group)
        : "square",
    });
  }
  return presets;
}

function resolutionAlignments(node) {
  let raw = [];
  try {
    raw = node?._aaaliceResolutionControl?.getAlignments?.() ?? [];
  } catch {
    return [...RESOLUTION_ALIGNMENTS];
  }
  const values = [...new Set(
    (Array.isArray(raw) ? raw : [])
      .map((value) => Number(value))
      .filter((value) => RESOLUTION_ALIGNMENTS.includes(value)),
  )].sort((left, right) => left - right);
  return values.length ? values : [...RESOLUTION_ALIGNMENTS];
}

function resolutionCanvasLimits(node) {
  let raw = [];
  try {
    raw = node?._aaaliceResolutionControl?.getCanvasLimits?.() ?? [];
  } catch {
    return [...RESOLUTION_CANVAS_LIMITS];
  }
  const values = [...new Set(
    (Array.isArray(raw) ? raw : [])
      .map((value) => Number(value))
      .filter((value) => RESOLUTION_CANVAS_LIMITS.includes(value)),
  )].sort((left, right) => left - right);
  return values.length ? values : [...RESOLUTION_CANVAS_LIMITS];
}

// 与 Aaalice 的 normalizeResolutionState 保持同样的收敛规则；不依赖扩展内部
// 模块，Aaalice 尚未加载时也能从 properties 里读到上次保存的状态。
function normalizeResolutionState(raw, presets, alignments, limits) {
  if (!raw || typeof raw !== "object") return null;
  const allowedAlignments = alignments?.length ? alignments : RESOLUTION_ALIGNMENTS;
  const allowedLimits = limits?.length ? limits : RESOLUTION_CANVAS_LIMITS;
  const alignment = allowedAlignments.includes(Number(raw.alignment)) ? Number(raw.alignment) : 8;
  const width = alignResolutionDimension(raw.width ?? 1024, alignment);
  const height = alignResolutionDimension(raw.height ?? 1024, alignment);
  const minimumCanvas = allowedLimits.find((limit) => Math.max(width, height) <= limit) || allowedLimits.at(-1);
  const requested = allowedLimits.includes(Number(raw.canvasMax)) ? Number(raw.canvasMax) : 2048;
  const canvasMax = Math.max(minimumCanvas, requested);
  const list = Array.isArray(presets) ? presets : [];
  const hinted = list.find((preset) => preset.id === raw.presetId && resolutionPresetMatches(preset, width, height, alignment));
  const matched = hinted || list.find((preset) => resolutionPresetMatches(preset, width, height, alignment));
  return { version: 1, width, height, alignment, canvasMax, presetId: matched?.id || null };
}

function resolutionState(node, presets = resolutionPresets(node)) {
  let raw;
  try {
    raw = node?._aaaliceResolutionControl?.getValue?.();
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object") raw = node?.properties?.[RESOLUTION_PROPERTY];
  return normalizeResolutionState(
    raw,
    presets,
    resolutionAlignments(node),
    resolutionCanvasLimits(node),
  );
}

function resolutionPayload(state) {
  return { version: 1, width: state.width, height: state.height };
}

// 给没有 LiteGraph 控件的节点造一个只读视图，槽位选择、序列化与标签都能复用
// 现有逻辑；真正写入时走 Aaalice 的 _aaaliceResolutionControl.setValue。
function resolutionWidget(node) {
  const state = resolutionState(node);
  if (!state) return null;
  return { name: RESOLUTION_FIELD, type: "resolution", value: state, options: { serialize: false } };
}

// 老版本后端不认识 resolution 类型，会把槽位降级成 text 并丢掉附加字段。
// 把预设元数据同时塞进 default_val，降级后手机仍能读到完整的预设列表。
function resolutionSlotState(node) {
  const state = resolutionState(node);
  if (!state) return null;
  return {
    ...state,
    presets: resolutionPresets(node),
    alignments: resolutionAlignments(node),
    canvas_limits: resolutionCanvasLimits(node),
  };
}

function isSubgraphNode(node) {
  return typeof node?.isSubgraphNode === "function" && node.isSubgraphNode();
}

function dedupeTargets(targets) {
  const seen = new Set();
  const result = [];
  for (const target of targets) {
    const key = `${target.node_id}:${target.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(target);
  }
  return result;
}

// 子图实例本身不会出现在 API Prompt 里，graphToPrompt 只会输出扁平化的
// "实例ID:内部节点ID"。沿子图输入槽的 linkIds 找到真正的叶子控件，
// 注入时才能写到内部节点，而不是 outer node id。
function resolveSubgraphLeafTargets(node, inputName, nodePath = []) {
  if (!isSubgraphNode(node) || !node.subgraph?.inputNode?.slots) return [];
  const slot = node.subgraph.inputNode.slots.find((entry) => entry.name === inputName);
  if (!slot) return [];
  const path = [...nodePath, String(node.id)];
  const targets = [];
  for (const linkId of slot.linkIds || []) {
    const link = node.subgraph.getLink?.(linkId);
    if (!link || typeof link.resolve !== "function") continue;
    const resolved = link.resolve(node.subgraph);
    const targetNode = resolved?.inputNode;
    const targetInput = resolved?.input;
    if (!targetNode || !targetInput) continue;
    if (isSubgraphNode(targetNode)) {
      targets.push(...resolveSubgraphLeafTargets(targetNode, targetInput.name, path));
      continue;
    }
    const widget = targetNode.getWidgetFromSlot?.(targetInput);
    if (!widget?.name) continue;
    targets.push({
      node_id: [...path, String(targetNode.id)].join(":"),
      field: widget.name,
      node: targetNode,
      widget,
    });
  }
  return dedupeTargets(targets);
}

function slotLeafTargets(node, widget) {
  if (!node || !widget?.name) return [];
  if (isSubgraphNode(node)) return resolveSubgraphLeafTargets(node, widget.name);
  return [{ node_id: String(node.id), field: widget.name, node, widget }];
}

function isWidgetConnected(node, widget) {
  if (!node || !widget?.name) return false;
  const input = (node.inputs || []).find(
    (entry) => entry?.widget?.name === widget.name || entry?.name === widget.name,
  );
  return Boolean(input?.link != null);
}

function leafListType(leaves) {
  const leaf = leaves?.[0];
  if (!leaf) return null;
  if (nodeClass(leaf.node) === VAULT_NODE_CLASS && leaf.widget.name === VAULT_FIELD) return "pv_tiles";
  if (nodeClass(leaf.node) === LORA_NODE_CLASS && leaf.widget.name === LORA_FIELD) return "lm_loras";
  return null;
}

const GENERIC_LABELS = new Set(["值", "value", "文本", "text", "字符串", "string"]);

function isLoraWidget(node, widget) {
  return nodeClass(node) === LORA_NODE_CLASS && widget?.name === LORA_FIELD;
}

function isVaultWidget(node, widget) {
  return nodeClass(node) === VAULT_NODE_CLASS && widget?.name === VAULT_FIELD;
}

// LoraLoaderLM 的 loras 控件是对象数组。移动端只接管真正参与加载的字段，
// 顺带丢掉 selected 这类纯画布选择态。
function loraEntries(widget) {
  const value = widget?.value;
  if (!Array.isArray(value)) return [];
  const entries = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || !entry.name) continue;
    const strength = Number(entry.strength);
    const clipStrength = Number(entry.clipStrength ?? entry.strength);
    entries.push({
      name: entry.name,
      strength: Number.isFinite(strength) ? strength : 1,
      clipStrength: Number.isFinite(clipStrength) ? clipStrength : Number.isFinite(strength) ? strength : 1,
      active: Boolean(entry.active),
    });
  }
  return entries;
}

// PromptVaultSelector 的磁贴只写在 serializeValue 里，权重变化不会回写 widget.value，
// 因此这里优先走 serializeValue 拿权威值。
function vaultTiles(widget) {
  if (!widget) return [];
  let raw = widget.value;
  if (typeof widget.serializeValue === "function") {
    try {
      const serialized = widget.serializeValue();
      if (typeof serialized === "string") raw = serialized;
    } catch {
      // 序列化失败时退回上一次写入的控件值。
    }
  }
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw.filter((tile) => tile && typeof tile === "object") : [];
}

function widgetOptions(widget) {
  const values = widget?.options?.values;
  if (typeof values === "function") {
    try {
      return values();
    } catch {
      return [];
    }
  }
  return Array.isArray(values) ? values : [];
}

function isBindableWidget(node, widget) {
  if (!widget || !widget.name || INTERNAL_WIDGETS.has(widget.name) || widget.type === "button") return false;
  if (isResolutionWidget(node, widget)) return true;
  if (isWidgetConnected(node, widget)) return false;
  if (leafListType(slotLeafTargets(node, widget))) return true;
  if (isLoraWidget(node, widget) || isVaultWidget(node, widget)) return true;
  if (widget.options?.serialize === false) return false;
  return ["string", "number", "combo", "toggle", "text", "slider", "INT", "FLOAT", "BOOLEAN"].includes(widget.type)
    || ["string", "number", "boolean"].includes(typeof widget.value);
}

function widgetLabel(node, widget) {
  if (isResolutionWidget(node, widget)) return "分辨率预设";
  const raw = String(widget.label ?? "").trim();
  const name = String(widget.name || "").toLowerCase();
  const nodeTitle = String(node?.title || "");
  const generic = !raw
    || raw === widget.name
    || GENERIC_LABELS.has(raw)
    || GENERIC_LABELS.has(raw.toLowerCase());
  if (!generic) return raw;
  if (name === "text" || name === "value") {
    if (/负面|negative/i.test(nodeTitle)) return "负面提示词";
    if (/正面|positive/i.test(nodeTitle)) return "正面提示词";
    if (nodeTitle && !/^clip\s*text\s*encode/i.test(nodeTitle)) return nodeTitle;
  }
  const labels = {
    text: "提示词",
    loras: "LoRA 挂载列表",
    selected_tiles_data: "预设磁贴",
    resolution_json: "分辨率预设",
    seed: "随机种子",
    noise_seed: "随机种子",
    steps: "采样步数",
    cfg: "CFG 引导",
    sampler_name: "采样器",
    scheduler: "调度器",
    denoise: "重绘幅度",
    width: "宽度",
    height: "高度",
    batch_size: "批次大小",
    guidance: "引导强度",
  };
  if (labels[name]) return labels[name];
  return widget.name;
}

function widgetTypeName(widget, node) {
  if (isResolutionWidget(node, widget)) return "resolution";
  if (isLoraWidget(node, widget)) return "lm_loras";
  if (isVaultWidget(node, widget)) return "pv_tiles";
  const name = String(widget.name || "").toLowerCase();
  const nodeText = `${node?.title || ""} ${node?.type || ""}`.toLowerCase();
  const type = widget.type;
  if (name.includes("seed") || name.endsWith("_seed")) return "seed";
  if (type === "toggle" || type === "BOOLEAN" || typeof widget.value === "boolean") return "toggle";
  if (type === "combo") return "combo";
  if (type === "number" || type === "slider" || type === "INT" || type === "FLOAT" || typeof widget.value === "number") {
    return widget.options?.min !== undefined || widget.options?.max !== undefined ? "slider" : "number";
  }
  if (name.includes("negative") || nodeText.includes("negative") || nodeText.includes("负面")) return "negative";
  if (
    widget.options?.multiline ||
    name === "text" ||
    name.includes("prompt") ||
    nodeText.includes("prompt") ||
    nodeText.includes("正面")) {
    return "prompt";
  }
  return "text";
}

function slotForWidget(node, widget) {
  const leaves = slotLeafTargets(node, widget);
  if (!leaves.length) return null;
  const type = leafListType(leaves) || widgetTypeName(widget, node);
  const slot = {
    node_id: String(node.id),
    field: widget.name,
    label: String(widgetLabel(node, widget)),
    type,
    default_val: widget.value,
    node_title: String(node.title || node.type || "节点"),
  };
  if (typeof widget.value === "number") {
    slot.value_kind = Number.isInteger(widget.value) ? "int" : "float";
  }
  if (type === "slider" || type === "number" || type === "seed") {
    for (const key of ["min", "max", "step"]) {
      if (typeof widget.options?.[key] === "number") slot[key] = widget.options[key];
    }
    if (typeof widget.options?.step === "number" && !Number.isInteger(widget.options.step)) {
      slot.value_kind = "float";
    }
  }
  if (type === "combo") {
    slot.options = widgetOptions(widget).filter((value) => ["string", "number", "boolean"].includes(typeof value));
    if (typeof slot.default_val === "number") slot.value_kind = Number.isInteger(slot.default_val) ? "int" : "float";
  }
  if (type === "resolution") {
    const state = resolutionSlotState(node);
    if (state) {
      slot.default_val = state;
      slot.presets = state.presets;
      slot.alignments = state.alignments;
      slot.canvas_limits = state.canvas_limits;
    }
  } else if (type === "lm_loras") slot.default_val = loraEntries(widget);
  else if (type === "pv_tiles") slot.default_val = vaultTiles(widget);
  const targets = leaves.map(({ node_id, field }) => ({ node_id, field }));
  if (!(targets.length === 1 && targets[0].node_id === String(node.id) && targets[0].field === widget.name)) {
    slot.targets = targets;
  }
  return slot;
}

function normalizeConfig(graph) {
  const config = configOf(graph);
  const seen = new Set();
  const slots = [];
  for (const slot of config.slots) {
    if (!slot || slot.node_id === undefined || !slot.field) continue;
    const node = nodeById(slot.node_id);
    if (!node) continue;
    const key = `${slot.node_id}:${slot.field}`;
    if (seen.has(key)) continue;
    const widget = nodeWidget(node, slot.field);
    if (!widget || isWidgetConnected(node, widget)) continue;
    const leaves = slotLeafTargets(node, widget);
    if (!leaves.length) continue;
    seen.add(key);
    const leafType = leafListType(leaves);
    const resolution = isResolutionWidget(node, widget);
    const next = {
      ...slot,
      node_id: String(slot.node_id),
      label: String(widgetLabel(node, widget)),
      node_title: String(node.title || node.type || "节点"),
    };
    if (resolution) {
      next.type = "resolution";
      const state = resolutionSlotState(node);
      if (state) {
        next.default_val = state;
        next.presets = state.presets;
        next.alignments = state.alignments;
        next.canvas_limits = state.canvas_limits;
      }
    } else {
      if (leafType) next.type = leafType;
      if (next.type === "lm_loras") next.default_val = loraEntries(widget);
      else if (next.type === "pv_tiles") next.default_val = vaultTiles(widget);
      else if (widget.value !== undefined) next.default_val = widget.value;
    }
    if (next.type === "combo") next.options = widgetOptions(widget);
    const targets = leaves.map(({ node_id, field }) => ({ node_id, field }));
    if (targets.length === 1 && targets[0].node_id === String(node.id) && targets[0].field === widget.name) {
      delete next.targets;
    } else {
      next.targets = targets;
    }
    slots.push(next);
  }
  config.slots = slots;
  config.display_title = activeWorkflowName();
  if (config.output_node_id && !nodeById(config.output_node_id)) {
    config.output_node_id = null;
    config.output_node_title = null;
  }
  return config;
}

function commitConfig(graph) {
  const config = normalizeConfig(graph);
  graph.extra = graph.extra || {};
  graph.extra[CONFIG_KEY] = config;
  scheduleDomBadgeSync();
  return config;
}

function setSlot(node, widget, enabled) {
  const config = configOf(app.graph);
  const index = config.slots.findIndex(
    (slot) => String(slot.node_id) === String(node.id) && slot.field === widget.name,
  );
  if (enabled && index === -1) {
    const slot = slotForWidget(node, widget);
    if (!slot) return;
    config.slots.push(slot);
  } else if (!enabled && index !== -1) {
    config.slots.splice(index, 1);
  }
  commitConfig(app.graph);
  app.graph.setDirtyCanvas?.(true, true);
  node.setDirtyCanvas?.(true, true);
  scheduleSync();
}

function setOutputNode(node) {
  const config = configOf(app.graph);
  config.output_node_id = String(node.id);
  config.output_node_title = String(node.title || node.type || "输出节点");
  commitConfig(app.graph);
  app.graph.setDirtyCanvas?.(true, true);
  scheduleSync();
}

function clearOutputNode() {
  const config = configOf(app.graph);
  config.output_node_id = null;
  config.output_node_title = null;
  commitConfig(app.graph);
  app.graph.setDirtyCanvas?.(true, true);
  scheduleSync();
}

function isOutputNode(node) {
  return OUTPUT_TYPES.has(node.comfyClass) || OUTPUT_TYPES.has(node.type);
}

function nodeMenuItems(node) {
  const config = peekConfig(app.graph);
  const slots = (config?.slots || []).filter((slot) => String(slot.node_id) === String(node.id));
  const submenu = [];
  // ResolutionPreset 的界面全部由 DOM 绘制，没有可枚举的 LiteGraph 控件，
  // 这里单独给它一个槽位入口；状态仍写进 Properties，与画布完全同源。
  if (isResolutionNode(node)) {
    const bound = slots.some((slot) => slot.field === RESOLUTION_FIELD);
    const state = resolutionState(node);
    const size = state ? ` ${state.width}×${state.height}` : "";
    submenu.push({
      content: `${bound ? "✓" : "·"} 分辨率预设${size}`,
      callback: () => {
        const widget = resolutionWidget(node);
        if (widget) setSlot(node, widget, !bound);
      },
    });
  }
  const widgets = (node.widgets || [])
    .filter((widget) => isBindableWidget(node, widget))
    .filter((widget) => !isResolutionWidget(node, widget));
  submenu.push(...widgets.map((widget) => {
    const bound = slots.some((slot) => slot.field === widget.name);
    return {
      content: `${bound ? "✓" : "·"} ${widgetLabel(node, widget)}`,
      callback: () => setSlot(node, widget, !bound),
    };
  }));
  if (submenu.length === 0) submenu.push({ content: "此节点没有可绑定输入", disabled: true });

  const items = [{ content: "📱 移动端槽位", has_submenu: true, submenu: { options: submenu } }];
  if (isOutputNode(node)) {
    const isCurrent = String(config?.output_node_id) === String(node.id);
    items.push({
      content: isCurrent ? "取消 手机 主输出" : "设为 手机 主输出",
      callback: () => (isCurrent ? clearOutputNode() : setOutputNode(node)),
    });
  }
  return items;
}

// 画布角标用矢量路径绘制：手机=槽位节点，准星=主输出节点。
function drawPhoneBadge(ctx, cx, cy, size) {
  const width = size * 0.64;
  const height = size;
  const radius = Math.max(1.4, size * 0.15);
  ctx.beginPath();
  ctx.roundRect(cx - width / 2, cy - height / 2, width, height, radius);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.11, cy - height / 2 + size * 0.16);
  ctx.lineTo(cx + size * 0.11, cy - height / 2 + size * 0.16);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy + height / 2 - size * 0.14, Math.max(0.5, size * 0.05), 0, Math.PI * 2);
  ctx.fill();
}

function drawTargetBadge(ctx, cx, cy, size) {
  const radius = size * 0.3;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(0.6, size * 0.075), 0, Math.PI * 2);
  ctx.fill();
  const inner = radius + 1.1;
  const outer = size * 0.5;
  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx * inner, cy + dy * inner);
    ctx.lineTo(cx + dx * outer, cy + dy * outer);
    ctx.stroke();
  }
}

function drawBadge(node, ctx) {
  const config = peekConfig(app.graph);
  if (!config || !node || node.flags?.collapsed) return;
  const bound = config.slots.some((slot) => String(slot.node_id) === String(node.id));
  const output = String(config.output_node_id) === String(node.id);
  if (!bound && !output) return;

  const titleHeight = globalThis.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
  const width = bound && output ? 34 : 20;
  let right = 8;
  for (const button of node.title_buttons || []) {
    if (button.visible) right += button.getWidth(ctx) + 2;
  }
  const x = node.size[0] - width - right;
  const y = -titleHeight + (titleHeight - 18) / 2;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(19, 21, 27, 0.9)";
  ctx.strokeStyle = "rgba(255, 143, 190, 0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, width - 1, 17, 6);
  ctx.fill();
  ctx.stroke();

  const iconSize = 11;
  const gap = 2;
  const icons = [];
  if (bound) icons.push("phone");
  if (output) icons.push("target");
  const total = icons.length * iconSize + (icons.length - 1) * gap;
  let cursor = x + (width - total) / 2;
  const centerY = y + 9;
  ctx.strokeStyle = "#ffd7e7";
  ctx.fillStyle = "#ffd7e7";
  ctx.lineWidth = 1.1;
  ctx.lineCap = "round";
  for (const icon of icons) {
    const cx = cursor + iconSize / 2;
    if (icon === "phone") drawPhoneBadge(ctx, cx, centerY, iconSize);
    else drawTargetBadge(ctx, cx, centerY, iconSize);
    cursor += iconSize + gap;
  }
  ctx.restore();
}

const DOM_BADGE_SVG = {
  phone:
    '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#ffd7e7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2.4"/><path d="M10.5 5.6h3"/><path d="M12 18.2v.01"/></svg>',
  target:
    '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#ffd7e7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.4" fill="#ffd7e7" stroke="none"/><path d="M12 2.6v2.4M12 19v2.4M2.6 12h2.4M19 12h2.4"/></svg>',
};

function domBadgeState(nodeId) {
  const config = peekConfig(app.graph);
  if (!config) return null;
  const bound = config.slots.some((slot) => String(slot.node_id) === String(nodeId));
  const output = String(config.output_node_id) === String(nodeId);
  if (!bound && !output) return null;
  const titles = [];
  if (bound) titles.push("PocketNAI 槽位节点");
  if (output) titles.push("PocketNAI 主输出节点");
  return {
    key: `${bound ? 1 : 0}${output ? 1 : 0}`,
    html: `${bound ? DOM_BADGE_SVG.phone : ""}${output ? DOM_BADGE_SVG.target : ""}`,
    title: titles.join(" · "),
  };
}

function syncDomBadges() {
  domBadgeFrame = 0;
  for (const header of document.querySelectorAll('[data-testid^="node-header-"]')) {
    const nodeId = header.getAttribute("data-testid")?.slice("node-header-".length);
    if (!nodeId) continue;
    const state = domBadgeState(nodeId);
    let badge = header.querySelector(".pocket-node-badge");
    if (!state) {
      badge?.remove();
      continue;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "pocket-node-badge";
      badge.style.cssText =
        "display:inline-flex;align-items:center;justify-content:center;gap:2px;flex:0 0 auto;min-width:20px;height:18px;padding:0 4px;margin-left:2px;border:1px solid rgba(255,143,190,.45);border-radius:6px;background:rgba(19,21,27,.86);pointer-events:none;user-select:none;";
      (header.firstElementChild || header).appendChild(badge);
    }
    if (badge.dataset.pocketKey !== state.key) {
      badge.dataset.pocketKey = state.key;
      badge.innerHTML = state.html;
    }
    badge.title = state.title;
  }
}

function scheduleDomBadgeSync() {
  if (domBadgeFrame) return;
  domBadgeFrame = requestAnimationFrame(syncDomBadges);
}

function installDomBadgeObserver() {
  if (domBadgeObserver || !document.body) return;
  domBadgeObserver = new MutationObserver(scheduleDomBadgeSync);
  domBadgeObserver.observe(document.body, { childList: true, subtree: true });
  scheduleDomBadgeSync();
}

function hookSubgraphRemovals(root) {
  if (!root?.subgraphs || typeof root.subgraphs.values !== "function") return;
  for (const subgraph of root.subgraphs.values()) {
    if (!subgraph || subgraph.__pocketRemovalHooked) continue;
    subgraph.__pocketRemovalHooked = true;
    const originalNodeRemoved = subgraph.onNodeRemoved;
    subgraph.onNodeRemoved = function (node) {
      const result = originalNodeRemoved?.apply(this, arguments);
      scheduleSync(0);
      return result;
    };
  }
}

function hookGraph(graph) {
  if (!graph) return;
  hookSubgraphRemovals(graph);
  if (graph.__pocketHooked) return;
  graph.__pocketHooked = true;

  const originalNodeRemoved = graph.onNodeRemoved;
  graph.onNodeRemoved = function (node) {
    const result = originalNodeRemoved?.apply(this, arguments);
    if (this === app.graph) {
      commitConfig(this);
      scheduleSync(0);
    }
    return result;
  };

  const originalSerialize = graph.serialize;
  if (typeof originalSerialize === "function") {
    graph.serialize = function (...args) {
      commitConfig(this);
      const data = originalSerialize.apply(this, args);
      if (data && typeof data === "object") {
        if (!data.extra || typeof data.extra !== "object") data.extra = {};
        data.extra[CONFIG_KEY] = cloneJson(configOf(this));
      }
      if (!collectingPrompt) scheduleSync(600);
      return data;
    };
  }

  const originalOnSerialize = typeof graph.onSerialize === "function" ? graph.onSerialize : null;
  graph.onSerialize = function (data) {
    const result = originalOnSerialize?.apply(this, arguments);
    if (data && typeof data === "object") {
      if (!data.extra || typeof data.extra !== "object") data.extra = {};
      data.extra[CONFIG_KEY] = cloneJson(configOf(this));
    }
    return result;
  };
}

// ResolutionPreset 的 resolution_json 是 Aaalice 在 graphToPrompt 阶段注入的；
// 某些加载顺序下 PocketNAI 捕获到的原生函数可能绕过这层钩子。这里在提交模板前
// 按节点真实状态再写一次，既保证字段存在，也不受扩展加载顺序影响。
function ensureResolutionPromptInputs(apiPrompt, config) {
  for (const slot of config.slots || []) {
    if (slot.type !== "resolution") continue;
    const node = nodeById(slot.node_id);
    if (!isResolutionNode(node)) continue;
    const state = resolutionState(node);
    const promptNode = apiPrompt?.[String(slot.node_id)];
    if (!state || !promptNode || typeof promptNode !== "object") continue;
    if (!promptNode.inputs || typeof promptNode.inputs !== "object") promptNode.inputs = {};
    promptNode.inputs[RESOLUTION_FIELD] = JSON.stringify(resolutionPayload(state));
  }
}

async function postTemplate() {
  const graph = app.graph;
  if (!graph) return;
  hookGraph(graph);
  commitConfig(graph);

  collectingPrompt = true;
  let result;
  try {
    // 优先走公开的 app.graphToPrompt，让其他扩展的 Prompt 钩子（例如
    // Aaalice 的 resolution_json、模型专用输入）也进入模板；失败时退回原生。
    const promptFn = app.graphToPrompt?.bind(app) ?? nativeGraphToPrompt;
    if (!promptFn) throw new Error("ComfyUI 还没有准备好 graphToPrompt()");
    result = await promptFn(graph);
  } finally {
    collectingPrompt = false;
  }
  const apiPrompt = result?.output;
  if (!apiPrompt || typeof apiPrompt !== "object") {
    throw new Error("graphToPrompt() 没有返回 API Prompt");
  }
  const config = configOf(graph);
  ensureResolutionPromptInputs(apiPrompt, config);

  const response = await api.fetchApi(SYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_prompt: apiPrompt, pocket_config: config }),
  });
  if (!response.ok) {
    throw new Error(`模板同步失败（HTTP ${response.status}）`);
  }
}

async function syncNow() {
  if (syncInFlight) {
    syncDirty = true;
    return syncInFlight;
  }
  syncInFlight = (async () => {
    do {
      syncDirty = false;
      await postTemplate();
    } while (syncDirty);
  })();
  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

function scheduleSync(delay = 400) {
  if (collectingPrompt) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncNow().catch((error) => console.warn("[PocketNAI]", error));
  }, delay);
}

// Lora-Manager 的 LoraLoaderLM 同时维护两份真值：`loras` 数组与 `text` 纯文本。
// 文本里残留的 <lora:...> 标签会在下一次文本回调时被 mergeLoras 重新解析回数组，
// 于是移动端删掉的 LoRA 会「复活」。这里按最终列表重建文本，直接从源头切断旧标签。
function loraSyntaxOf(entry) {
  const strength = Number(entry?.strength);
  const clip = Number(entry?.clipStrength ?? entry?.strength);
  const model = Number.isFinite(strength) ? strength : 1;
  const clipValue = Number.isFinite(clip) ? clip : model;
  const format = (value) => String(Number(value.toFixed(4)));
  return model === clipValue
    ? `<lora:${entry.name}:${format(model)}>`
    : `<lora:${entry.name}:${format(model)}:${format(clipValue)}>`;
}

// Lora-Manager 的 text 控件是「DOM 自动补全」控件：真正的值来自内部 textarea.value。
// 这里刻意不写 `widget.value`：新前端的 value setter 会顺带触发 callback → mergeLoras，
// 而 mergeLoras 会丢弃不在文本里的条目，把刚静音的 LoRA 从 loras 数组里整条删掉。
// 只写 DOM 值并广播 UI 变更事件，既刷新界面又不触发合并。
function syncLoraTextWidget(node, entries) {
  const text = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.name && entry.active !== false)
    .map(loraSyntaxOf)
    .join(" ");
  const textWidget = node?.inputWidget
    || (node?.widgets || []).find((widget) => widget?.name === "text");
  if (!textWidget) return;

  const element = textWidget.inputEl;
  if (element && typeof element === "object" && "value" in element) {
    if (element.value === text) return;
    element.value = text;
    if (typeof element.dispatchEvent === "function" && typeof CustomEvent === "function") {
      element.dispatchEvent(
        new CustomEvent("lora-manager:autocomplete-value-changed", { detail: { value: text } }),
      );
    }
    // 老前端把文本存在普通属性上时同步兜底：临时摘掉 callback，避免赋值触发合并。
    if (textWidget.value !== text) {
      const callback = textWidget.callback;
      textWidget.callback = undefined;
      try {
        textWidget.value = text;
      } finally {
        textWidget.callback = callback;
      }
    }
    return;
  }

  // DOM 还没挂载：写到 LiteGraph 的待应用值，控件 onMounted 时会自行套用。
  textWidget._pendingValue = text;
  textWidget.onSetValue?.(text);
}

function applyListValue(node, widget, type, value) {
  const list = Array.isArray(value) ? value : [];
  if (type === "lm_loras") {
    const existing = Array.isArray(widget.value) ? widget.value : [];
    const merged = list
      .filter((entry) => entry && typeof entry.name === "string" && entry.name)
      .map((entry) => {
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

    // 1. 更新结构体数组控件（真正的执行数据源）。
    widget.value = merged;
    widget.callback?.(merged);

    // 2. 同步清洗并重构节点的 inputWidget / text 纯文本控件。
    syncLoraTextWidget(node, merged);
    return merged;
  }

  if (type === "pv_tiles") {
    const existing = vaultTiles(widget);
    const merged = list.map((tile) => {
      const old = existing.find((item) => item?.instance_id && item.instance_id === tile.instance_id);
      return old ? { ...old, ...tile } : tile;
    });
    const state = node._vaultState;
    if (state && typeof state.loadFromSerialized === "function") {
      state.loadFromSerialized(JSON.stringify(merged));
      return merged;
    }
    widget.value = JSON.stringify(merged);
    widget.callback?.(widget.value);
    return merged;
  }
  return list;
}

function setWidgetValue(widget, value) {
  if (!widget || widget.value === value) return false;
  widget.value = value;
  const element = widget.inputEl;
  if (
    element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement
  ) {
    element.value = String(value);
  }
  widget.callback?.(value);
  return true;
}

function applyResolutionValue(node, value) {
  if (!isResolutionNode(node)) return false;
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return false;
    }
  }
  if (!raw || typeof raw !== "object") return false;

  const presets = resolutionPresets(node);
  const current = resolutionState(node, presets);
  const aligned = {
    ...(current || {}),
    ...raw,
    version: 1,
  };
  const next = normalizeResolutionState(
    aligned,
    presets,
    resolutionAlignments(node),
    resolutionCanvasLimits(node),
  );
  if (!next) return false;
  if (current && JSON.stringify(current) === JSON.stringify(next)) return false;

  const control = node._aaaliceResolutionControl;
  if (typeof control?.setValue === "function") {
    try {
      control.setValue(next);
    } catch (error) {
      console.warn("[PocketNAI] 写入分辨率预设失败", error);
      return false;
    }
  } else {
    node.properties ||= {};
    node.properties[RESOLUTION_PROPERTY] = next;
  }
  node.graph?.setDirtyCanvas?.(true, true);
  return true;
}

function applyRemoteValue(nodeId, field, value) {
  const config = peekConfig(app.graph);
  if (!config) return false;
  const slot = config.slots.find(
    (entry) => String(entry.node_id) === String(nodeId) && entry.field === field,
  );
  if (!slot) return false;
  const node = nodeById(nodeId);
  if (!node) return false;
  // ResolutionPreset 没有真实控件，值必须回到 Aaalice 的属性状态机，
  // 由它同步按钮文字、画布框选与宽高输入框。
  if (slot.type === "resolution" && field === RESOLUTION_FIELD && isResolutionNode(node)) {
    return applyResolutionValue(node, value);
  }
  const widget = nodeWidget(node, field);
  if (!widget || isWidgetConnected(node, widget)) return false;
  const leaves = slotLeafTargets(node, widget);
  if (!leaves.length) return false;

  if (slot.type === "lm_loras" || slot.type === "pv_tiles") {
    let merged = Array.isArray(value) ? value : [];
    for (const leaf of leaves) {
      merged = applyListValue(leaf.node, leaf.widget, slot.type, merged);
    }
    const hasOuter = leaves.some((leaf) => leaf.node !== node);
    if (hasOuter) {
      if (slot.type === "pv_tiles") setWidgetValue(widget, JSON.stringify(merged));
      else if (widget.value !== merged) {
        widget.value = merged;
        widget.callback?.(merged);
      }
    }
    return true;
  }

  let changed = false;
  for (const leaf of leaves) {
    if (leaf.widget === widget) continue;
    if (setWidgetValue(leaf.widget, value)) changed = true;
  }
  if (setWidgetValue(widget, value)) changed = true;
  return changed;
}

function handleApplySlots(event) {
  const slots = event?.detail?.slots_data;
  if (!slots || typeof slots !== "object" || !app.graph) return;
  const graph = app.graph;
  graph.beforeChange?.();
  let changed = false;
  try {
    for (const [nodeId, fields] of Object.entries(slots)) {
      if (!fields || typeof fields !== "object") continue;
      for (const [field, value] of Object.entries(fields)) {
        if (applyRemoteValue(nodeId, field, value)) changed = true;
      }
    }
  } finally {
    graph.afterChange?.();
  }
  if (!changed) return;
  commitConfig(graph);
  graph.setDirtyCanvas?.(true, true);
  scheduleSync(120);
}

function installAppHooks() {
  if (typeof app.graphToPrompt === "function" && !nativeGraphToPrompt) {
    nativeGraphToPrompt = app.graphToPrompt.bind(app);
    // 原生默认参数是 this.rootGraph，老前端没有该属性时会把 undefined 传下去，
    // 这里统一兜底到 app.graph。
    app.graphToPrompt = async function (graph, ...args) {
      const target = graph ?? app.graph;
      commitConfig(target);
      const result = await nativeGraphToPrompt(target, ...args);
      if (!collectingPrompt) scheduleSync();
      return result;
    };
  }

  if (typeof app.queuePrompt === "function" && !nativeQueuePrompt) {
    nativeQueuePrompt = app.queuePrompt.bind(app);
    app.queuePrompt = async function (...args) {
      try {
        await syncNow();
      } catch (error) {
        console.warn("[PocketNAI] 队列前置同步失败", error);
      }
      return nativeQueuePrompt(...args);
    };
  }

  api.addEventListener("promptQueueing", () => scheduleSync(0));
  api.addEventListener("promptQueued", () => scheduleSync(800));
  // Lora-Manager 的「发送到工作流」会广播该事件并改写节点的 loras 控件，
  // 等它写完再同步模板，手机端就能拿到最新的挂载列表。
  api.addEventListener("lora_code_update", () => scheduleSync(300));
  // 手机端的编辑写回：直接改真实控件，再让正常同步把结果发回手机。
  api.addEventListener("pocket:apply_slots", handleApplySlots);
}

app.registerExtension({
  name: "ComfyUI.PocketNAI",

  async setup() {
    installAppHooks();
    hookGraph(app.graph);
    installDomBadgeObserver();
    setTimeout(() => {
      hookGraph(app.graph);
      scheduleDomBadgeSync();
      void syncNow().catch((error) => console.warn("[PocketNAI] 初始同步失败", error));
    }, 900);
  },

  async afterConfigureGraph() {
    hookGraph(app.graph);
    scheduleDomBadgeSync();
    scheduleSync(250);
  },

  getNodeMenuItems(node) {
    return nodeMenuItems(node);
  },

  async beforeRegisterNodeDef(nodeType) {
    const originalDraw = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      const result = originalDraw?.apply(this, arguments);
      drawBadge(this, ctx);
      return result;
    };
  },
});
