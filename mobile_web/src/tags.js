import { readCache, writeCache } from "./cache.js";

const TAGS_KEY = "danbooru";

export async function readTagCache() {
  const value = await readCache(TAGS_KEY);
  return Array.isArray(value?.rows) && value.rows.length ? value : null;
}

export async function writeTagCache(rows) {
  await writeCache(TAGS_KEY, { rows, savedAt: Date.now() });
}

function parseCsvLine(line) {
  const columns = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      columns.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  columns.push(value);
  return columns;
}

export function parseTagCsv(text) {
  const rows = [];
  const seen = new Set();
  let first = true;
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const columns = parseCsvLine(line);
    if (first) {
      first = false;
      if (columns[0]?.trim().toLowerCase() === "tag") continue;
    }
    const tag = String(columns[0] || "").trim();
    if (!tag || tag.length > 160 || seen.has(tag)) continue;
    seen.add(tag);
    const category = Number.parseInt(columns[1], 10);
    const count = Number.parseInt(columns[2], 10);
    rows.push({
      tag,
      category: Number.isFinite(category) ? category : 0,
      count: Number.isFinite(count) ? count : 0,
    });
  }
  return rows;
}

export async function fetchTags() {
  const response = await fetch("/suski/api/tags.csv", { cache: "no-cache" });
  if (!response.ok) throw new Error(`词库加载失败（HTTP ${response.status}）`);
  return parseTagCsv(await response.text());
}

export function formatTagCount(count) {
  if (!count) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}
