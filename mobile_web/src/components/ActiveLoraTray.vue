<script setup>
import { computed } from "vue";
import { LORA_MAX, LORA_MIN, LORA_STEP, clampStrength, formatStrength } from "../integrations/loraManager.js";

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
});

const emit = defineEmits(["update:modelValue"]);

const entries = computed(() => props.modelValue || []);

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
        <span class="lora-name">🏷️ {{ entry.name }}</span>
        <span class="lora-value">{{ formatStrength(entry.strength) }}</span>
      </header>

      <div class="lora-meta">
        <button class="lora-switch" :class="{ on: entry.active }" type="button" @click="toggle(index)">
          {{ entry.active ? "🟢 已启用" : "⚪ 已静音" }}
        </button>
        <button class="lora-remove" type="button" @click="remove(index)">🗑️ 删除</button>
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
      这个工作流还没挂载 LoRA。打开资源库挑选后，列表会自动同步到这里。
    </p>
  </div>
</template>
