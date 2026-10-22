<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, shallowRef, watch } from "vue";
import TagTextarea from "./TagTextarea.vue";
import ActiveLoraTray from "./components/ActiveLoraTray.vue";
import AppIcon from "./components/AppIcon.vue";
import PromptToolbar from "./components/PromptToolbar.vue";
import PromptVaultSheet from "./components/PromptVaultSheet.vue";
import WorkflowSwitcher from "./components/WorkflowSwitcher.vue";
import {
  ApiError,
  applySlots,
  buildImageUrl,
  cancelPrompt,
  clientId,
  executePrompt,
  fetchWorkflows,
  getConfig,
  getIntegrations,
  imageFromOutput,
  MAX_SEED,
  randomSeed,
  switchWorkflow,
} from "./api.js";
import { readLoraList } from "./integrations/loraManager.js";
import {
  TILE_WEIGHT_STEP,
  clampTileWeight,
  entryText,
  fetchVaultLibrary,
  formatPromptWeight,
  groupEntries,
  readTileList,
  readVaultCache,
  tileFromEntry,
  writeVaultCache,
} from "./integrations/promptVault.js";
import { fetchTags, readTagCache, writeTagCache } from "./tags.js";

const LAST_IMAGE_KEY = "suski-pna-last-image";
const PROMPT_TYPES = new Set(["prompt", "negative"]);
const LIST_TYPES = new Set(["lm_loras", "pv_tiles"]);
const GENERIC_LABELS = new Set(["值", "value", "文本", "text", "字符串", "string"]);
const WRITE_DELAY = 450;

const tags = shallowRef([]);
const workflowList = shallowRef([]);
const loraTrayRefs = new Map();
const values = reactive({});
const dirtyKeys = new Set();
const promptRefs = new Map();
const listRemovals = new Map();
const writeTimers = new Map();
const writeInFlight = new Map();
const writePending = new Set();
let lastWriteErrorAt = 0;
const state = reactive({
  config: null,
  hasTemplate: false,
  loading: true,
  updatedAt: null,
  connection: "connecting",
  generating: false,
  stopping: false,
  progress: null,
  currentNode: null,
  error: "",
  toast: null,
  drawer: false,
  canInstall: false,
  image: null,
  imageError: false,
  tagsStatus: "loading",
  advancedOpen: false,
  integrations: { prompt_vault: false },
  vault: null,
  vaultStatus: "idle",
  vaultSheet: false,
  vaultTarget: null,
  workflowDrawer: false,
  workflowLoading: false,
  workflowError: "",
  workflowActiveId: "",
  workflowBusyId: "",
});

let configInFlight = null;
let lastConfigAt = 0;
let configTimer = null;
let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let unmounted = false;
let toastTimer = null;
let run = null;
let installPrompt = null;

const slots = computed(() => state.config?.slots || []);
const promptSlots = computed(() => slots.value.filter((slot) => PROMPT_TYPES.has(slot.type)));
const loraSlots = computed(() => slots.value.filter((slot) => slot.type === "lm_loras"));
const tileSlots = computed(() => slots.value.filter((slot) => slot.type === "pv_tiles"));
const advancedSlots = computed(() =>
  slots.value.filter((slot) => !PROMPT_TYPES.has(slot.type) && !LIST_TYPES.has(slot.type)),
);
const title = computed(() => state.config?.display_title || "PocketNAI");
const pageHost = computed(() => location.host);
const outputNodeId = computed(() => state.config?.output_node_id || null);
const hasOutput = computed(() => Boolean(outputNodeId.value));
const progressPercent = computed(() => {
  const progress = state.progress;
  if (!progress?.max) return 0;
  return Math.min(100, Math.max(0, Math.round((progress.value / progress.max) * 100)));
});
const progressIndeterminate = computed(() => state.generating && !state.progress?.max);
const progressLabel = computed(() => {
  if (!state.generating) return "";
  if (state.progress?.max) return `${state.currentNode || "采样"} · ${progressPercent.value}%`;
  return state.currentNode || "等待执行";
});
const connectionLabel = computed(() => {
  if (state.connection === "online") return "已联";
  if (state.connection === "connecting") return "连接中";
  return "离线";
});
const tagStatusLabel = computed(
  () =>
    ({
      loading: "词库加载中",
      ready: "词库就绪",
      cached: "本地词库",
      empty: "词库为空",
      error: "词库不可用",
    })[state.tagsStatus] || "词库",
);
const templateMeta = computed(() => {
  if (!state.config) return "";
  const count = slots.value.length;
  return count ? `${count} 个槽位` : "无槽位";
});

function slotKey(slot) {
  return `${slot.node_id}::${slot.field}`;
}

