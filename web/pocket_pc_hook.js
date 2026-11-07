import { api } from "/scripts/api.js";
import { app } from "/scripts/app.js";

const VERSION = "2.1.0";
const CONFIG_KEY = "pocket_config";
const SYNC_URL = "/pocket/api/sync_template";
const WORKFLOWS_URL = "/pocket/api/workflows";
const DELETE_WORKFLOW_URL = "/pocket/api/workflows/delete";
const CONFIG_URL = "/pocket/api/config";
const DEFAULT_TITLE = "ComfyUI 工作流";
const OUTPUT_TYPES = new Set(["SaveImage", "PreviewImage"]);
const INTERNAL_WIDGETS = new Set(["control_after_generate", "control_before_generate"]);
const LORA_NODE_CLASS = "Lora Loader (LoraManager)";
const LORA_FIELD = "loras";
const VAULT_NODE_CLASS = "PromptVaultSelector";
const VAULT_FIELD = "selected_tiles_data";
const RESOLUTION_NODE_CLASS = "ResolutionPreset";
const RESOLUTION_FIELD = "resolution_json";
const RESOLUTION_PROPERTY = "resolutionPresetState";
const RESOLUTION_ALIGNMENTS = Object.freeze([8, 16, 32, 64]);
const RESOLUTION_CANVAS_LIMITS = Object.freeze([2048, 4096, 8192]);
const RESOLUTION_MIN = 16;
const RESOLUTION_MAX = 16384;

let nativeGraphToPrompt = null;
let syncInFlight = null;
let collectingPrompt = false;
let domBadgeObserver = null;
let domBadgeFrame = 0;
let sidebarRefreshHandler = null;

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

function resolutionWidget(node) {
  const state = resolutionState(node);
  if (!state) return null;
  return { name: RESOLUTION_FIELD, type: "resolution", value: state, options: { serialize: false } };
}

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

