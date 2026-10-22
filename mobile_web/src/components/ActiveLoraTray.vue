<script setup>
import { computed, ref, watch } from "vue";
import { fetchAvailableLoras } from "../api.js";
import AppIcon from "./AppIcon.vue";
import { LORA_MAX, LORA_MIN, LORA_STEP, clampStrength, formatStrength } from "../integrations/loraManager.js";

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
});

const emit = defineEmits(["update:modelValue", "insert-prompt"]);

const entries = computed(() => props.modelValue || []);

const showPicker = ref(false);
const searchQuery = ref("");
const baseModelFilter = ref("");
const availableLoras = ref([]);
const loadingLoras = ref(false);
const pickerError = ref("");
const brokenPreviews = ref(new Set());
let pickerLoaded = false;

// Lora-Manager 的 loras 数组在 legacy 语法模式下只存文件名，path 模式下存 `目录/文件名`。
// 两种写法都指向同一个文件，所以挂载判定按最后一段文件名兜底，避免重复挂载同一条 LoRA。
function isMounted(item) {
  const name = String(item?.name || "");
  const base = String(item?.base_name || name.split("/").pop());
  return entries.value.some((entry) => {
    const mounted = String(entry?.name || "");
    if (mounted === name) return true;
    return mounted.split("/").pop() === base;
  });
}

const baseModels = computed(() => {
  const seen = new Set();
  for (const item of availableLoras.value) {
    const label = String(item.base_model || "").trim();
    if (label) seen.add(label);
  }
  return [...seen].slice(0, 12);
});

const filteredLoras = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  const model = baseModelFilter.value;
  return availableLoras.value.filter((item) => {
    if (model && String(item.base_model || "") !== model) return false;
    if (!query) return true;
    const haystack = [
      item.name,
      item.base_name,
      item.folder,
      item.base_model,
      ...(item.trigger_words || []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
});

function replace(index, patch) {
  emit(
    "update:modelValue",
    entries.value.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)),
  );
}

function toggle(index) {
  replace(index, { active: !entries.value[index].active });
}

function remove(index) {
  emit(
    "update:modelValue",
    entries.value.filter((entry, position) => position !== index),
  );
}

function applyStrength(index, value) {
  const strength = clampStrength(value);
  // 与 Lora-Manager 的折叠态一致：改模型权重时一并覆盖 clip 权重。
  replace(index, { strength, clipStrength: strength });
}

function nudge(index, delta) {
  applyStrength(index, Number(entries.value[index].strength) + delta);
}

async function loadLoras({ refresh = false } = {}) {
  loadingLoras.value = true;
  pickerError.value = "";
  try {
    const payload = await fetchAvailableLoras({ refresh });
    availableLoras.value = Array.isArray(payload?.loras) ? payload.loras : [];
    pickerLoaded = true;
  } catch (error) {
    pickerError.value = error?.message || "读取 LoRA 列表失败";
  } finally {
    loadingLoras.value = false;
  }
}

async function openPicker() {
  showPicker.value = true;
  if (pickerLoaded || loadingLoras.value) return;
  await loadLoras();
}

function closePicker() {
  showPicker.value = false;
  searchQuery.value = "";
  baseModelFilter.value = "";
}

function reloadPicker() {
  pickerLoaded = false;
  void loadLoras({ refresh: true });
}

function previewUrl(item) {
  if (!item?.preview_url || brokenPreviews.value.has(item.name)) return "";
  return item.preview_url;
}

function onPreviewError(item) {
  const next = new Set(brokenPreviews.value);
  next.add(item.name);
  brokenPreviews.value = next;
}

function addLora(item) {
  if (!item?.name || isMounted(item)) return;
  const initial = Number.isFinite(Number(item.preferred_weight)) ? Number(item.preferred_weight) : 1;
  emit("update:modelValue", [
    ...entries.value,
    {
      name: item.name,
      strength: initial,
      clipStrength: initial,
      active: true,
    },
  ]);
  closePicker();
}

function onTriggerClick(word, event) {
  event.stopPropagation();
  emit("insert-prompt", word);
}

watch(showPicker, (open) => {
  if (!open) return;
  searchQuery.value = "";
  baseModelFilter.value = "";
});

// 由外层「添加 LoRA」按钮调用，选择器状态仍归托盘自己管理。
defineExpose({ openPicker });
</script>

