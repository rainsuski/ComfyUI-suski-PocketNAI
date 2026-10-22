<script setup>
import { computed, ref, watch } from "vue";
import {
  categoryName,
  clampTileWeight,
  entryText,
  formatPromptWeight,
  groupEntries,
  thumbnailUrl,
} from "../integrations/promptVault.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  library: { type: Object, default: null },
  mode: { type: String, default: "text" },
  status: { type: String, default: "idle" },
});

const emit = defineEmits(["close", "insert", "load-group", "reload"]);

const search = ref("");
const categoryId = ref("");
const collectionId = ref("");
const detail = ref(null);
const detailWeight = ref(1);
const dragOffset = ref(0);

let pressTimer = null;
let longPressed = false;
let dragStart = null;

const categories = computed(() => props.library?.categories || []);
const collections = computed(() => props.library?.collections || []);
const query = computed(() => search.value.trim().toLowerCase());
const empty = computed(() => !props.library);

const entries = computed(() => {
  const list = props.library?.entries || [];
  return list.filter((entry) => {
    if (categoryId.value && entry.categoryId !== categoryId.value) return false;
    if (collectionId.value && !(entry.collections || []).includes(collectionId.value)) return false;
    if (!query.value) return true;
    return `${entry.title || ""} ${entryText(entry)}`.toLowerCase().includes(query.value);
  });
});

const groups = computed(() => {
  if (collectionId.value) return [];
  const list = props.library?.groups || [];
  return list.filter((group) => {
    if (categoryId.value && group.categoryId !== categoryId.value) return false;
    if (!query.value) return true;
    return String(group.title || "").toLowerCase().includes(query.value);
  });
});

const modeLabel = computed(() => (props.mode === "tiles" ? "加入磁贴" : "插入提示词"));

function entryWeight(entry) {
  const weight = Number(entry?.weight);
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

function groupSummary(group) {
  const members = groupEntries(group, props.library);
  const titles = members.map((entry) => entry.title || entryText(entry)).slice(0, 4);
  const suffix = members.length > titles.length ? " 等" : "";
  return `${titles.join("、")}${suffix}（${members.length} 个词条）`;
}

function resetFilter() {
  categoryId.value = "";
  collectionId.value = "";
}

function pickCategory(id) {
  collectionId.value = "";
  categoryId.value = categoryId.value === id ? "" : id;
}

function pickCollection(id) {
  categoryId.value = "";
  collectionId.value = collectionId.value === id ? "" : id;
}

function pressStart(entry) {
  longPressed = false;
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    longPressed = true;
    detail.value = entry;
    detailWeight.value = entryWeight(entry);
  }, 450);
}

function pressEnd() {
  clearTimeout(pressTimer);
  pressTimer = null;
}

function pickEntry(entry) {
  if (longPressed) {
    longPressed = false;
    return;
  }
  emit("insert", entry);
}

function nudgeDetail(delta) {
  detailWeight.value = clampTileWeight(detailWeight.value + delta);
}

function insertDetail() {
  if (!detail.value) return;
  emit("insert", { ...detail.value, weight: detailWeight.value });
  detail.value = null;
}

function onHandleDown(event) {
  dragStart = event.clientY;
  dragOffset.value = 0;
  event.currentTarget.setPointerCapture(event.pointerId);
}

function onHandleMove(event) {
  if (dragStart === null) return;
  dragOffset.value = Math.max(0, event.clientY - dragStart);
}

function onHandleUp() {
  if (dragStart === null) return;
  const shouldClose = dragOffset.value > 96;
  dragStart = null;
  dragOffset.value = 0;
  if (shouldClose) emit("close");
}

watch(
  () => props.open,
  (open) => {
    if (open) return;
    search.value = "";
    resetFilter();
    detail.value = null;
    dragOffset.value = 0;
    pressEnd();
  },
);
</script>

