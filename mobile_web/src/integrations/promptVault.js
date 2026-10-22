import { readCache, writeCache } from "../cache.js";

const LIBRARY_URL = "/prompt_vault/api/library";
const THUMBNAIL_URL = "/prompt_vault/api/thumbnails/";
const CACHE_KEY = "prompt-vault";
const CACHE_VERSION = 1;

export const TILE_WEIGHT_STEP = 0.05;
export const TILE_WEIGHT_MIN = 0.1;
export const TILE_WEIGHT_MAX = 3;

function normalizeLibrary(data) {
  return {
    categories: Array.isArray(data?.categories) ? data.categories : [],
    collections: Array.isArray(data?.collections) ? data.collections : [],
    entries: Array.isArray(data?.entries) ? data.entries : [],
    groups: Array.isArray(data?.groups) ? data.groups : [],
  };
}

export async function readVaultCache() {
  const cached = await readCache(CACHE_KEY);
  if (cached?.version !== CACHE_VERSION) return null;
  return normalizeLibrary(cached.library);
}

export async function fetchVaultLibrary() {
  const response = await fetch(LIBRARY_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`预设库加载失败（HTTP ${response.status}）`);
  const payload = await response.json();
  if (!payload?.success || !payload.data) throw new Error(payload?.error || "预设库返回数据异常");
  return normalizeLibrary(payload.data);
}

export async function writeVaultCache(library) {
  await writeCache(CACHE_KEY, { version: CACHE_VERSION, library, savedAt: Date.now() });
}

export function thumbnailUrl(filename) {
  return filename ? `${THUMBNAIL_URL}${encodeURIComponent(filename)}` : "";
}

export function categoryName(library, categoryId) {
  return library?.categories?.find((category) => category.id === categoryId)?.name || "未分类";
}

export function entryText(entry) {
  return String(entry?.text ?? entry?.prompt ?? "").trim();
}

export function formatPromptWeight(text, weight) {
  const value = Number(weight);
  if (!Number.isFinite(value) || Math.abs(value - 1) < 0.001) return text;
  return `(${text}:${value.toFixed(2).replace(/\.?0+$/, "")})`;
}

export function clampTileWeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.round(Math.min(TILE_WEIGHT_MAX, Math.max(TILE_WEIGHT_MIN, number)) * 100) / 100;
}

export function readTileList(slot) {
  const raw = Array.isArray(slot?.default_val) ? slot.default_val : [];
  const tiles = [];
  const seen = new Set();
  for (const tile of raw) {
    if (!tile || typeof tile !== "object") continue;
    const instanceId = String(tile.instance_id || "");
    if (instanceId && seen.has(instanceId)) continue;
    if (instanceId) seen.add(instanceId);
    tiles.push({ ...tile });
  }
  return tiles;
}

function tileId() {
  return `pna_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function tileFromEntry(entry, library, weight = 1) {
  return {
    instance_id: tileId(),
    ref_preset_id: entry.id || null,
    groups: [],
    pinned: true,
    title: entry.title || "未命名词条",
    prompt: entryText(entry),
    category_id: entry.categoryId || null,
    category: categoryName(library, entry.categoryId),
    weight: clampTileWeight(weight),
    enabled: true,
    is_dirty: false,
    thumbnail: entry.previewHash || "",
  };
}

export function groupEntries(group, library) {
  const ids = Array.isArray(group?.entryIds) ? group.entryIds : [];
  const entries = [];
  for (const id of ids) {
    const entry = library?.entries?.find((item) => item.id === id);
    if (entry) entries.push(entry);
  }
  return entries;
}