function vaultTiles(widget) {
  if (!widget) return [];
  let raw = widget.value;
  if (typeof widget.serializeValue === "function") {
    try {
      const serialized = widget.serializeValue();
      if (typeof serialized === "string") raw = serialized;
    } catch { }
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
}

function setOutputNode(node) {
  const config = configOf(app.graph);
  config.output_node_id = String(node.id);
  config.output_node_title = String(node.title || node.type || "输出节点");
  commitConfig(app.graph);
  app.graph.setDirtyCanvas?.(true, true);
}

function clearOutputNode() {
  const config = configOf(app.graph);
  config.output_node_id = null;
  config.output_node_title = null;
  commitConfig(app.graph);
  app.graph.setDirtyCanvas?.(true, true);
}

function isOutputNode(node) {
  return OUTPUT_TYPES.has(node.comfyClass) || OUTPUT_TYPES.has(node.type);
}

function nodeMenuItems(node) {
  const config = peekConfig(app.graph);
  const slots = (config?.slots || []).filter((slot) => String(slot.node_id) === String(node.id));
  const submenu = [];
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

function hookGraph(graph) {
  if (!graph) return;
  if (graph.__pocketHooked) return;
  graph.__pocketHooked = true;

  const originalNodeRemoved = graph.onNodeRemoved;
  graph.onNodeRemoved = function (node) {
    const result = originalNodeRemoved?.apply(this, arguments);
    if (this === app.graph) {
      commitConfig(this);
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

async function postTemplate(customTitle = null) {
  const graph = app.graph;
  if (!graph) throw new Error("画布尚未就绪");
  hookGraph(graph);
  const config = commitConfig(graph);
  if (customTitle) {
    config.display_title = customTitle;
  }

  collectingPrompt = true;
  let result;
  try {
    const promptFn = app.graphToPrompt?.bind(app) ?? nativeGraphToPrompt;
    if (!promptFn) throw new Error("ComfyUI 尚未准备好 graphToPrompt()");
    result = await promptFn(graph);
  } finally {
    collectingPrompt = false;
  }
  const apiPrompt = result?.output;
  if (!apiPrompt || typeof apiPrompt !== "object") {
    throw new Error("graphToPrompt() 未返回有效 API Prompt");
  }
  ensureResolutionPromptInputs(apiPrompt, config);

  const response = await api.fetchApi(SYNC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_prompt: apiPrompt, pocket_config: config }),
  });
  if (!response.ok) {
    throw new Error(`模板推送失败（HTTP ${response.status}）`);
  }
  return await response.json();
}

async function syncNow(customTitle = null) {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    return await postTemplate(customTitle);
  })();
  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

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

    widget.value = merged;
    widget.callback?.(merged);
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

async function pullMobileSlotsToCanvas() {
  const response = await api.fetchApi(CONFIG_URL);
  if (!response.ok) throw new Error("无法读取服务端配置");
  const data = await response.json();
  const config = data?.config;
  if (!config || !Array.isArray(config.slots)) {
    throw new Error("服务端暂无有效槽位数据");
  }

  const graph = app.graph;
  if (!graph) return 0;
  graph.beforeChange?.();
  let appliedCount = 0;
  try {
    for (const slot of config.slots) {
      if (["prompt", "negative", "pv_tiles"].includes(slot.type)) continue;
      const targetVal = slot.default_val;
      if (targetVal !== undefined && applyRemoteValue(slot.node_id, slot.field, targetVal)) {
        appliedCount += 1;
      }
    }
  } finally {
    graph.afterChange?.();
  }
  commitConfig(graph);
  graph.setDirtyCanvas?.(true, true);
  return appliedCount;
}

function formatRelativeTime(dateString) {
  if (!dateString) return "";
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function registerSidebarTab() {
  if (!app.extensionManager?.registerSidebarTab) return;

  app.extensionManager.registerSidebarTab({
    id: "pocketnai-sidebar",
    icon: "pi pi-mobile",
    title: "PocketNAI",
    tooltip: "PocketNAI 移动端协同管理",
    type: "custom",
    render: (container) => {
      container.innerHTML = `
        <div class="pocket-sidebar-root" style="display:flex;flex-direction:column;gap:14px;padding:14px;color:var(--fg-color,#ddd);font-size:13px;height:100%;overflow-y:auto;box-sizing:border-box;">
          <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:10px;">
            <div style="font-weight:700;font-size:14px;display:flex;align-items:center;gap:6px;">
              <span>📱</span> PocketNAI
            </div>
            <span style="font-size:11px;opacity:0.6;">v${VERSION}</span>
          </div>

          <div style="display:flex;flex-direction:column;gap:8px;">
            <button id="pocket-btn-push-main" style="display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 14px;border:none;border-radius:8px;background:linear-gradient(135deg,#ff8fbe,#b496ff);color:#101218;font-weight:700;font-size:13px;cursor:pointer;transition:opacity 0.2s;">
              <span>📱</span> 推送当前工作流至手机
            </button>
            <button id="pocket-btn-pull-slots" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:8px 12px;border:1px solid rgba(255,255,255,0.12);border-radius:8px;background:rgba(255,255,255,0.04);color:var(--fg-color,#ddd);font-size:12px;cursor:pointer;">
              <span>📥</span> 拉取手机端副本参数至画布
            </button>
          </div>

          <div id="pocket-msg-banner" style="display:none;padding:8px 10px;border-radius:6px;font-size:12px;word-break:break-word;"></div>

          <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px;">
            <span style="font-weight:600;font-size:12px;opacity:0.8;">已推送模板副本</span>
            <button id="pocket-btn-refresh-list" style="background:none;border:none;color:var(--fg-color,#aaa);cursor:pointer;font-size:13px;padding:2px 4px;" title="刷新列表">🔄</button>
          </div>

          <div id="pocket-workflows-container" style="display:flex;flex-direction:column;gap:8px;min-height:80px;">
            <div style="opacity:0.5;text-align:center;padding:16px 0;font-size:12px;">加载模板列表中…</div>
          </div>
        </div>
      `;

      const pushMainBtn = container.querySelector("#pocket-btn-push-main");
      const pullSlotsBtn = container.querySelector("#pocket-btn-pull-slots");
      const refreshListBtn = container.querySelector("#pocket-btn-refresh-list");
      const banner = container.querySelector("#pocket-msg-banner");
      const workflowsList = container.querySelector("#pocket-workflows-container");

      const showNotice = (msg, isError = false) => {
        banner.style.display = "block";
        banner.style.background = isError ? "rgba(255,80,80,0.15)" : "rgba(80,220,120,0.15)";
        banner.style.border = isError ? "1px solid rgba(255,80,80,0.3)" : "1px solid rgba(80,220,120,0.3)";
        banner.style.color = isError ? "#ff8080" : "#70e090";
        banner.textContent = msg;
        setTimeout(() => {
          banner.style.display = "none";
        }, 4000);
      };

      const loadWorkflowsList = async () => {
        try {
          const res = await api.fetchApi(WORKFLOWS_URL);
          if (!res.ok) throw new Error("无法加载工作流");
          const data = await res.json();
          const items = Array.isArray(data.workflows) ? data.workflows : [];
          const activeId = data.active_id;

          if (!items.length) {
            workflowsList.innerHTML = `
              <div style="opacity:0.5;text-align:center;padding:20px 0;font-size:12px;line-height:1.5;">
                尚未推送任何模板<br>点击上方按钮即可推送
              </div>
            `;
            return;
          }

          workflowsList.innerHTML = items.map((item) => {
            const isActive = item.id === activeId;
            return `
              <div class="pocket-wf-card" data-id="${item.id}" style="display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:8px;border:1px solid ${isActive ? "rgba(255,143,190,0.4)" : "rgba(255,255,255,0.08)"};background:${isActive ? "rgba(255,143,190,0.08)" : "rgba(255,255,255,0.03)"};">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
                  <strong style="font-size:13px;word-break:break-all;color:${isActive ? "#ff9fc4" : "inherit"};">${item.title}</strong>
                  ${isActive ? '<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(255,143,190,0.2);color:#ff8fbe;white-space:nowrap;">活动中</span>' : ""}
                </div>
                <div style="font-size:11px;opacity:0.6;display:flex;align-items:center;justify-content:space-between;">
                  <span>${item.slots_count} 个槽位</span>
                  <span>${formatRelativeTime(item.updated_at)}</span>
                </div>
                <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:4px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.05);">
                  <button class="pocket-btn-repush" data-title="${item.title}" style="background:none;border:1px solid rgba(255,255,255,0.15);border-radius:4px;color:var(--fg-color,#ccc);font-size:11px;padding:3px 8px;cursor:pointer;">覆盖推送</button>
                  <button class="pocket-btn-del" data-id="${item.id}" data-title="${item.title}" style="background:none;border:1px solid rgba(255,80,80,0.25);border-radius:4px;color:#ff8080;font-size:11px;padding:3px 8px;cursor:pointer;">删除</button>
                </div>
              </div>
            `;
          }).join("");

          workflowsList.querySelectorAll(".pocket-btn-repush").forEach((btn) => {
            btn.onclick = async () => {
              const targetTitle = btn.getAttribute("data-title");
              if (!confirm(`确定用当前画布覆盖推送至「${targetTitle}」？`)) return;
              btn.disabled = true;
              try {
                await syncNow(targetTitle);
                showNotice(`已成功覆盖推送至「${targetTitle}」`);
                await loadWorkflowsList();
              } catch (err) {
                showNotice(`覆盖失败: ${err.message}`, true);
              } finally {
                btn.disabled = false;
              }
            };
          });

          workflowsList.querySelectorAll(".pocket-btn-del").forEach((btn) => {
            btn.onclick = async () => {
              const targetId = btn.getAttribute("data-id");
              const targetTitle = btn.getAttribute("data-title");
              if (!confirm(`确定在服务端删除工作流「${targetTitle}」吗？`)) return;
              btn.disabled = true;
              try {
                const res = await api.fetchApi(DELETE_WORKFLOW_URL, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ id: targetId }),
                });
                if (!res.ok) throw new Error("删除请求失败");
                showNotice(`已删除「${targetTitle}」`);
                await loadWorkflowsList();
              } catch (err) {
                showNotice(`删除失败: ${err.message}`, true);
              } finally {
                btn.disabled = false;
              }
            };
          });
        } catch (err) {
          workflowsList.innerHTML = `<div style="color:#ff8080;text-align:center;padding:10px 0;font-size:12px;">加载失败: ${err.message}</div>`;
        }
      };

      sidebarRefreshHandler = loadWorkflowsList;

      pushMainBtn.onclick = async () => {
        pushMainBtn.disabled = true;
        pushMainBtn.style.opacity = "0.6";
        try {
          const res = await syncNow();
          showNotice(`已推送「${res.title}」（${res.slots} 个槽位）`);
          await loadWorkflowsList();
        } catch (err) {
          showNotice(`推送失败: ${err.message}`, true);
        } finally {
          pushMainBtn.disabled = false;
          pushMainBtn.style.opacity = "1";
        }
      };

      pullSlotsBtn.onclick = async () => {
        pullSlotsBtn.disabled = true;
        try {
          const count = await pullMobileSlotsToCanvas();
          showNotice(`已将手机端 ${count} 个参数更新至画布`);
        } catch (err) {
          showNotice(`拉取参数失败: ${err.message}`, true);
        } finally {
          pullSlotsBtn.disabled = false;
        }
      };

      refreshListBtn.onclick = () => {
        void loadWorkflowsList();
      };

      void loadWorkflowsList();
    },
  });
}

function installAppHooks() {
  if (typeof app.graphToPrompt === "function" && !nativeGraphToPrompt) {
    nativeGraphToPrompt = app.graphToPrompt.bind(app);
    app.graphToPrompt = async function (graph, ...args) {
      const target = graph ?? app.graph;
      commitConfig(target);
      return await nativeGraphToPrompt(target, ...args);
    };
  }
}

app.registerExtension({
  name: "ComfyUI.PocketNAI",

  async setup() {
    installAppHooks();
    hookGraph(app.graph);
    installDomBadgeObserver();
    registerSidebarTab();

    setTimeout(() => {
      hookGraph(app.graph);
      scheduleDomBadgeSync();
    }, 900);
  },

  async afterConfigureGraph() {
    hookGraph(app.graph);
    scheduleDomBadgeSync();
    if (sidebarRefreshHandler) {
      void sidebarRefreshHandler();
    }
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