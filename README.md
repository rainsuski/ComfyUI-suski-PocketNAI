# ComfyUI-suski-PocketNAI

基于「槽位注入」的 ComfyUI 移动端极简控制器。PC 端把工作流里的任意输入控件绑定成槽位，移动端只负责填写这些槽位，然后调用 ComfyUI 原生队列执行。

![移动端预览](docs/preview.png)

## 功能

- PC 画布节点右键菜单：`📱 suski 移动端槽位`
- `SaveImage` / `PreviewImage` 右键：`🎯 设为 suski 主输出`
- 槽位元数据写入工作流 `extra.suski_config`，同时同步到后端内存
- 子图实例上的槽位会展开为内部节点的 `targets`，注入时直接写真实 API Prompt 节点
- 后端深拷贝 API Prompt，覆盖槽位值后交给 `execution.validate_prompt` 和原生队列
- 移动端编辑通过 `/suski/api/apply_slots` 写回 PC 画布；删除 LoRA/磁贴会同步到工作流
- `seed == -1` 在入队前随机化
- 移动端为 Vue 3 + Tailwind CSS + Tribute.js PWA
- Danbooru 词库自动发现，IndexedDB 缓存
- WebSocket 进度、执行错误、输出图片同步
- 图片使用原生 `<img>`，移动端可长按保存
- 可选深度对接 `ComfyUI-Lora-Manager` 与 `ComfyUI-Suski-Prompt-Vault`，插件缺失时相关入口自动隐藏

## 安装

把整个目录放入 `ComfyUI/custom_nodes/`，重启 ComfyUI。`dist/` 已包含构建后的移动端，无需在 ComfyUI 环境里安装 Node 依赖。

局域网访问需要让 ComfyUI 监听外部网卡，例如：

```bash
python main.py --listen 0.0.0.0
```

然后在手机浏览器打开：

```text
http://<PC 的局域网 IP>:8188/suski/
```

## 使用

1. 在 PC 端打开一个工作流。
2. 右键需要交给手机的节点，进入 `📱 suski 移动端槽位`，勾选输入控件。
3. 右键 `SaveImage` 或 `PreviewImage`，选择 `🎯 设为 suski 主输出`。
4. 保存工作流或直接点一次队列，模板会自动同步。
5. 手机打开 `/suski/`，填写提示词和参数，点击「生成」。

槽位绑定会随工作流保存。再次打开工作流时，PC 扩展会重新读取 `extra.suski_config` 并同步给后端。

## 槽位类型

| `type` | 来源 | 移动端控件 |
| --- | --- | --- |
| `prompt` / `negative` / `text` | 任意文本控件 | 多行提示词输入 |
| `seed` / `slider` / `number` / `toggle` / `combo` | 任意参数控件 | 对应参数控件 |
| `lm_loras` | `Lora Loader (LoraManager)` 的 `loras` 控件 | 已挂载 LoRA 托盘 |
| `pv_tiles` | `PromptVaultSelector` 的 `selected_tiles_data` 控件 | 预设磁贴列表 |

`lm_loras` 与 `pv_tiles` 都是对象数组，提交时会转换为节点真正读取的结构：

- `LoraLoaderLM` 在执行阶段丢弃 `text` 控件，只认 `loras` 数组，因此槽位值会整体覆盖
  `loras`，并补上 ComfyUI 序列化数组控件所需的 `{"__value__": [...]}` 包装。
- `selected_tiles_data` 是 JSON 字符串，后端负责序列化，权重与启用状态原样写入磁贴。
- 绑定在子图实例上的槽位会记录 `targets`。例如 `1526/unet_name` 会写成
  `1526:1732/model_name`，执行时只改内部真实节点；子图被删除或输入被连线时，
  PC 端会清理槽位，后端也会跳过失效目标而不是报“节点不存在”。

## 对接 Lora-Manager 与 Prompt-Vault

两个插件都是可选项。移动端通过 `GET /suski/api/integrations` 探测路由是否存在，探测不到就
隐藏对应入口，原生槽位不受影响。

### Lora-Manager

