<script setup>
import { LORA_LIBRARY_URL } from "../integrations/loraManager.js";

defineProps({
  open: { type: Boolean, default: false },
});

defineEmits(["close"]);
</script>

<template>
  <transition name="frame">
    <div v-if="open" class="frame-backdrop">
      <section class="frame-panel" role="dialog" aria-modal="true" aria-label="LoRA 资源库">
        <header class="frame-head">
          <div class="frame-title">
            <span class="eyebrow">LORA LIBRARY</span>
            <strong>LoRA 资源库</strong>
          </div>
          <button class="frame-close" type="button" @click="$emit('close')">✕ 完成并返回</button>
        </header>
        <iframe class="frame-body" :src="LORA_LIBRARY_URL" title="LoRA 资源库"></iframe>
      </section>
    </div>
  </transition>
</template>
