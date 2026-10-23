<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  downloadGalleryItem,
  downloadGalleryZip,
  formatBytes,
  gallery,
  galleryBytes,
} from "../galleryStore.js";
import AppIcon from "./AppIcon.vue";

const props = defineProps({
  open: { type: Boolean, default: false },
});

const emit = defineEmits(["update:open", "insert-prompt"]);

const batchMode = ref(false);
const selectedKeys = ref(new Set());
const downloadingZip = ref(false);
const error = ref("");
const lightboxItem = ref(null);
const copySuccess = ref(false);
let copyTimer = null;
let errorTimer = null;

const items = computed(() => gallery.items);
const count = computed(() => items.value.length);
const totalBytes = computed(() => galleryBytes(items.value));
const selectedItems = computed(() => items.value.filter((item) => selectedKeys.value.has(item.id)));
const allSelected = computed(() => count.value > 0 && selectedKeys.value.size === count.value);

function isSelected(item) {
  return selectedKeys.value.has(item.id);
}

function reportError(message) {
  error.value = message;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    error.value = "";
  }, 3200);
}

function close() {
  emit("update:open", false);
  lightboxItem.value = null;
  batchMode.value = false;
  selectedKeys.value.clear();
}

function toggleBatch() {
  batchMode.value = !batchMode.value;
  if (!batchMode.value) selectedKeys.value.clear();
  lightboxItem.value = null;
}

function toggleSelect(item) {
  const next = new Set(selectedKeys.value);
  if (next.has(item.id)) next.delete(item.id);
  else next.add(item.id);
  selectedKeys.value = next;
}

function selectAll() {
  selectedKeys.value = allSelected.value ? new Set() : new Set(items.value.map((item) => item.id));
}

function onItemClick(item) {
  if (batchMode.value) toggleSelect(item);
  else lightboxItem.value = item;
}

function itemDate(value) {
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

async function handleDownloadItem(item) {
  try {
    downloadGalleryItem(item);
  } catch {
    reportError("单张下载失败，请重试");
  }
}

async function handleDownloadZip(list) {
  if (downloadingZip.value) return;
  downloadingZip.value = true;
  error.value = "";
  try {
    await downloadGalleryZip(list);
  } catch (err) {
    reportError(err?.message || "打包下载失败");
  } finally {
    downloadingZip.value = false;
  }
}

async function handleCopyPrompt(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copySuccess.value = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copySuccess.value = false;
    }, 1800);
  } catch {
    reportError("复制失败，请手动长按复制");
  }
}

function handleInsertPrompt(text) {
  if (!text) return;
  emit("insert-prompt", text);
  close();
}

watch(
  () => props.open,
  (value) => {
    if (!value) {
      batchMode.value = false;
      selectedKeys.value.clear();
      lightboxItem.value = null;
    }
  },
);

onBeforeUnmount(() => {
  clearTimeout(copyTimer);
  clearTimeout(errorTimer);
});
</script>

