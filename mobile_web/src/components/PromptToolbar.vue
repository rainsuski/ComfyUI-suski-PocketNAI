<script setup>
import AppIcon from "./AppIcon.vue";

defineProps({
  showVault: { type: Boolean, default: false },
});

defineEmits(["vault", "copy", "clear"]);
</script>

<template>
  <div class="prompt-toolbar">
    <button v-if="showVault" type="button" @click="$emit('vault')">
      <AppIcon name="book" :size="13" />
      <span>预设库</span>
    </button>
    <button type="button" @click="$emit('copy')">
      <AppIcon name="copy" :size="13" />
      <span>复制</span>
    </button>
    <button class="clear-button" type="button" @click="$emit('clear')">
      <AppIcon name="trash" :size="12" />
      <span>清空</span>
    </button>
  </div>
</template>
