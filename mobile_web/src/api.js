export const MAX_SEED = 1125899906842624;

const CLIENT_KEY = "suski-pna-client-id";

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function storedClientId() {
  try {
    const existing = localStorage.getItem(CLIENT_KEY);
    if (existing) return existing;
    const created = createId();
    localStorage.setItem(CLIENT_KEY, created);
    return created;
  } catch {
    return createId();
  }
}

export const clientId = storedClientId();

export class ApiError extends Error {
  constructor(message, status = 0, payload = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    throw new ApiError(`HTTP ${response.status}`, response.status, payload);
  }
  return payload;
}

export function getConfig() {
  return requestJson("/suski/api/config");
}

export function getIntegrations() {
  return requestJson("/suski/api/integrations");
}

export function executePrompt(slotsData) {
  return requestJson("/suski/api/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, slots_data: slotsData }),
  });
}

export function applySlots(slotsData) {
  return requestJson("/suski/api/apply_slots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, slots_data: slotsData }),
  });
}

export function randomSeed() {
  return Math.floor(Math.random() * MAX_SEED) + 1;
}

export function buildImageUrl(image) {
  const params = new URLSearchParams({
    filename: image.filename || "",
    subfolder: image.subfolder || "",
    type: image.type || "output",
  });
  if (image.at) params.set("t", String(image.at));
  return `/view?${params.toString()}`;
}

export function extractImage(output) {
  const images = Array.isArray(output?.images) ? output.images : [];
  return images.find((image) => image && image.filename) || null;
}

export function imageFromOutput(output) {
  const image = extractImage(output);
  if (!image) return null;
  const at = Date.now();
  return {
    filename: image.filename,
    subfolder: image.subfolder || "",
    type: image.type || "output",
    at,
    url: buildImageUrl({ ...image, at }),
  };
}