function elementId(slot) {
  return `slot-${String(slot.node_id).replaceAll(/[^a-zA-Z0-9_-]/g, "-")}-${String(slot.field).replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function defaultValue(slot) {
  let value = slot.default_val;
  if (slot.type === "toggle") return Boolean(value);
  if (slot.type === "lm_loras") return readLoraList(slot);
  if (slot.type === "pv_tiles") return readTileList(slot);
  if (["seed", "slider", "number"].includes(slot.type)) return value ?? 0;
  if (slot.type === "combo" && Array.isArray(slot.options) && slot.options.length) {
    const match = slot.options.find((option) => String(option) === String(value));
    if (match !== undefined) return match;
    return slot.options[0];
  }
  return value ?? "";
}

function slotByKey(key) {
  return slots.value.find((slot) => slotKey(slot) === key) || null;
}

function listIdentity(type, entry) {
  if (!entry || typeof entry !== "object") return "";
  if (type === "lm_loras") return String(entry.name || "");
  return String(entry.ref_preset_id || entry.instance_id || "");
}

function listComparable(type, entry) {
  if (type === "lm_loras") {
    return [
      entry.name,
      Number(entry.strength),
      Number(entry.clipStrength ?? entry.strength),
      entry.active !== false,
    ];
  }
  return [
    entry.instance_id || "",
    entry.ref_preset_id || null,
    String(entry.prompt ?? ""),
    Number(entry.weight ?? 1),
    entry.enabled !== false,
  ];
}

function listEquivalent(type, left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return JSON.stringify(left.map((entry) => listComparable(type, entry)))
    === JSON.stringify(right.map((entry) => listComparable(type, entry)));
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function trackListRemovals(slot, previous, next) {
  if (!LIST_TYPES.has(slot.type) || !Array.isArray(previous) || !Array.isArray(next)) return;
  const key = slotKey(slot);
  const previousIds = new Set(previous.map((entry) => listIdentity(slot.type, entry)).filter(Boolean));
  const nextIds = new Set(next.map((entry) => listIdentity(slot.type, entry)).filter(Boolean));
  let removed = listRemovals.get(key);
  if (!removed) {
    removed = new Set();
    listRemovals.set(key, removed);
  }
  for (const id of previousIds) {
    if (!nextIds.has(id)) removed.add(id);
  }
  for (const id of nextIds) removed.delete(id);
  if (!removed.size) listRemovals.delete(key);
}

function mergeListValue(slot, incoming, previousRaw) {
  const key = slotKey(slot);
  const type = slot.type;
  const removed = listRemovals.get(key) || new Set();
  let previous = [];
  if (previousRaw) {
    try {
      previous = JSON.parse(previousRaw) || [];
    } catch {
      previous = [];
    }
  }
  const previousIds = new Set(previous.map((entry) => listIdentity(type, entry)).filter(Boolean));
  const incomingIds = new Set(incoming.map((entry) => listIdentity(type, entry)).filter(Boolean));
  for (const id of [...removed]) {
    // PC 已经删掉，或者是在删除后重新加回来的，都解除挂起。
    if (!incomingIds.has(id) || !previousIds.has(id)) removed.delete(id);
  }
  if (removed.size) listRemovals.set(key, removed);
  else listRemovals.delete(key);

  const local = Array.isArray(values[key]) ? values[key] : [];
  const localIds = new Set(local.map((entry) => listIdentity(type, entry)).filter(Boolean));
  const merged = local.map((entry) => ({ ...entry }));
  for (const entry of incoming) {
    const id = listIdentity(type, entry);
    if (!id || removed.has(id) || localIds.has(id)) continue;
    merged.push({ ...entry });
    localIds.add(id);
  }
  return merged;
}

function applyConfig(config, { reset = false } = {}) {
  // 结构变化只重置新增、改类型或消失的槽位；正在编辑的值不会被模板同步打断。
  // 切换工作流时 reset=true：即便节点 id 与槽位名完全相同，也强制回到新模板的默认值。
  const previousTypes = new Map((state.config?.slots || []).map((slot) => [slotKey(slot), slot.type]));
  const previousDefaults = new Map(
    (state.config?.slots || []).map((slot) => [slotKey(slot), JSON.stringify(slot.default_val ?? null)]),
  );

  if (reset) {
    dirtyKeys.clear();
    listRemovals.clear();
    writePending.clear();
    for (const timer of writeTimers.values()) clearTimeout(timer);
    writeTimers.clear();
    for (const key of Object.keys(values)) delete values[key];
  }

  const keys = new Set();
  for (const slot of config.slots || []) {
    const key = slotKey(slot);
    keys.add(key);
    const incoming = defaultValue(slot);
    const pendingWrite = writeTimers.has(key) || writeInFlight.has(key);
    if (previousTypes.get(key) !== slot.type || !(key in values)) {
      dirtyKeys.delete(key);
      listRemovals.delete(key);
      values[key] = incoming;
      continue;
    }
    if (LIST_TYPES.has(slot.type)) {
      const dirty = dirtyKeys.has(key) || pendingWrite || (listRemovals.get(key)?.size ?? 0) > 0;
      if (!dirty) {
        if (!listEquivalent(slot.type, values[key], incoming)) values[key] = incoming;
        dirtyKeys.delete(key);
        continue;
      }
      const merged = mergeListValue(slot, incoming, previousDefaults.get(key));
      if (!listEquivalent(slot.type, values[key], merged)) values[key] = merged;
      if (!(listRemovals.get(key)?.size) && listEquivalent(slot.type, merged, incoming)) {
        dirtyKeys.delete(key);
      } else {
        dirtyKeys.add(key);
      }
      continue;
    }
    if (dirtyKeys.has(key) || pendingWrite) {
      if (valuesEqual(values[key], incoming)) dirtyKeys.delete(key);
    } else {
      values[key] = incoming;
    }
  }
  for (const key of Object.keys(values)) {
    if (keys.has(key)) continue;
    delete values[key];
    dirtyKeys.delete(key);
    listRemovals.delete(key);
    clearTimeout(writeTimers.get(key));
    writeTimers.delete(key);
  }

  state.config = config;
  state.hasTemplate = true;
  document.title = `${config.display_title || "PocketNAI"} · PocketNAI`;
}

function clearTemplate() {
  state.config = null;
  state.hasTemplate = false;
  state.updatedAt = null;
  dirtyKeys.clear();
  listRemovals.clear();
  writePending.clear();
  for (const timer of writeTimers.values()) clearTimeout(timer);
  writeTimers.clear();
  for (const key of Object.keys(values)) delete values[key];
  document.title = "PocketNAI";
}

function setValue(key, value) {
  const slot = slotByKey(key);
  const previous = values[key];
  values[key] = value;
  dirtyKeys.add(key);
  if (!slot) return;
  trackListRemovals(slot, previous, value);
  queueSlotWrite(slot);
}

function isWritableValue(slot, value) {
  if (slot.type === "lm_loras" || slot.type === "pv_tiles") return Array.isArray(value);
  if (["seed", "slider", "number"].includes(slot.type)) {
    if (value === "" || value === null || value === undefined) return false;
    return Number.isFinite(Number(value));
  }
  if (slot.type === "toggle") return typeof value === "boolean";
  if (slot.type === "combo") return value !== undefined && value !== null;
  return typeof value === "string" || typeof value === "number";
}

function queueSlotWrite(slot) {
  if (!slot || !state.hasTemplate) return;
  const key = slotKey(slot);
  clearTimeout(writeTimers.get(key));
  writeTimers.set(key, setTimeout(() => {
    writeTimers.delete(key);
    void flushSlotWrite(key);
  }, WRITE_DELAY));
}

function handleWriteError(error) {
  if (Date.now() - lastWriteErrorAt < 5000) return;
  lastWriteErrorAt = Date.now();
  let detail = error?.message || "未知错误";
  if (error instanceof ApiError && error.payload?.error) {
    detail = [error.payload.error.message, error.payload.error.details].filter(Boolean).join("：");
  }
  showToast(`工作流同步失败：${detail}`, "error");
}

async function flushSlotWrite(key) {
  const existing = writeInFlight.get(key);
  if (existing) {
    writePending.add(key);
    return existing.then(() => {
      if (writePending.has(key) && !writeInFlight.has(key)) return flushSlotWrite(key);
      return undefined;
    });
  }
  const task = (async () => {
    try {
      do {
        writePending.delete(key);
        const slot = slotByKey(key);
        if (!slot) break;
        const value = values[key];
        if (!isWritableValue(slot, value)) break;
        const result = await applySlots({ [slot.node_id]: { [slot.field]: value } });
        if (result?.updated_at) state.updatedAt = result.updated_at;
      } while (writePending.has(key));
    } catch (error) {
      handleWriteError(error);
    } finally {
      writeInFlight.delete(key);
    }
  })();
  writeInFlight.set(key, task);
  return task;
}

async function flushPendingWrites() {
  for (const [key, timer] of writeTimers) {
    clearTimeout(timer);
    writeTimers.delete(key);
    writePending.add(key);
  }
  const keys = new Set([...writePending, ...writeInFlight.keys()]);
  await Promise.all([...keys].map((key) => flushSlotWrite(key)));
}

function onNumberInput(slot, event) {
  const raw = event.target.value;
  const key = slotKey(slot);
  if (raw === "") {
    setValue(key, "");
    return;
  }
  const parsed = slot.value_kind === "float" ? Number.parseFloat(raw) : Number.parseInt(raw, 10);
  setValue(key, Number.isFinite(parsed) ? parsed : raw);
}

function onNumberBlur(slot) {
  const key = slotKey(slot);
  const value = values[key];
  const parsed = slot.value_kind === "float" ? Number.parseFloat(value) : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    setValue(key, defaultValue(slot));
  } else if (parsed !== value) {
    setValue(key, parsed);
  }
}

function onRangeInput(slot, event) {
  const parsed = Number.parseFloat(event.target.value);
  setValue(slotKey(slot), Number.isFinite(parsed) ? parsed : defaultValue(slot));
}

function onToggle(slot, event) {
  setValue(slotKey(slot), event.target.checked);
}

function onCombo(slot, event) {
  const raw = event.target.value;
  const option = (slot.options || []).find((value) => String(value) === String(raw));
  setValue(slotKey(slot), option !== undefined ? option : raw);
}

function randomizeSeed(slot) {
  setValue(slotKey(slot), randomSeed());
}

function resetTemplateValues() {
  listRemovals.clear();
  for (const slot of slots.value) {
    const key = slotKey(slot);
    values[key] = defaultValue(slot);
    dirtyKeys.add(key);
    queueSlotWrite(slot);
  }
  showToast("已恢复模板默认值");
}

function typeLabel(type) {
  return (
    {
      prompt: "正面",
      negative: "负面",
      text: "文本",
      seed: "种子",
      slider: "滑杆",
      number: "数值",
      toggle: "开关",
      combo: "选项",
      lm_loras: "LoRA",
      pv_tiles: "磁贴",
    }[type] || "参数"
  );
}

function placeholderFor(slot) {
  if (slot.type === "prompt") return "1girl, solo, silver hair, cat ears...";
  if (slot.type === "negative") return "lowres, bad anatomy, blurry...";
  return slotLabel(slot);
}

function numberValue(slot) {
  const value = Number(values[slotKey(slot)]);
  return Number.isFinite(value) ? value : Number(slot.default_val) || 0;
}

function stepFor(slot) {
  if (typeof slot.step === "number") return slot.step;
  return slot.value_kind === "float" ? 0.1 : 1;
}

function slotLabel(slot) {
  const label = String(slot?.label || "").trim();
  const nodeTitle = String(slot?.node_title || "").trim();
  const generic = !label
    || label === slot?.field
    || GENERIC_LABELS.has(label)
    || GENERIC_LABELS.has(label.toLowerCase());
  if (!generic) return label;
  if (slot?.type === "negative" || /负面|negative/i.test(nodeTitle)) return "负面提示词";
  if (slot?.type === "prompt" || /正面|positive/i.test(nodeTitle)) return "正面提示词";
  if (nodeTitle && !/^clip\s*text\s*encode/i.test(nodeTitle)) return nodeTitle;
  return label || slot?.field || "";
}

function collectSlots() {
  const data = {};
  for (const slot of slots.value) {
    let value = values[slotKey(slot)];
    if (value === undefined || value === null) value = defaultValue(slot);
    if (slot.type === "lm_loras") {
      value = (Array.isArray(value) ? value : []).map((entry) => ({
        name: entry.name,
        strength: Number(entry.strength),
        clipStrength: Number(entry.clipStrength ?? entry.strength),
        active: Boolean(entry.active),
      }));
    } else if (slot.type === "pv_tiles") {
      value = Array.isArray(value) ? value : [];
    } else if (["seed", "slider", "number"].includes(slot.type)) {
      const parsed = slot.value_kind === "float" ? Number.parseFloat(value) : Number.parseInt(value, 10);
      value = Number.isFinite(parsed) ? parsed : defaultValue(slot);
    } else if (slot.type === "toggle") {
      value = Boolean(value);
    } else if (!["combo"].includes(slot.type)) {
      value = String(value ?? "");
    }
    data[slot.node_id] = data[slot.node_id] || {};
    data[slot.node_id][slot.field] = value;
  }
  return data;
}

function formatError(error) {
  if (error instanceof TypeError) return "无法连接 ComfyUI，请检查地址与局域网连接。";
  if (error instanceof ApiError && error.payload && typeof error.payload === "object") {
    const payload = error.payload;
    const primary = payload.error;
    const parts = [];
    if (primary?.message) parts.push(primary.message);
    if (primary?.details) parts.push(String(primary.details));
    const nodeErrors = payload.node_errors || {};
    for (const [nodeId, nodeError] of Object.entries(nodeErrors).slice(0, 3)) {
      const first = nodeError?.errors?.[0];
      if (first?.message) parts.push(`节点 ${nodeId}：${first.message}${first.details ? `（${first.details}）` : ""}`);
    }
    if (parts.length) return parts.join("\n");
    return `请求失败（HTTP ${error.status}）`;
  }
  return error?.message || "请求失败，请检查 ComfyUI 是否在线";
}

async function loadConfig({ quiet = false, reset = false } = {}) {
  // 切换工作流必须读到切换之后的状态：先等在途请求结束，再发一次新的读取。
  while (configInFlight && reset) {
    try {
      await configInFlight;
    } catch {
      // 在途请求的失败由它自己的 catch 处理。
    }
  }
  if (configInFlight) return configInFlight;
  configInFlight = (async () => {
    try {
      const data = await getConfig();
      if (data?.has_template && data.config) {
        applyConfig(data.config, { reset });
        state.updatedAt = data.updated_at || null;
        if (!quiet) state.error = "";
      } else {
        clearTemplate();
        if (!quiet) state.error = "";
      }
    } catch (error) {
      if (!quiet || !state.hasTemplate) state.error = formatError(error);
    } finally {
      state.loading = false;
      lastConfigAt = Date.now();
      configInFlight = null;
    }
  })();
  return configInFlight;
}

function scheduleConfigLoad() {
  clearTimeout(configTimer);
  configTimer = setTimeout(() => void loadConfig({ quiet: true }), 250);
}

async function refreshTemplate(manual = false) {
  await loadConfig({ quiet: !manual });
  if (manual) {
    if (state.hasTemplate) showToast("模板已刷新");
    else showToast("还没有检测到模板", "error");
  }
}

async function loadTags() {
  state.tagsStatus = "loading";
  const cached = await readTagCache();
  if (cached) {
    tags.value = cached.rows;
    state.tagsStatus = "cached";
  }
  try {
    const rows = await fetchTags();
    if (rows.length) {
      tags.value = rows;
      state.tagsStatus = "ready";
      void writeTagCache(rows);
    } else if (!cached) {
      state.tagsStatus = "empty";
    }
  } catch {
    if (!cached) state.tagsStatus = "error";
  }
}

async function loadIntegrations() {
  try {
    const data = await getIntegrations();
    state.integrations = { prompt_vault: Boolean(data?.prompt_vault) };
  } catch {
    // 探测失败就当作插件不可用，原生槽位照常工作。
  }
  if (state.integrations.prompt_vault) void loadVault();
}

async function loadVault() {
  state.vaultStatus = "loading";
  const cached = await readVaultCache();
  if (cached) {
    state.vault = cached;
    state.vaultStatus = "cached";
  }
  try {
    const library = await fetchVaultLibrary();
    state.vault = library;
    state.vaultStatus = "ready";
    void writeVaultCache(library);
  } catch {
    if (!cached) state.vaultStatus = "error";
  }
}

function setPromptRef(key, element) {
  if (element) promptRefs.set(key, element);
  else promptRefs.delete(key);
}

function appendSnippet(current, snippet) {
  const base = String(current ?? "").trim();
  if (!base) return snippet;
  return /[\s,([:]$/.test(base) ? `${base} ${snippet}` : `${base}, ${snippet}`;
}

function insertSnippet(key, snippet, options) {
  const textarea = promptRefs.get(key);
  if (textarea?.insertAtCursor) {
    textarea.insertAtCursor(snippet, options);
    return;
  }
  setValue(key, appendSnippet(values[key], snippet));
}

function openVaultForText(slot) {
  state.vaultTarget = { key: slotKey(slot), mode: "text" };
  state.vaultSheet = true;
}

function openVaultForTiles(slot) {
  state.vaultTarget = { key: slotKey(slot), mode: "tiles" };
  state.vaultSheet = true;
}

function closeVaultSheet() {
  state.vaultSheet = false;
  state.vaultTarget = null;
}

function addVaultTile(key, entry) {
  const current = Array.isArray(values[key]) ? values[key] : [];
  if (entry.id && current.some((tile) => tile.ref_preset_id === entry.id)) {
    showToast("这条预设已经在磁贴里了");
    return false;
  }
  setValue(key, [...current, tileFromEntry(entry, state.vault)]);
  return true;
}

function handleVaultInsert(entry) {
  const target = state.vaultTarget;
  const text = entryText(entry);
  if (!target || !text) return;
  if (target.mode === "tiles") {
    if (addVaultTile(target.key, entry)) showToast("已加入磁贴", "success");
    return;
  }
  // focus:false：抽屉还开着，不能让手机键盘从遮罩后面弹出来。
  insertSnippet(target.key, formatPromptWeight(text, entry.weight), { focus: false });
  showToast(`已插入${entry.title ? `「${entry.title}」` : "预设词条"}`, "success");
}

function handleVaultGroup(group) {
  const target = state.vaultTarget;
  if (!target) return;
  const members = groupEntries(group, state.vault).filter((entry) => entryText(entry));
  if (!members.length) {
    showToast("这个组合里没有可用的词条", "error");
    return;
  }

  if (target.mode === "tiles") {
    const current = Array.isArray(values[target.key]) ? [...values[target.key]] : [];
    const known = new Set(current.map((tile) => tile.ref_preset_id).filter(Boolean));
    let added = 0;
    for (const entry of members) {
      if (entry.id && known.has(entry.id)) continue;
      current.push(tileFromEntry(entry, state.vault));
      if (entry.id) known.add(entry.id);
      added += 1;
    }
    if (!added) {
      showToast("组合里的词条都已经在磁贴里了");
      return;
    }
    setValue(target.key, current);
    showToast(`已载入 ${added} 个磁贴`, "success");
    return;
  }

  insertSnippet(
    target.key,
    members.map((entry) => formatPromptWeight(entryText(entry), entry.weight)).join(", "),
    { focus: false },
  );
  showToast(`已载入组合「${group.title}」`, "success");
}

function tileValue(slot) {
  const value = values[slotKey(slot)];
  return Array.isArray(value) ? value : [];
}

function loraList(slot) {
  const value = values[slotKey(slot)];
  return Array.isArray(value) ? value : [];
}

function updateTiles(slot, mapper) {
  setValue(slotKey(slot), mapper(tileValue(slot)));
}

function toggleTile(slot, index) {
  updateTiles(slot, (list) =>
    list.map((tile, position) => (position === index ? { ...tile, enabled: tile.enabled === false } : tile)),
  );
}

function removeTile(slot, index) {
  updateTiles(slot, (list) => list.filter((tile, position) => position !== index));
}

function nudgeTile(slot, index, delta) {
  updateTiles(slot, (list) =>
    list.map((tile, position) =>
      position === index ? { ...tile, weight: clampTileWeight(Number(tile.weight) + delta) } : tile,
    ),
  );
}

function formatWeightValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "1.00";
}

let tileDrag = null;

function startTileDrag(event, slot, index) {
  tileDrag = { key: slotKey(slot), index };
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function moveTileDrag(event) {
  if (!tileDrag) return;
  const element = document.elementFromPoint(event.clientX, event.clientY)?.closest?.("[data-tile-index]");
  if (!element) return;
  const target = Number(element.dataset.tileIndex);
  const current = values[tileDrag.key];
  if (!Number.isInteger(target) || target === tileDrag.index) return;
  if (!Array.isArray(current) || target < 0 || target >= current.length) return;
  const next = [...current];
  const [moved] = next.splice(tileDrag.index, 1);
  next.splice(target, 0, moved);
  tileDrag.index = target;
  setValue(tileDrag.key, next);
}

function endTileDrag() {
  tileDrag = null;
}

// LoRA 托盘的选择器由托盘自己持有，这里只保留一个入口给字段头部的按钮。
function setLoraTrayRef(key, instance) {
  if (instance) loraTrayRefs.set(key, instance);
  else loraTrayRefs.delete(key);
}

function openLoraPicker(slot) {
  loraTrayRefs.get(slotKey(slot))?.openPicker?.();
}

async function refreshWorkflows() {
  state.workflowLoading = true;
  state.workflowError = "";
  try {
    const data = await fetchWorkflows();
    workflowList.value = Array.isArray(data?.workflows) ? data.workflows : [];
    state.workflowActiveId = String(data?.active_id || "");
  } catch (error) {
    state.workflowError = formatError(error);
  } finally {
    state.workflowLoading = false;
  }
}

async function openWorkflowDrawer() {
  // 从侧边菜单进入时先收起菜单，避免两层抽屉叠在一起。
  state.drawer = false;
  state.workflowDrawer = true;
  await refreshWorkflows();
}

function closeWorkflowDrawer() {
  state.workflowDrawer = false;
}

async function handleSwitchWorkflow(workflow) {
  const id = typeof workflow === "string" ? workflow : workflow?.id;
  if (!id || state.workflowBusyId) return;
  state.workflowBusyId = id;
  try {
    // 先把上一次编辑的 debounce 写回落地，避免切换后这些请求落到新工作流的同 id 槽位上。
    await flushPendingWrites();
    const result = await switchWorkflow(id);
    await loadConfig({ quiet: false, reset: true });
    state.workflowActiveId = String(result?.id || id);
    state.workflowDrawer = false;
    showToast(`已切换到「${state.config?.display_title || "工作流"}」`, "success");
  } catch (error) {
    showToast(`切换失败：${formatError(error)}`, "error");
  } finally {
    state.workflowBusyId = "";
  }
}

// LoRA 触发词一键插入正面提示词：优先落在光标处，没有光标时按逗号分隔追加。
function handleInsertWord(word) {
  const snippet = String(word || "").trim();
  if (!snippet) return;
  const slot = promptSlots.value.find((entry) => entry.type === "prompt") || promptSlots.value[0];
  if (!slot) {
    showToast("当前模板没有提示词槽位", "error");
    return;
  }
  insertSnippet(slotKey(slot), snippet, { focus: false });
  showToast(`已插入触发词：${snippet}`);
}

async function copyPrompt(slot) {
  const text = String(values[slotKey(slot)] ?? "");
  if (!text) {
    showToast("提示词还是空的");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast("提示词已复制");
  } catch {
    showToast("浏览器不允许复制", "error");
  }
}

function clearPrompt(slot) {
  setValue(slotKey(slot), "");
  showToast("提示词已清空");
}

function restoreImage() {
  try {
    const stored = JSON.parse(localStorage.getItem(LAST_IMAGE_KEY) || "null");
    if (stored?.filename) {
      state.image = { ...stored, url: buildImageUrl(stored) };
    }
  } catch {
    // A stale local image record should not block the controller.
  }
}

function setImage(image) {
  state.image = image;
  state.imageError = false;
  try {
    localStorage.setItem(
      LAST_IMAGE_KEY,
      JSON.stringify({
        filename: image.filename,
        subfolder: image.subfolder,
        type: image.type,
        at: image.at,
      }),
    );
  } catch {
    // Storage can be unavailable in private browsing; the image is still shown.
  }
}

function imageFailed() {
  state.imageError = true;
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function showToast(message, type = "info") {
  state.toast = { message, type };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
  }, 3200);
}

function dismissError() {
  state.error = "";
}

function nodeName(nodeId) {
  if (outputNodeId.value && String(nodeId) === String(outputNodeId.value)) {
    return state.config?.output_node_title || "输出节点";
  }
  const slot = slots.value.find((entry) => String(entry.node_id) === String(nodeId));
  return slot?.node_title || `节点 ${nodeId}`;
}

function clearRunTimers(target) {
  if (!target) return;
  if (target.finishTimer) clearTimeout(target.finishTimer);
  if (target.pollTimer) clearInterval(target.pollTimer);
  target.finishTimer = null;
  target.pollTimer = null;
}

function finishRun(target, errorMessage = "") {
  if (!target || target !== run || target.finished) return;
  target.finished = true;
  clearRunTimers(target);
  const promptId = target.promptId;
  const hadImage = target.image;
  run = null;

  state.generating = false;
  state.stopping = false;
  state.progress = null;
  state.currentNode = null;

  if (errorMessage) {
    state.error = errorMessage;
    showToast("生成失败", "error");
    return;
  }
  if (hadImage) {
    showToast("生成完成", "success");
  } else if (promptId) {
    void hydrateFromHistory(promptId);
  }
}

// 用户主动停止：不弹错误横幅，只收掉运行态并给一条轻提示。
function stopRun(message = "已停止生成") {
  if (!run) {
    state.generating = false;
    state.stopping = false;
    state.progress = null;
    state.currentNode = null;
    return;
  }
  run.finished = true;
  clearRunTimers(run);
  run = null;
  state.generating = false;
  state.stopping = false;
  state.progress = null;
  state.currentNode = null;
  showToast(message);
}

async function stopGeneration() {
  if (!state.generating || state.stopping) return;
  const promptId = run?.promptId;
  if (!promptId) {
    // 运行态异常（例如页面在任务中途恢复）时至少把本地状态收干净。
    stopRun("已停止生成");
    return;
  }
  state.stopping = true;
  try {
    const result = await cancelPrompt(promptId);
    // 后端同时尝试中断正在执行的任务并清理队列；两者都为 false 说明任务已经结束。
    stopRun(result?.stopped ? "已停止生成" : "任务已经结束");
  } catch (error) {
    state.stopping = false;
    showToast(`停止失败：${formatError(error)}`, "error");
  }
}

function scheduleFinish(delay = 350) {
  if (!run) return;
  if (run.finishTimer) clearTimeout(run.finishTimer);
  run.finishTimer = setTimeout(() => finishRun(run), delay);
}

async function fetchHistory(promptId) {
  const response = await fetch(`/history/${encodeURIComponent(promptId)}`, { cache: "no-store" });
  if (!response.ok) return null;
  const data = await response.json();
  return data?.[promptId] || null;
}

function imageFromHistory(entry) {
  if (!entry?.outputs) return null;
  const preferred = outputNodeId.value ? entry.outputs[String(outputNodeId.value)] : null;
  if (preferred) {
    const image = imageFromOutput(preferred);
    if (image) return image;
  }
  for (const output of Object.values(entry.outputs)) {
    const image = imageFromOutput(output);
    if (image) return image;
  }
  return null;
}

async function hydrateFromHistory(promptId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const entry = await fetchHistory(promptId);
      const image = imageFromHistory(entry);
      if (image) {
        setImage(image);
        showToast("生成完成", "success");
        return;
      }
      if (entry?.status?.status_str === "error") {
        state.error = "执行失败，请查看 ComfyUI 控制台";
        return;
      }
    } catch {
      // ComfyUI can briefly refuse history reads while the queue finalizes.
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  state.error = "执行已经结束，但没有找到输出图片。请确认主输出节点设置正确。";
}

function startRunPolling(target) {
  if (!target || target.pollTimer) return;
  target.pollAttempts = 0;
  target.pollTimer = setInterval(async () => {
    if (!target || target !== run || target.finished) return;
    target.pollAttempts += 1;
    if (target.pollAttempts > 150) {
      finishRun(target, "等待执行结果超时，请检查 ComfyUI 队列。");
      return;
    }
    try {
      const entry = await fetchHistory(target.promptId);
      if (!target || target !== run || target.finished) return;
      if (!entry) return;
      const image = imageFromHistory(entry);
      if (image) {
        setImage(image);
        target.image = true;
      }
      if (entry.status?.status_str === "error") {
        finishRun(target, "执行失败，请查看 ComfyUI 控制台。");
        return;
      }
      // 历史记录出现即代表任务已经结束，图片可以缺失（例如只有预览节点）。
      scheduleFinish(150);
    } catch {
      // Polling is only a WebSocket fallback; transient failures are ignored.
    }
  }, 4000);
}

async function generate() {
  if (!state.hasTemplate || state.generating || state.stopping) return;
  state.error = "";
  try {
    await flushPendingWrites();
    const result = await executePrompt(collectSlots());
    if (!result?.prompt_id) throw new Error("服务端没有返回 prompt_id");
    run = {
      promptId: result.prompt_id,
      image: false,
      finished: false,
      finishTimer: null,
      pollTimer: null,
      pollAttempts: 0,
    };
    state.generating = true;
    state.stopping = false;
    state.progress = null;
    state.currentNode = "等待执行";
    showToast(
      result.skipped
        ? `已提交 #${result.number}，跳过 ${result.skipped} 项失效写入`
        : `已提交 #${result.number}`,
      result.skipped ? "info" : "success",
    );
    if (state.connection !== "online") startRunPolling(run);
  } catch (error) {
    state.error = formatError(error);
    showToast("提交失败", "error");
  }
}