<template>
  <div class="lora-tray">
    <article
      v-for="(entry, index) in entries"
      :key="entry.name"
      class="lora-card"
      :class="{ muted: !entry.active }"
    >
      <header class="lora-head">
        <span class="lora-name">
          <AppIcon name="tag" :size="13" />
          <span class="lora-name-text">{{ entry.name }}</span>
        </span>
        <span class="lora-value">{{ formatStrength(entry.strength) }}</span>
      </header>

      <div class="lora-meta">
        <button class="lora-switch" :class="{ on: entry.active }" type="button" @click="toggle(index)">
          <AppIcon name="power" :size="12" />
          <span>{{ entry.active ? "已启用" : "已静音" }}</span>
        </button>
        <button class="lora-remove" type="button" @click="remove(index)">
          <AppIcon name="trash" :size="12" />
          <span>删除</span>
        </button>
      </div>

      <div class="lora-weight">
        <button class="step-button" type="button" aria-label="降低权重" @click="nudge(index, -LORA_STEP)">
          −0.05
        </button>
        <input
          class="lora-range"
          type="range"
          :min="LORA_MIN"
          :max="LORA_MAX"
          :step="LORA_STEP"
          :value="Number(entry.strength)"
          :aria-label="`${entry.name} 权重`"
          @input="applyStrength(index, $event.target.value)"
        />
        <button class="step-button" type="button" aria-label="提高权重" @click="nudge(index, LORA_STEP)">
          +0.05
        </button>
        <input
          class="lora-number"
          type="number"
          inputmode="decimal"
          :min="LORA_MIN"
          :max="LORA_MAX"
          :step="LORA_STEP"
          :value="formatStrength(entry.strength)"
          @change="applyStrength(index, $event.target.value)"
        />
      </div>
    </article>

    <p v-if="!entries.length" class="tray-empty">
      这个工作流还没挂载 LoRA。点右上角「添加 LoRA」直接从本地库里挑，不需要 PC 端在线。
    </p>

    <Teleport to="body">
      <transition name="sheet">
        <div v-if="showPicker" class="sheet-backdrop" @click.self="closePicker">
          <section class="vault-sheet lora-picker" role="dialog" aria-modal="true" aria-label="选择 LoRA">
            <header class="sheet-head">
              <div class="sheet-title">
                <span class="eyebrow">LOCAL LIBRARY</span>
                <strong>选择 LoRA</strong>
              </div>
              <button class="sheet-close" type="button" aria-label="关闭 LoRA 选择器" @click="closePicker">
                <AppIcon name="close" :size="14" />
              </button>
            </header>

            <div class="sheet-search">
              <input
                v-model="searchQuery"
                type="search"
                autocomplete="off"
                placeholder="搜索模型、底模（如 SDXL）或触发词…"
              />
            </div>

            <div v-if="baseModels.length" class="sheet-chips">
              <button type="button" :class="{ active: !baseModelFilter }" @click="baseModelFilter = ''">
                全部底模
              </button>
              <button
                v-for="model in baseModels"
                :key="model"
                type="button"
                :class="{ active: baseModelFilter === model }"
                @click="baseModelFilter = baseModelFilter === model ? '' : model"
              >
                {{ model }}
              </button>
            </div>

            <div class="sheet-body">
              <p v-if="loadingLoras" class="sheet-hint">正在检索本地 LoRA 库…</p>

              <p v-else-if="pickerError" class="sheet-hint">
                LoRA 列表读取失败：{{ pickerError }}
                <button type="button" @click="reloadPicker">重试</button>
              </p>

              <p v-else-if="!availableLoras.length" class="sheet-hint">
                没有在 models/loras 里找到 LoRA 文件。
              </p>

              <p v-else-if="!filteredLoras.length" class="sheet-hint">没有匹配的模型。</p>

              <div v-else class="picker-list">
                <div
                  v-for="item in filteredLoras"
                  :key="item.name"
                  class="picker-item"
                  :class="{ added: isMounted(item) }"
                  @click="addLora(item)"
                >
                  <span class="picker-thumb">
                    <img
                      v-if="previewUrl(item)"
                      :src="previewUrl(item)"
                      loading="lazy"
                      alt=""
                      @error="onPreviewError(item)"
                    />
                    <span v-else class="picker-thumb-none">
                      <AppIcon name="image" :size="18" />
                    </span>
                    <span v-if="item.base_model" class="model-badge">{{ item.base_model }}</span>
                  </span>

                  <span class="picker-details">
                    <span class="picker-title">{{ item.base_name || item.name }}</span>
                    <span v-if="item.folder" class="picker-folder">{{ item.folder }}</span>
                    <span v-if="Number(item.preferred_weight) !== 1" class="picker-rec">
                      推荐权重 {{ item.preferred_weight }}
                    </span>
                    <span v-if="item.trigger_words?.length" class="picker-words">
                      <button
                        v-for="word in item.trigger_words"
                        :key="word"
                        class="word-tag"
                        type="button"
                        @click="onTriggerClick(word, $event)"
                      >
                        + {{ word }}
                      </button>
                    </span>
                  </span>

                  <span class="picker-btn-box">
                    <span v-if="isMounted(item)" class="tag-added">
                      <AppIcon name="check" :size="11" />
                      <span>已挂载</span>
                    </span>
                    <button v-else class="btn-use" type="button" @click.stop="addLora(item)">选用</button>
                  </span>
                </div>
              </div>
            </div>

            <footer class="sheet-foot">
              <span>点触发词可直接插入正面提示词</span>
              <button v-if="availableLoras.length" type="button" class="sheet-refresh" @click="reloadPicker">
                刷新列表
              </button>
            </footer>
          </section>
        </div>
      </transition>
    </Teleport>
  </div>
</template>
