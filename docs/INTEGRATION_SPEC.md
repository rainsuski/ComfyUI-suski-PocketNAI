# ComfyUI-suski-PocketNAI 深度对接方案规范文档

本文档详细定义 `ComfyUI-suski-PocketNAI` 对接 `ComfyUI-Lora-Manager` 与 `ComfyUI-Suski-Prompt-Vault` 的技术架构、数据流规范与 UI/UX 落地实现方案。

---

## 目录
- [一、总体架构与设计原则](#一总体架构与设计原则)
- [二、需求一：深度对接 ComfyUI-Lora-Manager](#二需求一深度对接-comfyui-lora-manager)
  - [2.1 业务链路与交互模式](#21-业务链路与交互模式)
  - [2.2 数据协议与底层陷阱防范](#22-数据协议与底层陷阱防范)
  - [2.3 PC 端协同改造与热更新感知](#23-pc-端协同改造与热更新感知)
  - [2.4 移动端 UI/UX 实现设计](#24-移动端-uiux-实现设计)
- [三、需求二：深度对接 ComfyUI-Suski-Prompt-Vault](#三需求二深度对接-comfyui-suski-prompt-vault)
  - [3.1 业务链路与交互模式](#31-业务链路与交互模式)
  - [3.2 API 契约与缓存广播机制](#32-api-契约与缓存广播机制)
  - [3.3 移动端双层对接实现模式](#33-移动端双层对接实现模式)
  - [3.4 移动端 UI/UX 实现设计](#34-移动端-uiux-实现设计)
- [四、工程模块划分与实施路径](#四工程模块划分与实施路径)
  - [4.1 前端工程结构推荐](#41-前端工程结构推荐)
  - [4.2 渐进式实施里程碑](#42-渐进式实施里程碑)

---

## 一、总体架构与设计原则

1. **“移动端极简抽卡器”定位**：
   - 移动端坚持轻量、直观、单手可用，绝不复刻桌面端 LiteGraph 画布复杂的连线或深层嵌套交互。
   - `Prompt-Vault` 作为“结构化提示词与预设源”，`Lora-Manager` 作为“模型与风格微调源”，`PocketNAI` 作为“参数收集、槽位注入与执行调度核心”。

2. **渐进增强（Progressive Enhancement）与零强耦合**：
   - PocketNAI 核心保持独立，对两款外部插件采用动态特性探测（Feature Detection）。
   - 环境中未安装目标插件时，隐藏相关入口，完全不影响原生槽位运行；探测到插件时激活高阶快捷操作。

3. **ComfyUI 架构边界隔离规范**：
   - 后端路由与核心执行保持纯粹，无需增加复杂的代理转发，前端直接与 ComfyUI 同源 REST API 及 WebSocket 协同。

---

## 二、需求一：深度对接 ComfyUI-Lora-Manager

### 2.1 业务链路与交互模式
经过对原生操作台及移动端操作可行性的深入评估：
- **选 LoRA（搜库与预览）**：无需在移动端重复编写重型瀑布流组件，直接通过 PocketNAI 的快捷操作入口打开原生 `/loras` 页面（以全屏弹层或沉浸 Webview 模式），直接复用其现成的封面流、Civitai 详情和“发送到工作流”能力。
- **调权与删除（精细控制）**：用户选好 LoRA 返回 PocketNAI 之后，由移动端原生渲染针对移动触控优化的“已挂载 LoRA 托盘”，进行滑块微调、步进修改、一键静音与删除。

```text
[手机端 PocketNAI]
      |
      | 1. 点击 [🌐 挑选 LoRA]
      v
[全屏弹出 原生 /loras 页面] ---> 用户点选并点击 [发送到工作流]
      |                                  |
      | 2. 关闭弹层返回                   | 3. POST /api/lm/update-lora-code
      v                                  v
[手机端实时热更新] <--- WebSocket --- [ComfyUI 后端广播 lora_code_update]
      |                                  |
      | 4. 手机端“活动 LoRA 托盘”           | 4. PC 端 LoraLoader 同步更新
      |    点按调权/静音/删除              
      v                                  
[POST /suski/api/execute 注入最新 loras 结构执行]
```

### 2.2 数据协议与底层陷阱防范
#### 核心底层陷阱（Pitfall）
在 `LoraLoaderLM`（`Lora Loader (LoraManager)`）节点的 Python 源码中：
```python
def load_loras(self, model, text, loras, **kwargs):
    del text  # 关键：后端在执行阶段会彻底丢弃 text 字符串！
    ...
    lora_entries.extend(_collect_widget_entries(loras))  # 真正参与加载计算的仅是 loras 对象结构
```
* **结论**：在移动端如果仅修改字符串格式的 `text` 控件（如 `<lora:name:1.0>`），提交到后端后将完全不生效！
* **解决方案**：PocketNAI 必须将 `loras` 对象数组作为专用槽位类型进行管理与双向绑定。

#### 槽位数据结构规范 (`loras` Slot)
```json
{
  "node_id": "12",
  "field": "loras",
  "label": "LoRA 挂载列表",
  "type": "lm_loras",
  "default_val": [
    {
      "name": "anime_eyes_v1",
      "strength": 0.85,
      "clipStrength": 0.85,
      "active": true
    }
  ]
}
```

### 2.3 PC 端协同改造与热更新感知
在 `web/suski_pc_hook.js` 中增加对 `Lora-Manager` 全局更新事件的监听：
```javascript
// 监听 Lora-Manager 发送到工作流事件，自动触发 PocketNAI 模板与槽位静默同步
api.addEventListener("lora_code_update", () => {
  scheduleSync(300);
});
```
当用户在手机端打开的 `/loras` 点击发送到工作流后，ComfyUI 广播 `lora_code_update`，PC 钩子捕捉后立即执行 `scheduleSync()`，PocketNAI 后端随即向手机推送 `suski:template_synced`，手机端自动重载最新挂载的 LoRA 列表。

### 2.4 移动端 UI/UX 实现设计

#### 1. 顶部操作栏与入口
在提示词或高级参数区域提供快捷入口：
```text
+-------------------------------------------------------+
| ⚡ LoRA 扩展管理              [ 🌐 打开 LoRA 资源库 ] |
+-------------------------------------------------------+
```
点击 `[ 🌐 打开 LoRA 资源库 ]` 升起覆盖全屏的 iframe 抽屉，顶栏提供 `[ ✕ 完成并返回 ]`，内嵌 `/loras` 页面。

#### 2. “已挂载 LoRA 托盘”（Active LoRA Tray）
当检测到工作流中有挂载的 LoRA 时，自动以原生卡片列表展示：
```text
+-------------------------------------------------------+
| 🏷️ 细腻动漫眼神 (anime_eyes_v1)                       |
|    状态: [🟢 已启用]   [🗑️ 删除]                     |
|    权重: 0.85                                         |
|    [ -0.05 ]  ======🔘=============  [ +0.05 ]        |
+-------------------------------------------------------+
| 🏷️ 机械装甲强化 (mecha_armor)                         |
|    状态: [⚪ 已静音]   [🗑️ 删除]                     |
|    权重: 1.00                                         |
|    [ -0.05 ]  =========🔘==========  [ +0.05 ]        |
+-------------------------------------------------------+
```
- **点击静音按钮**：切换 `active: false/true`，置灰卡片。
- **点击步进按钮 / 滑块**：以 `0.05` 精度修改 `strength` 与 `clipStrength`。
- **点击删除按钮**：弹出确认或直接从数组中移除。

---

## 三、需求二：深度对接 ComfyUI-Suski-Prompt-Vault

### 3.1 业务链路与交互模式
`ComfyUI-Suski-Prompt-Vault` 具备标准化的 `library.json` 本地词库规范和分类管理系统。对接 PocketNAI 后，移动端获得强大的**私有化预设库点播能力**。

```text
[PC 端 Prompt-Vault]                  [PocketNAI 移动端]
        |                                     |
        | 1. 编辑并保存预设库                 | 2. 初始化拉取 /prompt_vault/api/library
        v                                     v
[ComfyUI PromptServer]                 [本地 IndexedDB 缓存预设数据]
        |                                     |
        | 3. WebSocket 广播                   | 4. 点击 [🏛️ 预设库] 呼出底部抽屉
        |    "prompt_vault:library_updated"   |    - 切换分类、收藏
        +-----------------------------------> |    - 点按词条即插即用
                                              |    - 一键载入完整组合 (Group)
```

### 3.2 API 契约与缓存广播机制
1. **获取词库**：
   - 接口：`GET /prompt_vault/api/library`
   - 返回标准对象结构：`{ categories, collections, entries, groups }`
2. **缩略图加载**：
   - 接口：`GET /prompt_vault/api/thumbnails/{filename}`
3. **协同监听**：
   - 移动端在 WebSocket 通道上监听 `prompt_vault:library_updated`，一旦 PC 端改动词条并保存入库，移动端静默更新缓存与列表。

### 3.3 移动端双层对接实现模式

#### 模式一：提示词文本上下文直插（通用极简模式）
针对常规的 `CLIPTextEncode` 或文本槽位：
- 点击文本框顶部的 `[ 🏛️ 预设库 ]` 呼出抽屉。
- 单击词条：在光标所在位置插入提示词文本，若带非 1.0 权重自动格式化为 `(prompt:weight)`。
- 单击组合（Group）：自动展开组内所有词条并按顺序拼接入文本末尾。

#### 模式二：`PromptVaultSelector` 节点槽位直连（磁贴控制模式）
当工作流中右键绑定了 `PromptVaultSelector` 的 `selected_tiles_data`：
- PocketNAI 移动端识别到该槽位，将其渲染为一组可拖拽排序和快速开关的“胶囊磁贴”。
- 手机端直接控制每个磁贴的 `enabled` 状态和权重，完全无需手动拼接文字标点。

### 3.4 移动端 UI/UX 实现设计

#### 1. 文本框增强工具栏
```text
+-------------------------------------------------------+
| 📱 正面提示词                                         |
| [ 🏛️ 预设库 ]  [ 📋 复制 ]  [ 🧹 清空 ]                |
|-------------------------------------------------------|
| 1girl, solo, masterpiece...                           |
+-------------------------------------------------------+
```

#### 2. Prompt-Vault 底部升降抽屉（PromptVaultSheet.vue）
高度占据屏幕约 75%，支持触控下滑关闭：
```text
+-------------------------------------------------------+
| ━━━━ (下滑关闭手柄)                                    |
| 🏛️ 提示词预设库                          [ ✕ 关闭 ]   |
| [ 🔍 搜索预设词条、组合名称...                      ] |
| [ 全部 ] [ ⭐ 收藏 ] [ 📦 组合 ] [ 人物 ] [ 场景 ] [ 构图 ] | <- 分类横滑
+-------------------------------------------------------+
| 📦 预设组合 (Groups)                                  |
| +---------------------------------------------------+ |
| | 🌟 唯美逆光胶片质感                      [+ 载入] | |
| | 包含: 黄金时刻, 丁达尔光, 35mm镜头 (3个词条)      | |
| +---------------------------------------------------+ |
|                                                       |
| 🏷️ 预设词条 (Entries)                                 |
| [ + 高清细节 (1.2) ]   [ + 柔和泛光 ]   [ + 水墨意境 ]|
| [ + 胶片颗粒 0.8 ]     [ + 广角张力 ]   [ + 赛博霓虹 ]|
|                                                       |
| (长按词条磁贴可呼出详情卡片，查看缩略图及完整提示词)   |
+-------------------------------------------------------+
```

---

## 四、工程模块划分与实施路径

### 4.1 前端工程结构推荐（位于 `mobile_web/src/`）
```text
mobile_web/src/
├── integrations/
│   ├── loraManager.js       # LoRA 路由探测、参数转换、全屏 iframe 联动
│   └── promptVault.js       # Vault 库拉取、IndexedDB 缓存与 WS 事件监听
├── components/
│   ├── LoraModalFrame.vue   # 原生 /loras 嵌入式全屏浮层
│   ├── ActiveLoraTray.vue   # 已挂载 LoRA 调权、步进、静音与删除托盘
│   ├── PromptVaultSheet.vue # 预设词库分类浏览、搜索与一键插入抽屉
│   └── PromptToolbar.vue    # 提示词槽位顶部的增强快捷操作条
```

### 4.2 渐进式实施里程碑
1. **Milestone 1（协同通道打通）**：
   - 在 `suski_pc_hook.js` 中增加 `lora_code_update` 监听，打通自动热同步机制。
   - 移动端增加对 `prompt_vault:library_updated` 的监听处理。
2. **Milestone 2（Prompt-Vault 移动端抽屉落地）**：
   - 接入 `/prompt_vault/api/library`，实现分类展示与一键插入。
3. **Milestone 3（Lora-Manager 快捷选库与调权托盘落地）**：
   - 接入 `/loras` 原生弹层。
   - 实现移动端“活动 LoRA 托盘”，直接读写 `loras` 槽位对象完成权重调节与删除。
