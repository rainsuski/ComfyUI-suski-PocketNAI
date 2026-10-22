export const LORA_LIBRARY_URL = "/loras";
export const LORA_STEP = 0.05;
export const LORA_MIN = -5;
export const LORA_MAX = 5;

export function readLoraList(slot) {
  const raw = Array.isArray(slot?.default_val) ? slot.default_val : [];
  const entries = [];
  for (const entry of raw) {
    if (!entry || typeof entry.name !== "string" || !entry.name) continue;
    const strength = Number(entry.strength);
    const clipStrength = Number(entry.clipStrength ?? entry.strength);
    const next = {
      name: entry.name,
      strength: Number.isFinite(strength) ? strength : 1,
      clipStrength: Number.isFinite(clipStrength) ? clipStrength : Number.isFinite(strength) ? strength : 1,
      active: entry.active !== false,
    };
    const index = entries.findIndex((item) => item.name === next.name);
    if (index !== -1) entries.splice(index, 1);
    entries.push(next);
  }
  return entries;
}

export function clampStrength(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.min(LORA_MAX, Math.max(LORA_MIN, number)) * 100) / 100;
}

export function formatStrength(value) {
  return Number(value || 0).toFixed(2);
}
