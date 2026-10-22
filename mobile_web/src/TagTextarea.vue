<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Tribute from "tributejs";
import "tributejs/dist/tribute.css";
import { formatTagCount } from "./tags.js";

const props = defineProps({
  id: { type: String, default: undefined },
  modelValue: { type: String, default: "" },
  tags: { type: Array, default: () => [] },
  placeholder: { type: String, default: "" },
  minRows: { type: Number, default: 3 },
});

const emit = defineEmits(["update:modelValue"]);
const textarea = ref(null);
let tribute = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function resize() {
  const element = textarea.value;
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${Math.max(element.scrollHeight, props.minRows * 24)}px`;
}

function syncValue() {
  emit("update:modelValue", textarea.value?.value ?? "");
  resize();
}

// 预设库插入走这里：优先落在光标处，并补上缺失的逗号分隔。
// focus=false 用于抽屉开着时的插入，避免手机键盘从遮罩后面弹出来。
function insertAtCursor(text, { focus = true } = {}) {
  const element = textarea.value;
  const snippet = String(text || "").trim();
  if (!snippet) return;
  if (!element) {
    emit("update:modelValue", props.modelValue ? `${props.modelValue}, ${snippet}` : snippet);
    return;
  }
  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? start;
  const before = element.value.slice(0, start);
  const after = element.value.slice(end);
  const prefix = before && !/[\s,([]$/.test(before) ? ", " : "";
  const suffix = after && !/^[\s,)\]]/.test(after) ? ", " : "";
  element.value = `${before}${prefix}${snippet}${suffix}${after}`;
  const caret = (before + prefix + snippet).length;
  if (focus) element.focus();
  element.setSelectionRange(caret, caret);
  syncValue();
}

defineExpose({ insertAtCursor });

function menuItem(item) {
  const tag = escapeHtml(item.string || item.original?.tag || "")
    .replaceAll("\u0001", "<mark>")
    .replaceAll("\u0002", "</mark>");
  const count = formatTagCount(item.original?.count);
  return `<div class="suski-tag-row"><span class="suski-tag-name">${tag}</span>${count ? `<span class="suski-tag-count">${count}</span>` : ""}</div>`;
}

function setValues(tags) {
  if (!tribute) return;
  tribute.collection[0].values = Array.isArray(tags) ? tags : [];
}

onMounted(async () => {
  const element = textarea.value;
  if (!element) return;
  element.value = props.modelValue;
  await nextTick();
  resize();

  tribute = new Tribute({
    autocompleteMode: true,
    values: Array.isArray(props.tags) ? props.tags : [],
    lookup: "tag",
    fillAttr: "tag",
    requireLeadingSpace: false,
    allowSpaces: false,
    menuShowMinLength: 1,
    menuItemLimit: 24,
    replaceTextSuffix: ", ",
    noMatchTemplate: "",
    selectTemplate: (item) => item.original.tag,
    menuItemTemplate: menuItem,
    searchOpts: { pre: "\u0001", post: "\u0002" },
  });
  tribute.attach(element);
  element.addEventListener("tribute-replaced", syncValue);
  window.addEventListener("resize", resize);
});

watch(
  () => props.modelValue,
  (value) => {
    const element = textarea.value;
    if (!element || element.value === (value ?? "")) return;
    element.value = value ?? "";
    resize();
  },
);

watch(
  () => props.tags,
  (tags) => setValues(tags),
);

onBeforeUnmount(() => {
  const element = textarea.value;
  if (tribute && element) {
    element.removeEventListener("tribute-replaced", syncValue);
    tribute.detach(element);
  }
  window.removeEventListener("resize", resize);
  tribute = null;
});

function onInput() {
  syncValue();
}
</script>

<template>
  <textarea
    :id="id"
    ref="textarea"
    class="suski-prompt-input"
    :placeholder="placeholder"
    :rows="minRows"
    spellcheck="false"
    autocapitalize="off"
    autocomplete="off"
    aria-autocomplete="list"
    @input="onInput"
  ></textarea>
</template>