function handleSocketMessage(message) {
  if (!message || typeof message.type !== "string") return;
  const data = message.data || {};
  if (message.type === "suski:template_synced") {
    scheduleConfigLoad();
    if (state.workflowDrawer) void refreshWorkflows();
    return;
  }
  if (message.type === "prompt_vault:library_updated") {
    if (state.integrations.prompt_vault) void loadVault();
    return;
  }
  if (!run) return;
  if (data.prompt_id && data.prompt_id !== run.promptId) return;

  if (message.type === "status") {
    // ComfyUI 只向提交任务的 client 广播 execution_success，本页没有自己的
    // client_id，所以以队列清空作为任务结束的可靠信号。
    if (data.status?.exec_info?.queue_remaining === 0) scheduleFinish(400);
    return;
  }
  if (message.type === "execution_start") {
    state.generating = true;
    state.currentNode = "准备执行";
    return;
  }
  if (message.type === "progress") {
    state.progress = { value: Number(data.value) || 0, max: Number(data.max) || 0 };
    state.currentNode = nodeName(data.node);
    return;
  }
  if (message.type === "executing") {
    if (data.node === null || data.node === undefined) {
      state.currentNode = "整理输出";
      scheduleFinish(250);
      return;
    }
    state.currentNode = nodeName(data.node);
    return;
  }
  if (message.type === "executed") {
    if (outputNodeId.value && String(data.node) !== String(outputNodeId.value)) return;
    const image = imageFromOutput(data.output);
    if (image) {
      setImage(image);
      run.image = true;
    }
    return;
  }
  if (message.type === "execution_success") {
    scheduleFinish(150);
    return;
  }
  if (message.type === "execution_interrupted") {
    finishRun(run, "生成已中断");
    return;
  }
  if (message.type === "execution_error") {
    const detail = data.exception_message || data.exception_type || "请查看 ComfyUI 控制台";
    finishRun(run, `执行失败：${detail}`);
  }
}

function socketUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws?clientId=${encodeURIComponent(clientId)}`;
}

function scheduleReconnect() {
  if (unmounted) return;
  clearTimeout(reconnectTimer);
  const delay = Math.min(1000 * 2 ** reconnectAttempt, 10000);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(connectSocket, delay);
}

function connectSocket() {
  if (unmounted) return;
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  state.connection = navigator.onLine ? "connecting" : "offline";
  let nextSocket;
  try {
    nextSocket = new WebSocket(socketUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket = nextSocket;

  nextSocket.onopen = () => {
    reconnectAttempt = 0;
    state.connection = "online";
    if (!state.hasTemplate || Date.now() - lastConfigAt > 10000) {
      void loadConfig({ quiet: Boolean(state.hasTemplate) });
    }
  };

  nextSocket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleSocketMessage(message);
  };

  nextSocket.onerror = () => {
    try {
      nextSocket.close();
    } catch {
      // The close handler owns reconnection.
    }
  };

  nextSocket.onclose = () => {
    if (socket === nextSocket) socket = null;
    state.connection = "offline";
    if (state.generating && run) {
      state.currentNode = "连接中断，等待结果";
      startRunPolling(run);
    }
    scheduleReconnect();
  };
}

function reconnect() {
  clearTimeout(reconnectTimer);
  if (socket) {
    try {
      socket.close();
    } catch {
      // Reconnect regardless of the old socket state.
    }
    socket = null;
  }
  reconnectAttempt = 0;
  connectSocket();
  showToast("正在重新连接");
}

function openDrawer() {
  state.drawer = true;
}

function closeDrawer() {
  state.drawer = false;
}

async function copyPageLink() {
  const url = location.href;
  if (navigator.share) {
    try {
      await navigator.share({ title: "PocketNAI", url });
      return;
    } catch {
      // Fall back to clipboard when the share sheet is cancelled or blocked.
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast("链接已复制");
  } catch {
    showToast(url, "info");
  }
}

function onInstallPrompt(event) {
  event.preventDefault();
  installPrompt = event;
  state.canInstall = true;
}

async function installApp() {
  if (!installPrompt) return;
  const prompt = installPrompt;
  installPrompt = null;
  state.canInstall = false;
  await prompt.prompt();
  try {
    await prompt.userChoice;
  } catch {
    // The browser owns the install result.
  }
}

function onVisibilityChange() {
  if (document.hidden) return;
  if (!socket || socket.readyState > WebSocket.OPEN) connectSocket();
  if (Date.now() - lastConfigAt > 15000) void loadConfig({ quiet: true });
}

function onOnline() {
  connectSocket();
}

function onOffline() {
  state.connection = "offline";
}

function onKeydown(event) {
  if (event.key !== "Escape") return;
  if (state.vaultSheet) closeVaultSheet();
  else if (state.workflowDrawer) closeWorkflowDrawer();
  else if (state.drawer) closeDrawer();
}

watch(
  () => [state.drawer, state.vaultSheet, state.workflowDrawer],
  ([drawer, sheet, workflows]) => {
    document.body.classList.toggle("drawer-open", Boolean(drawer || sheet || workflows));
  },
);

onMounted(() => {
  restoreImage();
  void loadConfig();
  void loadIntegrations();
  void loadTags();
  connectSocket();
  window.addEventListener("beforeinstallprompt", onInstallPrompt);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener("keydown", onKeydown);
  document.addEventListener("visibilitychange", onVisibilityChange);
});

onBeforeUnmount(() => {
  unmounted = true;
  clearTimeout(reconnectTimer);
  clearTimeout(configTimer);
  clearTimeout(toastTimer);
  for (const timer of writeTimers.values()) clearTimeout(timer);
  writeTimers.clear();
  if (run) clearRunTimers(run);
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  window.removeEventListener("beforeinstallprompt", onInstallPrompt);
  window.removeEventListener("online", onOnline);
  window.removeEventListener("offline", onOffline);
  window.removeEventListener("keydown", onKeydown);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  document.body.classList.remove("drawer-open");
});
</script>

<template>
  <div class="suski-app">
    <div class="ambient ambient-one"></div>
    <div class="ambient ambient-two"></div>

    <header class="app-header">
      <button class="icon-button" type="button" aria-label="打开菜单" @click="openDrawer">
        <AppIcon name="menu" :size="20" />
      </button>

      <div class="brand-block">
        <div class="brand-kicker"><span class="brand-mark"></span> PocketNAI</div>
        <h1>
          <button
            class="brand-title"
            type="button"
            :title="state.hasTemplate ? '切换工作流' : '选择已保存的工作流'"
            @click="openWorkflowDrawer"
          >
            <span class="brand-title-text">{{ state.hasTemplate ? title : "移动端控制器" }}</span>
            <AppIcon class="brand-caret" name="chevronDown" :size="13" :stroke-width="2.2" />
          </button>
        </h1>
      </div>

      <button
        class="connection-pill"
        :class="state.connection"
        type="button"
        :title="state.connection === 'online' ? '局域网连接正常' : '点击重连'"
        @click="reconnect"
      >
        <span class="connection-dot"></span>
        <span>{{ connectionLabel }}</span>
      </button>
    </header>

    <main class="app-main">
      <div v-if="state.error" class="error-banner" role="alert">
        <div class="error-copy">
          <span class="error-kicker">CONTROLLER ERROR</span>
          <p>{{ state.error }}</p>
        </div>
        <button type="button" aria-label="关闭错误提示" @click="dismissError">
          <AppIcon name="close" :size="14" />
        </button>
      </div>

      <template v-if="state.loading">
        <section class="skeleton-card">
          <span class="skeleton-line short"></span>
          <span class="skeleton-line"></span>
          <span class="skeleton-line tall"></span>
        </section>
        <section class="skeleton-card">
          <span class="skeleton-line short"></span>
          <span class="skeleton-line tall shorter"></span>
        </section>
      </template>

      <section v-else-if="!state.hasTemplate" class="empty-state panel">
        <div class="empty-orbit">
          <span class="orbit-ring"></span>
          <svg viewBox="0 0 64 64" aria-hidden="true">
            <rect x="17" y="7" width="30" height="50" rx="7" />
            <path d="M26 12h12M29 51h6" />
            <path d="M23 22h18M23 29h13M23 36h9" />
          </svg>
        </div>
        <span class="eyebrow">WAITING FOR A WORKFLOW</span>
        <h2>先给工作流放几个槽位</h2>
        <p class="empty-copy">在 PC 端画布上右键任意节点，把想交给手机的输入绑定成槽位。保存或排队后，模板会自动推送过来。</p>
        <ol class="empty-steps">
          <li><span>01</span>在 ComfyUI 打开工作流</li>
          <li><span>02</span>节点右键 → suski 移动端槽位</li>
          <li><span>03</span>为 SaveImage 设置主输出</li>
        </ol>
        <div class="empty-actions">
          <button class="primary-button" type="button" @click="refreshTemplate(true)">重新读取模板</button>
          <button class="ghost-button" type="button" @click="openWorkflowDrawer">选择已保存工作流</button>
          <a class="ghost-button" href="/" target="_blank" rel="noopener">打开 ComfyUI</a>
        </div>
      </section>

      <template v-else>
        <div class="template-strip">
          <span class="template-count">{{ templateMeta }}</span>
          <span v-if="state.updatedAt" class="template-updated">{{ formatTime(state.updatedAt) }} 同步</span>
          <span v-if="!hasOutput" class="template-warning">未设置主输出</span>
        </div>

        <section v-for="slot in loraSlots" :key="slotKey(slot)" class="field-card panel lora-panel">
          <div class="field-head">
            <div class="field-heading">
              <span class="field-glyph" aria-hidden="true">
                <AppIcon name="bolt" :size="13" />
              </span>
              <label>{{ slotLabel(slot) }}</label>
            </div>
            <button class="mini-button" type="button" @click="openLoraPicker(slot)">
              <AppIcon name="plus" :size="12" />
              <span>添加 LoRA</span>
            </button>
          </div>
          <ActiveLoraTray
            :ref="(instance) => setLoraTrayRef(slotKey(slot), instance)"
            :model-value="loraList(slot)"
            @update:model-value="setValue(slotKey(slot), $event)"
            @insert-prompt="handleInsertWord"
          />
        </section>

        <section
          v-for="slot in promptSlots"
          :key="slotKey(slot)"
          class="field-card panel"
          :class="{ 'negative-card': slot.type === 'negative' }"
        >
          <div class="field-head">
            <div class="field-heading">
              <span class="field-glyph" aria-hidden="true">
                <AppIcon :name="slot.type === 'negative' ? 'minus' : 'plus'" :size="13" />
              </span>
              <label :for="elementId(slot)">{{ slotLabel(slot) }}</label>
            </div>
            <span class="field-type">{{ typeLabel(slot.type) }}</span>
          </div>
          <PromptToolbar
            :show-vault="state.integrations.prompt_vault"
            @vault="openVaultForText(slot)"
            @copy="copyPrompt(slot)"
            @clear="clearPrompt(slot)"
          />
          <TagTextarea
            :id="elementId(slot)"
            :ref="(element) => setPromptRef(slotKey(slot), element)"
            :model-value="String(values[slotKey(slot)] ?? '')"
            :tags="tags"
            :placeholder="placeholderFor(slot)"
            :min-rows="slot.type === 'negative' ? 2 : 3"
            @update:model-value="setValue(slotKey(slot), $event)"
          />
          <div class="field-foot">
            <span>{{ String(values[slotKey(slot)] ?? "").length }} chars</span>
            <span>{{ tags.length ? `${tags.length.toLocaleString()} tags` : tagStatusLabel }}</span>
          </div>
        </section>

        <section v-for="slot in tileSlots" :key="slotKey(slot)" class="field-card panel">
          <div class="field-head">
            <div class="field-heading">
              <span class="field-glyph" aria-hidden="true">
                <AppIcon name="tiles" :size="13" />
              </span>
              <label>{{ slotLabel(slot) }}</label>
            </div>
            <button
              v-if="state.integrations.prompt_vault"
              class="mini-button"
              type="button"
              @click="openVaultForTiles(slot)"
            >
              <AppIcon name="book" :size="12" />
              <span>预设库</span>
            </button>
          </div>

          <div v-if="tileValue(slot).length" class="tile-list">
            <article
              v-for="(tile, index) in tileValue(slot)"
              :key="tile.instance_id || index"
              class="vault-tile"
              :class="{ muted: tile.enabled === false }"
              :data-tile-index="index"
            >
              <button
                class="tile-handle"
                type="button"
                aria-label="拖动排序"
                @pointerdown="startTileDrag($event, slot, index)"
                @pointermove="moveTileDrag"
                @pointerup="endTileDrag"
                @pointercancel="endTileDrag"
              >
                <AppIcon name="drag" :size="14" />
              </button>
              <div class="tile-main">
                <div class="tile-head">
                  <strong>{{ tile.title || tile.prompt }}</strong>
                  <button class="tile-remove" type="button" aria-label="移除磁贴" @click="removeTile(slot, index)">
                    <AppIcon name="close" :size="12" />
                  </button>
                </div>
                <p class="tile-prompt">{{ tile.prompt }}</p>
                <div class="tile-controls">
                  <button
                    class="lora-switch"
                    :class="{ on: tile.enabled !== false }"
                    type="button"
                    @click="toggleTile(slot, index)"
                  >
                    <AppIcon name="power" :size="12" />
                    <span>{{ tile.enabled === false ? "已静音" : "已启用" }}</span>
                  </button>
                  <div class="tile-weight">
                    <button class="step-button" type="button" @click="nudgeTile(slot, index, -TILE_WEIGHT_STEP)">
                      −
                    </button>
                    <span>{{ formatWeightValue(tile.weight) }}</span>
                    <button class="step-button" type="button" @click="nudgeTile(slot, index, TILE_WEIGHT_STEP)">
                      +
                    </button>
                  </div>
                </div>
              </div>
            </article>
          </div>
          <p v-else class="tray-empty">
            还没有磁贴。点右上角「预设库」挑几条加进来，这里的顺序就是拼进提示词的顺序。
          </p>
        </section>

        <section v-if="!promptSlots.length" class="no-slots panel">
          <span class="field-glyph">
            <AppIcon name="diamond" :size="14" />
          </span>
          <div>
            <h3>这个模板没有提示词槽位</h3>
            <p>仍然可以直接生成，参数会沿用工作流里的默认值。</p>
          </div>
        </section>

        <details
          v-if="advancedSlots.length"
          class="advanced-panel panel"
          :open="state.advancedOpen"
          @toggle="state.advancedOpen = $event.target.open"
        >
          <summary>
            <span class="summary-left">
              <AppIcon name="sliders" :size="15" />
              高级参数
              <span class="count-chip">{{ advancedSlots.length }}</span>
            </span>
            <AppIcon class="chevron" name="chevronDown" :size="15" />
          </summary>

          <div class="advanced-body">
            <div v-for="slot in advancedSlots" :key="slotKey(slot)" class="param-row">
              <div class="param-head">
                <label :for="elementId(slot)">{{ slotLabel(slot) }}</label>
                <span>{{ typeLabel(slot.type) }}</span>
              </div>

              <div v-if="slot.type === 'seed'" class="seed-row">
                <input
                  :id="elementId(slot)"
                  class="number-input"
                  type="number"
                  inputmode="numeric"
                  step="1"
                  :min="-1"
                  :max="MAX_SEED"
                  :value="values[slotKey(slot)]"
                  @input="onNumberInput(slot, $event)"
                  @blur="onNumberBlur(slot)"
                />
                <button class="dice-button" type="button" title="随机种子" aria-label="随机种子" @click="randomizeSeed(slot)">
                  <AppIcon name="dice" :size="18" />
                </button>
              </div>
              <p v-if="slot.type === 'seed'" class="param-hint">-1 时由服务端在入队前随机化</p>

              <template v-else-if="slot.type === 'slider'">
                <div class="range-row">
                  <input
                    :id="elementId(slot)"
                    class="range-input"
                    type="range"
                    :min="slot.min ?? 0"
                    :max="slot.max ?? 100"
                    :step="stepFor(slot)"
                    :value="numberValue(slot)"
                    @input="onRangeInput(slot, $event)"
                  />
                  <input
                    class="range-number"
                    type="number"
                    inputmode="decimal"
                    :min="slot.min ?? 0"
                    :max="slot.max ?? 100"
                    :step="stepFor(slot)"
                    :value="values[slotKey(slot)]"
                    @input="onNumberInput(slot, $event)"
                    @blur="onNumberBlur(slot)"
                  />
                </div>
                <div class="range-scale">
                  <span>{{ slot.min ?? 0 }}</span>
                  <span>{{ slot.max ?? 100 }}</span>
                </div>
              </template>

              <div v-else-if="slot.type === 'toggle'" class="toggle-row">
                <span class="toggle-copy">{{ values[slotKey(slot)] ? "开启" : "关闭" }}</span>
                <label class="switch">
                  <input
                    :id="elementId(slot)"
                    type="checkbox"
                    :checked="Boolean(values[slotKey(slot)])"
                    @change="onToggle(slot, $event)"
                  />
                  <span class="switch-track"></span>
                </label>
              </div>

              <select
                v-else-if="slot.type === 'combo'"
                :id="elementId(slot)"
                class="combo-input"
                :value="values[slotKey(slot)]"
                @change="onCombo(slot, $event)"
              >
                <option v-for="option in slot.options || []" :key="String(option)" :value="option">
                  {{ option }}
                </option>
                <option v-if="!(slot.options || []).some((option) => String(option) === String(values[slotKey(slot)]))" :value="values[slotKey(slot)]">
                  {{ values[slotKey(slot)] }}
                </option>
              </select>

              <input
                v-else-if="slot.type === 'number'"
                :id="elementId(slot)"
                class="number-input"
                type="number"
                inputmode="decimal"
                :step="slot.step ?? 'any'"
                :min="slot.min"
                :max="slot.max"
                :value="values[slotKey(slot)]"
                @input="onNumberInput(slot, $event)"
                @blur="onNumberBlur(slot)"
              />

              <input
                v-else
                :id="elementId(slot)"
                class="text-input"
                type="text"
                :value="values[slotKey(slot)]"
                @input="setValue(slotKey(slot), $event.target.value)"
              />
            </div>
          </div>
        </details>

        <section class="action-panel panel">
          <button
            class="generate-button"
            :class="{ 'is-stop': state.generating }"
            type="button"
            :disabled="state.stopping || (!state.hasTemplate && !state.generating)"
            :aria-busy="state.generating && !state.stopping"
            @click="state.generating ? stopGeneration() : generate()"
          >
            <span v-if="state.stopping" class="spinner" aria-hidden="true"></span>
            <AppIcon v-else-if="state.generating" name="stop" :size="18" />
            <AppIcon v-else name="sparkle" :size="19" />
            <span>{{ state.stopping ? "正在停止…" : state.generating ? "停止生成" : "生成" }}</span>
            <span class="generate-sub">
              {{ state.stopping ? "STOPPING" : state.generating ? "STOP" : "GENERATE" }}
            </span>
          </button>

          <div v-if="state.generating" class="progress-block" aria-live="polite">
            <div class="progress-head">
              <span>{{ progressLabel }}</span>
              <span v-if="state.progress?.max">{{ progressPercent }}%</span>
            </div>
            <div class="progress-track" :class="{ indeterminate: progressIndeterminate }">
              <div class="progress-fill" :style="{ width: progressIndeterminate ? '38%' : `${progressPercent}%` }"></div>
            </div>
          </div>
          <p v-else class="generate-note">提示词与参数会注入当前模板，图片生成后自动出现在下方。</p>
        </section>

        <section class="image-card panel">
          <div class="image-viewport" :class="{ empty: !state.image || state.imageError }">
            <img
              v-if="state.image && !state.imageError"
              :src="state.image.url"
              :alt="state.image.filename || '生成结果'"
              draggable="false"
              @error="imageFailed"
            />
            <div v-else class="image-placeholder">
              <svg viewBox="0 0 64 64" aria-hidden="true">
                <rect x="9" y="11" width="46" height="42" rx="7" />
                <circle cx="23" cy="25" r="4" />
                <path d="m14 46 12-12 8 8 6-6 12 12" />
              </svg>
              <span>{{ state.imageError ? "图片加载失败" : "等待下一次生成" }}</span>
              <small>{{ state.imageError ? "可点右上角在新窗口打开" : "生成后的作品会在这里出现" }}</small>
            </div>

            <div v-if="state.image" class="image-toolbar">
              <span class="output-tag">OUTPUT</span>
              <div class="image-actions">
                <a :href="state.image.url" target="_blank" rel="noopener" title="在新窗口打开" aria-label="在新窗口打开">
                  <AppIcon name="external" :size="16" />
                </a>
                <a :href="state.image.url" :download="state.image.filename" title="下载图片" aria-label="下载图片">
                  <AppIcon name="download" :size="16" />
                </a>
              </div>
            </div>
          </div>

          <div v-if="state.image" class="image-meta">
            <div class="image-file">
              <span>FILE</span>
              <p>{{ state.image.filename }}</p>
            </div>
            <span class="image-time">{{ formatTime(state.image.at) }}</span>
          </div>
          <p v-if="state.image" class="longpress-hint">长按图片可直接保存到相册</p>
        </section>

        <footer class="app-footer">
          <span>PocketNAI v2.0</span>
          <span class="footer-sep">/</span>
          <span>{{ tagStatusLabel }}</span>
          <a href="/" target="_blank" rel="noopener">ComfyUI</a>
        </footer>
      </template>
    </main>

    <transition name="toast">
      <div
        v-if="state.toast"
        class="toast"
        :class="[
          state.toast.type,
          { 'toast-top': state.vaultSheet || state.workflowDrawer || state.drawer },
        ]"
        role="status"
      >
        <AppIcon
          v-if="state.toast.type === 'success'"
          name="check"
          :size="14"
          :stroke-width="2"
        />
        <AppIcon
          v-else-if="state.toast.type === 'error'"
          name="warning"
          :size="14"
          :stroke-width="1.8"
        />
        <span>{{ state.toast.message }}</span>
      </div>
    </transition>

    <WorkflowSwitcher
      :open="state.workflowDrawer"
      :workflows="workflowList"
      :active-id="state.workflowActiveId"
      :active-title="state.hasTemplate ? title : ''"
      :loading="state.workflowLoading"
      :busy-id="state.workflowBusyId"
      :error="state.workflowError"
      @close="closeWorkflowDrawer"
      @switch="handleSwitchWorkflow"
      @refresh="refreshWorkflows"
    />

    <PromptVaultSheet
      :open="state.vaultSheet"
      :library="state.vault"
      :mode="state.vaultTarget?.mode || 'text'"
      :status="state.vaultStatus"
      @close="closeVaultSheet"
      @insert="handleVaultInsert"
      @load-group="handleVaultGroup"
      @reload="loadVault"
    />

    <transition name="drawer">
      <div v-if="state.drawer" class="drawer-backdrop" @click.self="closeDrawer">
        <aside class="drawer-panel" role="dialog" aria-modal="true" aria-label="PocketNAI 菜单">
          <div class="drawer-head">
            <div>
              <span class="eyebrow">POCKET CONTROLLER</span>
              <h2>{{ state.hasTemplate ? title : "还没有模板" }}</h2>
            </div>
            <button class="icon-button" type="button" aria-label="关闭菜单" @click="closeDrawer">
              <AppIcon name="close" :size="16" />
            </button>
          </div>

          <div class="drawer-status-grid">
            <div class="drawer-stat">
              <span>连接</span>
              <strong :class="`text-${state.connection}`">{{ connectionLabel }}</strong>
            </div>
            <div class="drawer-stat">
              <span>槽位</span>
              <strong>{{ slots.length }}</strong>
            </div>
            <div class="drawer-stat">
              <span>主输出</span>
              <strong>{{ hasOutput ? `#${outputNodeId}` : "未设置" }}</strong>
            </div>
            <div class="drawer-stat">
              <span>词库</span>
              <strong>{{ tags.length ? tags.length.toLocaleString() : "—" }}</strong>
            </div>
          </div>

          <div class="drawer-section">
            <h3>已绑定槽位</h3>
            <ul v-if="slots.length" class="slot-list">
              <li v-for="slot in slots" :key="slotKey(slot)">
                <span class="slot-type">{{ typeLabel(slot.type) }}</span>
                <span class="slot-label">{{ slotLabel(slot) }}</span>
                <span class="slot-node">{{ slot.node_title || `#${slot.node_id}` }}</span>
              </li>
            </ul>
            <p v-else class="drawer-muted">还没有槽位，请在 PC 端节点右键菜单中添加。</p>
          </div>

          <div class="drawer-section">
            <h3>操作</h3>
            <div class="drawer-actions">
              <button type="button" @click="openWorkflowDrawer">
                <AppIcon name="folder" :size="16" />
                切换工作流
              </button>
              <button type="button" @click="refreshTemplate(true)">
                <AppIcon name="refresh" :size="16" />
                重新读取模板
              </button>
              <button v-if="slots.length" type="button" @click="resetTemplateValues">
                <AppIcon name="reset" :size="16" />
                恢复模板默认值
              </button>
              <button type="button" @click="copyPageLink">
                <AppIcon name="share" :size="16" />
                分享本页地址
              </button>
              <button v-if="state.canInstall" type="button" @click="installApp">
                <AppIcon name="download" :size="16" />
                安装到主屏幕
              </button>
            </div>
          </div>

          <div class="drawer-note">
            <span class="drawer-dot"></span>
            <p>移动端地址 <strong>{{ pageHost }}</strong>。模板与词库都来自本机 ComfyUI，不会访问外部服务。</p>
          </div>

          <div class="drawer-foot">
            <span>{{ tagStatusLabel }}</span>
            <span>{{ state.updatedAt ? `${formatTime(state.updatedAt)} 同步` : "等待同步" }}</span>
          </div>
        </aside>
      </div>
    </transition>
  </div>
</template>