1. 在 PC 端右键 `Lora Loader (LoraManager)`，把 `LoRA 挂载列表` 绑定为槽位。
2. 手机端点 `🌐 打开 LoRA 资源库`，全屏嵌入原生 `/loras` 页面，挑选后「发送到工作流」。
3. Lora-Manager 广播 `lora_code_update`，PC 钩子收到后重新同步模板，手机端自动更新托盘。
4. 托盘里可直接静音、删除、按 `0.05` 步进调权，修改会立即写回 `loras` 数组和 PC 画布。

### Prompt-Vault

1. 提示词输入框上方的 `🏛️ 预设库` 打开底部抽屉，按分类/收藏筛选、搜索、长按查看详情。
2. 点词条按光标位置插入文本，非 1.0 权重会格式化为 `(prompt:weight)`；点组合按顺序展开。
3. `PromptVaultSelector` 的 `selected_tiles_data` 绑定为槽位后，同一抽屉切换为磁贴模式，
   可增删、拖动排序、静音与调权；修改会同步回真实磁贴数据。
4. PC 端保存词库会广播 `prompt_vault:library_updated`，手机端静默刷新 IndexedDB 缓存与列表。

## 词库发现顺序

后端按以下顺序查找第一个有效文件：

1. `custom_nodes/ComfyUI-Custom-Scripts/user/autocomplete/danbooru.csv`
2. `custom_nodes/comfyui-custom-scripts/user/autocomplete/danbooru.csv`
3. `custom_nodes/ComfyUI-Custom-Scripts/web/js/assets/danbooru.csv`
4. `custom_nodes/comfyui-custom-scripts/web/js/assets/danbooru.csv`
5. `custom_nodes/ComfyUI_tagcomplete/tags/danbooru.csv`
6. `custom_nodes/ComfyUI-Autocomplete-Aaalice/data/danbooru_tags.csv`
7. 内置 `backend/assets/danbooru_min.csv`（Top 5000）

## API

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/suski` | GET | 移动端入口 |
| `/suski/api/config` | GET | 当前模板与 `suski_config` |
| `/suski/api/integrations` | GET | 探测 Lora-Manager / Prompt-Vault 是否可用 |
| `/suski/api/sync_template` | POST | 接收 `api_prompt` 与 `suski_config` |
| `/suski/api/tags.csv` | GET | 输出当前词库文件 |
| `/suski/api/apply_slots` | POST | 把移动端编辑写回模板并广播给 PC 画布 |
| `/suski/api/execute` | POST | 注入槽位、校验并入队 |

`POST /suski/api/execute` 的负载：

```json
{
  "client_id": "uuid",
  "slots_data": {
    "6": { "text": "1girl, silver hair" },
    "3": { "seed": -1, "steps": 28 },
    "12": {
      "loras": [
        { "name": "anime_eyes_v1", "strength": 0.85, "clipStrength": 0.85, "active": true }
      ]
    },
    "20": {
      "selected_tiles_data": [
        { "instance_id": "t1", "title": "逆光", "prompt": "backlight", "weight": 1.2, "enabled": true }
      ]
    }
  }
}
```

`/suski/api/apply_slots` 使用同样的 `slots_data` 结构，只更新其中出现的槽位。移动端编辑会以 450ms debounce 写回；后端更新模板后广播 `suski:apply_slots`，PC 端把它写进真实控件并重新同步。PC 端不在线时后端模板仍会更新，下次生成使用该模板；PC 画布与工作流文件要等 PC 打开并同步后才会变化。

## 移动端开发

```bash
cd mobile_web
npm install
npm run build
```

`vite.config.js` 将产物直接写入项目根目录的 `dist/`。开发预览可使用 `npm run dev`，但 `/suski/api/*` 与 `/ws` 需要由 ComfyUI 提供。

## 说明

- PWA 安装与 Service Worker 需要 HTTPS 或 `localhost`。局域网 HTTP 仍可正常使用页面，但浏览器不会提供安装能力。
- 移动端和词库请求只访问本机 ComfyUI，不包含外部网络请求、遥测或统计。
- 当前同一时间只维护一个活动模板；切换工作流后由 PC 端重新同步覆盖。
