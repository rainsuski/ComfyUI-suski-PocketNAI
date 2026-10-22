<script setup>
defineProps({
  showVault: { type: Boolean, default: false },
});

defineEmits(["vault", "copy", "clear"]);
</script>

<template>
  <div class="prompt-toolbar">
    <button v-if="showVault" type="button" @click="$emit('vault')">🏛️ 预设库</button>
    <button type="button" @click="$emit('copy')">📋 复制</button>
    <button type="button" @click="$emit('clear')">🧹 清空</button>
  </div>
</template>
