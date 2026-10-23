import { reactive } from "vue";

// 会话图库：只在当前页面内存中保存本次 UI 生成的图片。
// 不读取服务器输出目录、不写 localStorage / IndexedDB / Cache Storage，
// 刷新或关闭页面时随页面一起销毁。关闭页面时才释放 blob URL。
export const gallery = reactive({
  items: [],
});

const seenKeys = new Set();
const pendingKeys = new Set();
let sessionToken = 0;

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function imageKey(image) {
  return `${image?.subfolder || ""}::${image?.filename || ""}`;
}

function cleanName(value) {
  return String(value || "image").replace(/[\\/:*?"<>|]+/g, "_");
}

function timestampForFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function readImageSize(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return size;
    } catch {
      // 部分浏览器不支持该格式的 ImageBitmap，回退到 <img> 解码。
    }
  }
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
      URL.revokeObjectURL(objectUrl);
    };
    image.onerror = () => {
      resolve({ width: null, height: null });
      URL.revokeObjectURL(objectUrl);
    };
    image.src = objectUrl;
  });
}

/**
 * 把一个刚生成的结果读入内存图库。
 * 读取的只是本次生成返回的 /view 图片本身，不会列出或扫描服务器输出目录。
 */
export async function captureGeneratedImage(image, meta = {}) {
  if (!image?.filename || !image?.url) return null;
  const key = imageKey(image);
  if (seenKeys.has(key) || pendingKeys.has(key)) return null;
  const token = sessionToken;
  pendingKeys.add(key);

  try {
    const response = await fetch(image.url, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (token !== sessionToken) return null;

    const size = await readImageSize(blob);
    if (token !== sessionToken) return null;
    const at = Number(image.at) || Date.now();
    const item = {
      id: newId(),
      key,
      filename: cleanName(image.filename),
      originalFilename: image.filename,
      subfolder: image.subfolder || "",
      type: image.type || "output",
      blob,
      url: URL.createObjectURL(blob),
      bytes: blob.size,
      width: size.width,
      height: size.height,
      at,
      prompt: meta.prompt || "",
      negative: meta.negative || "",
      prompts: Array.isArray(meta.prompts) ? meta.prompts : [],
    };
    seenKeys.add(key);
    gallery.items.unshift(item);
    return item;
  } catch (error) {
    console.warn("[PocketNAI] 本次生成结果无法暂存到会话图库", error);
    return null;
  } finally {
    pendingKeys.delete(key);
  }
}

export function galleryBytes(items = gallery.items) {
  return items.reduce((total, item) => total + (Number(item.bytes) || 0), 0);
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index > 1 ? 2 : 0)} ${units[index]}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function downloadGalleryItem(item) {
  if (!item?.blob) return;
  downloadBlob(item.blob, item.filename);
}

// ---------- 纯前端 ZIP（store 模式，图片本身已是压缩格式，无需再压缩） ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date: day };
}

function uniqueName(name, used) {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let index = 2;
  let candidate = `${base}_${index}${ext}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${base}_${index}${ext}`;
  }
  return candidate;
}

async function buildZip(items) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  const usedNames = new Set();
  let offset = 0;

  for (const item of items) {
    const name = uniqueName(cleanName(item.filename), usedNames);
    usedNames.add(name);
    const nameBytes = encoder.encode(name);
    const data = new Uint8Array(await item.blob.arrayBuffer());
    const crc = crc32(data);
    const { time, date } = dosDateTime(new Date(item.at));

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true); // UTF-8 文件名
    localView.setUint16(8, 0, true); // store
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, items.length, true);
  endView.setUint16(10, items.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
}

export async function downloadGalleryZip(items) {
  const list = (Array.isArray(items) ? items : []).filter((item) => item?.blob);
  if (!list.length) throw new Error("当前会话还没有可打包的图片");
  const blob = await buildZip(list);
  downloadBlob(blob, `pocketnai_session_${timestampForFilename()}.zip`);
  return list.length;
}

/** 页面销毁时调用：释放所有内存图片，不留下任何可恢复的数据。 */
export function disposeGallery() {
  sessionToken += 1;
  for (const item of gallery.items) {
    try {
      URL.revokeObjectURL(item.url);
    } catch {
      // 已经释放过的 URL 不需要再次处理。
    }
  }
  gallery.items.splice(0);
  seenKeys.clear();
  pendingKeys.clear();
}