<template>
  <transition name="sheet">
    <div v-if="open" class="sheet-backdrop" @click.self="$emit('close')">
      <section
        class="vault-sheet"
        :style="{ transform: `translateY(${dragOffset}px)` }"
        role="dialog"
        aria-modal="true"
        aria-label="提示词预设库"
      >
        <div
          class="sheet-handle"
          @pointerdown="onHandleDown"
          @pointermove="onHandleMove"
          @pointerup="onHandleUp"
          @pointercancel="onHandleUp"
        >
          <span></span>
        </div>

        <header class="sheet-head">
          <div class="sheet-title">
            <span class="eyebrow">PROMPT VAULT</span>
            <strong>提示词预设库</strong>
          </div>
          <button class="sheet-close" type="button" aria-label="关闭预设库" @click="$emit('close')">✕</button>
        </header>

        <div class="sheet-search">
          <input v-model="search" type="search" autocomplete="off" placeholder="搜索预设词条、组合名称..." />
        </div>

        <div class="sheet-chips">
          <button type="button" :class="{ active: !categoryId && !collectionId }" @click="resetFilter">全部</button>
          <button
            v-for="collection in collections"
            :key="collection.id"
            type="button"
            :class="{ active: collectionId === collection.id }"
            @click="pickCollection(collection.id)"
          >
            ⭐ {{ collection.name }}
          </button>
          <button
            v-for="category in categories"
            :key="category.id"
            type="button"
            :class="{ active: categoryId === category.id }"
            @click="pickCategory(category.id)"
          >
            {{ category.name }}
          </button>
        </div>

        <div class="sheet-body">
          <p v-if="empty" class="sheet-hint">
            还没读到预设库。{{ status === "error" ? "请确认 Prompt-Vault 已加载。" : "" }}
            <button type="button" @click="$emit('reload')">重试</button>
          </p>

          <template v-else>
            <section v-if="groups.length" class="sheet-section">
              <h3>📦 预设组合 <span class="count-chip">{{ groups.length }}</span></h3>
              <article v-for="group in groups" :key="group.id" class="group-row">
                <div class="group-copy">
                  <strong>{{ group.title }}</strong>
                  <p>{{ groupSummary(group) }}</p>
                </div>
                <button class="group-load" type="button" @click="$emit('load-group', group)">+ 载入</button>
              </article>
            </section>

            <section class="sheet-section">
              <h3>🏷️ 预设词条 <span class="count-chip">{{ entries.length }}</span></h3>
              <div v-if="entries.length" class="entry-grid">
                <button
                  v-for="entry in entries"
                  :key="entry.id"
                  class="entry-chip"
                  type="button"
                  @pointerdown="pressStart(entry)"
                  @pointerup="pressEnd"
                  @pointerleave="pressEnd"
                  @pointercancel="pressEnd"
                  @click="pickEntry(entry)"
                >
                  <span>+ {{ entry.title || entryText(entry) }}</span>
                  <em v-if="entryWeight(entry) !== 1">{{ entryWeight(entry).toFixed(2) }}</em>
                </button>
              </div>
              <p v-else class="sheet-hint">没有匹配的词条。</p>
              <p class="sheet-tip">长按词条可查看缩略图与完整提示词。</p>
            </section>
          </template>
        </div>

        <footer class="sheet-foot">
          <span>{{ mode === "tiles" ? "点按词条加入磁贴" : "点按词条插入到光标位置" }}</span>
          <span v-if="status === 'cached'">本地缓存</span>
          <span v-else-if="status === 'loading'">同步中…</span>
        </footer>

        <div v-if="detail" class="entry-detail" @click.self="detail = null">
          <div class="detail-card">
            <header class="detail-head">
              <div>
                <span class="eyebrow">{{ categoryName(library, detail.categoryId) }}</span>
                <strong>{{ detail.title }}</strong>
              </div>
              <button type="button" aria-label="关闭详情" @click="detail = null">✕</button>
            </header>
            <img
              v-if="detail.previewHash"
              class="detail-thumb"
              :src="thumbnailUrl(detail.previewHash)"
              :alt="detail.title"
            />
            <p class="detail-text">{{ entryText(detail) }}</p>
            <div class="detail-weight">
              <button class="step-button" type="button" @click="nudgeDetail(-0.05)">−0.05</button>
              <span>{{ detailWeight.toFixed(2) }}</span>
              <button class="step-button" type="button" @click="nudgeDetail(0.05)">+0.05</button>
            </div>
            <p class="detail-preview">{{ formatPromptWeight(entryText(detail), detailWeight) }}</p>
            <button class="detail-insert" type="button" @click="insertDetail">{{ modeLabel }}</button>
          </div>
        </div>
      </section>
    </div>
  </transition>
</template>