<template>
  <Teleport to="body">
    <transition name="sheet">
      <div v-if="open" class="sheet-backdrop gallery-backdrop" @click.self="close">
        <section class="gallery-sheet" role="dialog" aria-modal="true" aria-label="本次生成图库">
          <header class="sheet-head gallery-head">
            <div class="sheet-title">
              <span class="eyebrow">SESSION GALLERY</span>
              <strong>
                本次生成
                <small v-if="count">（{{ count }} 张）</small>
              </strong>
            </div>
            <div class="gallery-head-actions">
              <button
                class="gallery-action-btn"
                :class="{ active: batchMode }"
                :disabled="!count"
                type="button"
                :title="batchMode ? '退出多选' : '批量选择'"
                @click="toggleBatch"
              >
                <AppIcon :name="batchMode ? 'check' : 'tiles'" :size="14" />
                <span>{{ batchMode ? "完成" : "多选" }}</span>
              </button>
              <button class="sheet-close" type="button" aria-label="关闭图库" @click="close">
                <AppIcon name="close" :size="15" />
              </button>
            </div>
          </header>

          <div class="gallery-memory-note">
            <AppIcon name="shield" :size="13" />
            <span>只存在于当前页面内存 · 不读取服务器图库 · 刷新或关闭即销毁</span>
          </div>

          <div class="gallery-body">
            <div v-if="!count" class="gallery-hint">
              <span class="gallery-hint-icon"><AppIcon name="image" :size="24" /></span>
              <strong>还没有本次生成的图片</strong>
              <p>生成完成后会自动暂存在这里，刷新或关闭页面即清空。</p>
            </div>

            <div v-else class="gallery-grid">
              <article
                v-for="item in items"
                :key="item.id"
                class="gallery-item-card"
                :class="{ selected: isSelected(item) }"
                @click="onItemClick(item)"
              >
                <div class="gallery-thumb-wrapper">
                  <img :src="item.url" :alt="item.filename" loading="lazy" draggable="false" />
                  <div v-if="batchMode" class="gallery-checkbox" :class="{ checked: isSelected(item) }">
                    <AppIcon v-if="isSelected(item)" name="check" :size="12" />
                  </div>
                  <span v-if="item.width && item.height" class="gallery-res-badge">
                    {{ item.width }}×{{ item.height }}
                  </span>
                </div>
                <div class="gallery-card-info">
                  <span class="gallery-item-name" :title="item.originalFilename">{{ item.originalFilename }}</span>
                  <span class="gallery-item-date">{{ itemDate(item.at) }} · {{ formatBytes(item.bytes) }}</span>
                </div>
              </article>
            </div>
          </div>

          <footer class="gallery-foot">
            <div v-if="batchMode && count" class="gallery-batch-toolbar">
              <button class="batch-select-all" type="button" @click="selectAll">
                {{ allSelected ? "取消全选" : "全选" }}
              </button>
              <div class="batch-summary">已选 <strong>{{ selectedItems.length }}</strong> 张</div>
              <button
                class="batch-download-btn"
                :disabled="!selectedItems.length || downloadingZip"
                type="button"
                @click="handleDownloadZip(selectedItems)"
              >
                <AppIcon name="download" :size="14" />
                <span>{{ downloadingZip ? "打包中…" : "打包下载 (.ZIP)" }}</span>
              </button>
            </div>

            <div v-else class="gallery-pagination-bar">
              <div class="session-summary">
                <strong>{{ count }}</strong> 张
                <span v-if="count">· {{ formatBytes(totalBytes) }}</span>
              </div>
              <button
                class="page-pack-btn"
                :disabled="!count || downloadingZip"
                type="button"
                @click="handleDownloadZip(items)"
              >
                <AppIcon name="download" :size="13" />
                <span>{{ downloadingZip ? "打包中…" : "全部打包" }}</span>
              </button>
            </div>
            <p v-if="error" class="gallery-error" role="alert">{{ error }}</p>
          </footer>

          <transition name="fade">
            <div v-if="lightboxItem" class="lightbox-overlay" @click.self="lightboxItem = null">
              <div class="lightbox-card">
                <header class="lightbox-head">
                  <span class="lightbox-filename">{{ lightboxItem.originalFilename }}</span>
                  <button class="lightbox-close" type="button" aria-label="关闭详情" @click="lightboxItem = null">
                    <AppIcon name="close" :size="16" />
                  </button>
                </header>

                <div class="lightbox-media">
                  <img :src="lightboxItem.url" :alt="lightboxItem.originalFilename" />
                </div>

                <div class="lightbox-details">
                  <div class="lightbox-meta-row">
                    <span v-if="lightboxItem.width && lightboxItem.height">
                      {{ lightboxItem.width }} × {{ lightboxItem.height }} px
                    </span>
                    <span>{{ formatBytes(lightboxItem.bytes) }}</span>
                    <span>{{ itemDate(lightboxItem.at) }}</span>
                  </div>

                  <div v-if="lightboxItem.prompt" class="lightbox-prompt-box">
                    <div class="lightbox-prompt-head">
                      <strong>本次生成提示词</strong>
                      <div class="lightbox-prompt-btns">
                        <button type="button" @click="handleCopyPrompt(lightboxItem.prompt)">
                          <AppIcon name="copy" :size="12" />
                          <span>{{ copySuccess ? "已复制" : "复制" }}</span>
                        </button>
                        <button type="button" @click="handleInsertPrompt(lightboxItem.prompt)">
                          <AppIcon name="plus" :size="12" />
                          <span>填入提示词</span>
                        </button>
                      </div>
                    </div>
                    <p class="lightbox-prompt-text">{{ lightboxItem.prompt }}</p>
                  </div>

                  <div class="lightbox-actions">
                    <button class="lightbox-btn primary" type="button" @click="handleDownloadItem(lightboxItem)">
                      <AppIcon name="download" :size="15" />
                      <span>下载单张图片</span>
                    </button>
                    <a :href="lightboxItem.url" target="_blank" rel="noopener" class="lightbox-btn secondary">
                      <AppIcon name="external" :size="14" />
                      <span>在新标签打开</span>
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </transition>
        </section>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.gallery-backdrop {
  z-index: 900;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.gallery-sheet {
  width: 100%;
  max-width: 760px;
  height: 90vh;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  border-radius: 20px 20px 0 0;
  background: var(--panel);
  border: 1px solid var(--line-strong);
  border-bottom: none;
  overflow: hidden;
  box-shadow: 0 -10px 40px var(--shadow-3);
}

.gallery-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--line);
}

.gallery-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.gallery-action-btn {
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 4px;
  padding: 0 11px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: rgba(var(--surface-rgb), 0.04);
  color: var(--text);
  font-size: 11px;
  font-weight: 600;
  transition: border-color 150ms ease, background 150ms ease, color 150ms ease;
}

.gallery-action-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.gallery-action-btn.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.gallery-memory-note {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-soft);
  color: var(--muted);
  font-size: 10px;
  line-height: 1.4;
}

.gallery-memory-note svg {
  flex: 0 0 auto;
  color: var(--accent);
}

