<script setup>
import { computed } from "vue";
import AppIcon from "./AppIcon.vue";

const props = defineProps({
  open: { type: Boolean, default: false },
  workflows: { type: Array, default: () => [] },
  activeId: { type: String, default: "" },
  activeTitle: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  busyId: { type: String, default: "" },
  error: { type: String, default: "" },
});

const emit = defineEmits(["close", "switch", "refresh"]);

const items = computed(() => (Array.isArray(props.workflows) ? props.workflows : []));
const hasItems = computed(() => items.value.length > 0);

function isActive(item) {
  if (props.activeId && item?.id) return item.id === props.activeId;
  return Boolean(props.activeTitle) && item?.title === props.activeTitle;
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

function pick(item) {
  if (!item?.id || props.busyId) return;
  if (isActive(item)) {
    emit("close");
    return;
  }
  emit("switch", item);
}
</script>

<template>
  <transition name="sheet">
    <div v-if="open" class="sheet-backdrop" @click.self="emit('close')">
      <section class="vault-sheet workflow-sheet" role="dialog" aria-modal="true" aria-label="切换工作流">
        <header class="sheet-head">
          <div class="sheet-title">
            <span class="eyebrow">WORKFLOWS</span>
            <strong>切换工作流</strong>
          </div>
          <button class="sheet-close" type="button" aria-label="关闭工作流列表" @click="emit('close')">
            <AppIcon name="close" :size="14" />
          </button>
        </header>

        <p class="workflow-current">
          <span>当前</span>
          <strong>{{ activeTitle || "尚未同步模板" }}</strong>
        </p>

        <div class="sheet-body">
          <p v-if="loading" class="sheet-hint">正在读取已保存的工作流…</p>

          <p v-else-if="error" class="sheet-hint">
            {{ error }}
            <button type="button" @click="emit('refresh')">重试</button>
          </p>

          <p v-else-if="!hasItems" class="sheet-hint">
            还没有已保存的工作流。在 PC 端保存一次工作流或直接点一次队列，模板会自动落盘到这里。
          </p>

          <div v-else class="workflow-list">
            <button
              v-for="item in items"
              :key="item.id"
              class="workflow-row"
              :class="{ active: isActive(item), busy: busyId === item.id }"
              type="button"
              :disabled="Boolean(busyId)"
              @click="pick(item)"
            >
              <span class="workflow-copy">
                <strong>{{ item.title }}</strong>
                <span class="workflow-meta">
                  {{ item.slots_count }} 个槽位
                  <template v-if="formatTime(item.updated_at)"> · {{ formatTime(item.updated_at) }}</template>
                </span>
              </span>
              <span class="workflow-state">
                <template v-if="busyId === item.id">切换中…</template>
                <template v-else-if="isActive(item)">使用中</template>
                <template v-else>切换</template>
              </span>
            </button>
          </div>
        </div>

        <footer class="sheet-foot">
          <span>切换后手机端立即生效，PC 画布不受影响</span>
          <button v-if="hasItems" type="button" class="sheet-refresh" @click="emit('refresh')">刷新</button>
        </footer>
      </section>
    </div>
  </transition>
</template>
