# comfyui-drama-pipeline

用本地 ComfyUI 的 **REST API** 把 AI 短剧从设定文档跑到可审片成片：资产定妆照（MOSS 文生图）→ 关键帧母图（Qwen 多图编辑）→ 分镜视频（MiniMax H3 一采预览 + 二采高清）→ 提交校验 → 批量执行 → 总装（画幅/底噪/响度/EDL）。

面向 agent 自动化，不依赖手动点画布。

## 能力

- **纯 API**：只提交 API 格式图；画布 JSON 提交会 500。
- **四个模板**：`templates/` 里四张可直接提交的图，每步只改 4–6 个字段。
- **两道门禁**：`check_graph` 提交前拦占位符/缺图/参考图数不符/帧数不符/缺分块；`verify_output` 事后验帧数、时长、分辨率、音轨。
- **可批量**：`batch.mjs` 用外部 plan 跑整批，支持 `t2i` / `image` / `video` / `tail`，断点续跑、逐镜校验。
- **可总装**：`assemble.mjs` 按 plan 拼片，统一画幅、尾帧去重、淡入淡出、底噪、响度归一、输出 CMX3600 EDL。
- **可体检**：`doctor.mjs` 一条命令查 Node / ffmpeg / 节点类 / 模型。
- **实测**：RTX 5060 Laptop 8GB / ComfyUI 0.46.2；MOSS 1376×768 = 55s，Qwen 四图 1376×768 = 188s，H3 243 帧两采 = 682s，无 OOM。

## 要求

- ComfyUI 0.46.x，Node ≥ 18。
- 节点包与模型清单：`reference/requirements.json`（`doctor` 读它），安装步骤见 `INSTALL.md`。
- ffmpeg：用 ComfyUI venv 里 `imageio_ffmpeg` 自带二进制（系统 PATH 通常没有）。

## 安装

```bash
# 1. 装 ComfyUI 节点包与模型（见 INSTALL.md）
# 2. 体检
node scripts/doctor.mjs
# 3. 自检：应失败并提示占位符未填
node scripts/check_graph.mjs templates/h3_pass2.json
```

## 快速开始（四条产线）

```bash
# A. 资产定妆照（MOSS 文生图）
cp templates/moss_t2i.json ch01.json      # 改 1.text / 13.seed / 15.width,height / 49.filename_prefix
node scripts/check_graph.mjs ch01.json
node scripts/comfy_run.mjs ch01.json --timeout 300

# B. 关键帧母图（Qwen 多图编辑）
cp templates/qwen_edit.json kf.json       # 改 83.value / 54,127,129,141.image / 125.image_0N / 67.noise_seed
node scripts/check_graph.mjs kf.json --images 4
node scripts/comfy_run.mjs kf.json --timeout 600

# C. 分镜视频（H3 一采 + 二采）
cp templates/h3_pass2.json final.json     # 改 6.prompt / 17.value / 12.seed / 24,15,123.image
node scripts/check_graph.mjs final.json --pictures 3 --frames 243
node scripts/comfy_run.mjs final.json --timeout 1800
node scripts/verify_output.mjs out.mp4 --frames 243 --audio --width 1216 --height 704

# D. 总装
node scripts/assemble.mjs assemble_plan.json --dry   # 先看时间轴
node scripts/assemble.mjs assemble_plan.json         # --reuse 复用已标准化片段
```

批量（资产 → 母图 → 视频 → 尾帧接力）：

```bash
node scripts/batch.mjs plan.json --assets ./assets --prefix EP01
```

`plan.json` 示例见 `examples/plan.example.json`：`t2i` 直接出资产，`image` 出母图，`video` 出成片，`@kf` / `@tail` 引用本镜母图与指定段末帧。

## 分辨率说明

生成端一采 608×352、二采 1216×704。总装三档：

| mode | 行为 | 用途 |
|---|---|---|
| `native` | 保持源码尺寸，不放大 | 交付/送审，最干净 |
| `fit` | 等比放进 1920×1080，补黑边 | 统一工程（默认） |
| `crop` | 填满 1920×1080，裁约 3% 边缘 | 必须满屏 |

704p 放大到 1080p **不会增加细节**。要真细节，先跑 SeedVR2 再总装。

## 环境变量

| 变量 | 默认（作者机器） |
|---|---|
| `COMFY_BASE` | `http://127.0.0.1:8188` |
| `COMFY_INPUT` | `D:/Comfy-Desktop/ComfyUI-Shared/input` |
| `COMFY_OUTPUT` | `D:/Comfy-Desktop/ComfyUI-Shared/output` |
| `COMFY_FFMPEG` | `.venv/.../imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe` |

换机器只改这四个变量，不改代码。

## 目录

| 路径 | 说明 |
|---|---|
| `SKILL.md` | 执行规范：体检、每镜执行链、字段表、质检门禁、总装、排错 |
| `INSTALL.md` | 新机器安装与验收 |
| `templates/moss_t2i.json` | 11 节点，MOSS 文生图（定妆照/场景/道具） |
| `templates/qwen_edit.json` | 24 节点，Qwen 多参考图编辑（母图） |
| `templates/h3_pass1.json` | 25 节点，H3 一采 |
| `templates/h3_pass2.json` | 36 节点，一采 + 二采（含时间分块） |
| `scripts/doctor.mjs` | 环境体检 |
| `scripts/check_graph.mjs` | 提交前校验 |
| `scripts/comfy_run.mjs` | 提交 / 轮询 / 报错 / 记账 |
| `scripts/verify_output.mjs` | 产物校验 |
| `scripts/batch.mjs` | 批量执行（plan 驱动） |
| `scripts/assemble.mjs` | 总装（画幅/底噪/响度/EDL） |
| `scripts/probe.mjs` | ffmpeg 元数据读取 |
| `reference/requirements.json` | 节点类与模型清单（单一事实源） |
| `reference/nodes.md` | 源工作流节点对照与撞号消歧 |
| `reference/constants.md` | 路径、启动命令、实测耗时、错误原文 |
| `examples/plan.example.json` | 批量 plan 示例 |

## 已知限制

- 模板里的提示词是 `REPLACE_WITH_PROMPT` 占位符，未填会被 `check_graph` 和 `comfy_run` 拒绝。
- 模板绑定当前模型文件名；换模型要同步改模板里的加载器字段（`requirements.json` 会提示缺哪个）。
- 台词/音频内容无法自动核验，只能确认有音轨、无明显错嘴。
- 画面内中文小字可能糊化（如「隔离专用梯」），需人工抽帧检查。
- 总装成片可能比理论帧数少 1–2 帧（拼接口取整），EDL 以画面切点为准。
- `reference/nodes.md` 的节点号对应作者的源工作流，仅作排查参考；模板本身不依赖画布文件。