.gallery-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 14px 16px;
  -webkit-overflow-scrolling: touch;
}

.gallery-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 260px;
  gap: 7px;
  color: var(--muted);
  text-align: center;
}

.gallery-hint-icon {
  display: grid;
  width: 54px;
  height: 54px;
  margin-bottom: 5px;
  place-items: center;
  border: 1px dashed var(--line-strong);
  border-radius: 16px;
  background: rgba(var(--surface-rgb), 0.03);
  color: var(--faint);
}

.gallery-hint strong {
  color: var(--text);
  font-size: 13px;
  font-weight: 650;
}

.gallery-hint p {
  max-width: 270px;
  margin: 0;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.6;
}

.gallery-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 12px;
}

@media (min-width: 520px) {
  .gallery-grid {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 14px;
  }
}

.gallery-item-card {
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  overflow: hidden;
  border: 1.5px solid var(--line);
  background: var(--panel-soft);
  cursor: pointer;
  transition: border-color 150ms ease, box-shadow 150ms ease, transform 150ms ease;
  user-select: none;
}

.gallery-item-card:active {
  transform: scale(0.97);
}

.gallery-item-card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.gallery-thumb-wrapper {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  background: var(--media-bg);
  overflow: hidden;
}

.gallery-thumb-wrapper img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.gallery-checkbox {
  position: absolute;
  top: 6px;
  left: 6px;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 2px solid rgba(255, 255, 255, 0.72);
  background: rgba(0, 0, 0, 0.36);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  transition: all 120ms ease;
}

.gallery-checkbox.checked {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}

.gallery-res-badge {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  color: rgba(255, 255, 255, 0.88);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.gallery-card-info {
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.gallery-item-name {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gallery-item-date {
  font-size: 10px;
  color: var(--muted);
}

.gallery-foot {
  flex: 0 0 auto;
  padding: 12px 18px calc(12px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--line);
  background: var(--panel-soft);
}

.gallery-pagination-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.session-summary {
  color: var(--muted);
  font-size: 11.5px;
}

.session-summary strong {
  color: var(--text);
  font-size: 13px;
  font-weight: 700;
}

.page-pack-btn {
  display: inline-flex;
  height: 32px;
  align-items: center;
  gap: 5px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: rgba(var(--surface-rgb), 0.04);
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 600;
}

.page-pack-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.gallery-batch-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.batch-select-all {
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: rgba(var(--surface-rgb), 0.04);
  color: var(--text);
  font-size: 11.5px;
  font-weight: 600;
}

.batch-summary {
  font-size: 11.5px;
  color: var(--muted);
}

.batch-summary strong {
  color: var(--accent);
  font-size: 14px;
}

.batch-download-btn {
  display: inline-flex;
  height: 34px;
  align-items: center;
  gap: 6px;
  padding: 0 14px;
  border: none;
  border-radius: 999px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
  transition: opacity 150ms ease;
}

.batch-download-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.gallery-error {
  margin: 9px 0 0;
  color: var(--danger);
  font-size: 10.5px;
  text-align: center;
}

/* 详情大图灯箱 */
.lightbox-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: var(--lightbox-bg);
  backdrop-filter: blur(8px);
}

.lightbox-card {
  width: 100%;
  max-width: 600px;
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line-strong);
  border-radius: 18px;
  overflow: hidden;
  box-shadow: 0 20px 50px var(--shadow-4);
}

.lightbox-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-soft);
}

.lightbox-filename {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lightbox-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: rgba(var(--surface-rgb), 0.08);
  color: var(--text);
  cursor: pointer;
}

.lightbox-media {
  flex: 1 1 auto;
  max-height: 52vh;
  background: var(--lightbox-media-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.lightbox-media img {
  max-width: 100%;
  max-height: 52vh;
  object-fit: contain;
}

.lightbox-details {
  flex: 0 0 auto;
  padding: 14px 16px;
  overflow-y: auto;
  max-height: 35vh;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.lightbox-meta-row {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 11px;
  color: var(--muted);
}

.lightbox-prompt-box {
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(var(--surface-rgb), 0.035);
  border: 1px solid var(--line);
}

.lightbox-prompt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.lightbox-prompt-head strong {
  font-size: 11px;
  color: var(--text);
}

.lightbox-prompt-btns {
  display: flex;
  gap: 6px;
}

.lightbox-prompt-btns button {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: rgba(var(--surface-rgb), 0.05);
  color: var(--text);
  font-size: 10.5px;
}

.lightbox-prompt-text {
  font-size: 11.5px;
  color: var(--text);
  line-height: 1.45;
  word-break: break-all;
  max-height: 90px;
  overflow-y: auto;
  margin: 0;
}

.lightbox-actions {
  display: flex;
  gap: 10px;
}

.lightbox-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 12.5px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}

.lightbox-btn.primary {
  border: none;
  background: var(--accent);
  color: var(--on-accent);
}

.lightbox-btn.secondary {
  border: 1px solid var(--line);
  background: rgba(var(--surface-rgb), 0.05);
  color: var(--text);
}
</style>
