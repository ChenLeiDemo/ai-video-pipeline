# comfyui-drama-pipeline

把 AI 短剧分镜文档变成 ComfyUI 可执行任务：**Qwen-Image-2.1 多参考图生母图** + **MiniMax H3 一采预览 / 二采高清**（含时间分块），面向 agent 自动化而不是手动点画布。

- **纯 REST API**：只提交 API 格式图；GUI 画布 JSON 提交会 500。
- **模板化**：`templates/` 三个可直接提交的图，每步只改 4–6 个字段。
- **两道门禁**：`check_graph` 提交前拦占位符/缺图/参考图数不符/帧数不符/缺分块；`verify_output` 事后验帧数、时长、分辨率、音轨。
- **可批量**：`batch.mjs` 用外部 plan 跑整批，断点续跑、尾帧接力、逐镜校验。
- **实测环境**：RTX 5060 Laptop 8GB / ComfyUI 0.46.2，10.13s（243 帧）两采全流程 682s，无 OOM。

## 要求

- ComfyUI 0.46.x（依赖动态显存换页），Node ≥ 18。
- 节点包：Goohaitools、VRGDG（MiniMax H3 相关）、VideoHelperSuite。完整依赖看 `templates/*.json` 里的 `class_type`。
- 模型：见模板中的 `UNETLoader / CLIPLoader / VAELoader / LoraLoaderModelOnly` 字段（qwen-image-2.1、minimax_h3 系列）。
- ffmpeg：用 `imageio_ffmpeg` 自带的二进制（默认路径见 `reference/constants.md`），系统 PATH 里通常没有。

## 快速开始

```bash
# 1. 服务与素材
curl -s 127.0.0.1:8188/system_stats
cp SC-01.png "$COMFY_INPUT/"            # 或 POST /upload/image

# 2. 复制模板，改提示词/参考图/秒数/seed
cp templates/h3_pass2.json my_shot.json

# 3. 校验 → 提交 → 等结果
node scripts/check_graph.mjs my_shot.json --pictures 3 --frames 243
node scripts/comfy_run.mjs my_shot.json --timeout 1800

# 4. 验产物
node scripts/verify_output.mjs out.mp4 --frames 243 --audio --width 1216 --height 704
```

批量：

```bash
node scripts/batch.mjs plan.json --assets ./assets --prefix EP01
```

`plan.json` 示例见 `examples/plan.example.json`：支持 `@kf`（本镜母图）与 `@tail`（指定段的末帧）占位符。

## 目录

| 路径 | 说明 |
|---|---|
| `SKILL.md` | 执行规范：体检、每镜执行链、字段表、质检门禁、排错 |
| `templates/moss_t2i.json` | 11 节点，MOSS 文生图（角色定妆照 / 场景 / 道具） |
| `templates/qwen_edit.json` | 24 节点，Qwen 多参考图编辑 |
| `templates/h3_pass1.json` | 25 节点，H3 一采 |
| `templates/h3_pass2.json` | 36 节点，一采 + 二采（含时间分块） |
| `scripts/check_graph.mjs` | 提交前校验 |
| `scripts/comfy_run.mjs` | 提交 / 轮询 / 报错 / 记账 |
| `scripts/verify_output.mjs` | 产物校验（帧数/时长/分辨率/音轨） |
| `scripts/batch.mjs` | 批量执行（plan 驱动、断点续跑、尾帧接力） |
| `scripts/assemble.mjs` | 总装：画幅/淡入淡出/底噪/响度归一/EDL |
| `scripts/doctor.mjs` | 环境体检：Node/ffmpeg/节点类/模型 |
| `INSTALL.md` | 新机器安装与验收 |
| `reference/requirements.json` | 节点类与模型清单（doctor 的数据源） |
| `scripts/probe.mjs` | ffmpeg 元数据读取 |
| `reference/nodes.md` | 两个源工作流的节点对照与撞号消歧 |
| `reference/constants.md` | 路径、启动命令、实测耗时、错误原文 |

## 环境变量

| 变量 | 默认 |
|---|---|
| `COMFY_BASE` | `http://127.0.0.1:8188` |
| `COMFY_INPUT` | `D:/Comfy-Desktop/ComfyUI-Shared/input` |
| `COMFY_OUTPUT` | `D:/Comfy-Desktop/ComfyUI-Shared/output` |
| `COMFY_FFMPEG` | `.venv/.../imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe` |

默认值来自作者机器，换机器只改这些变量，不改代码。

## 注意

- 模板里的提示词是 `REPLACE_WITH_PROMPT` 占位符，未填会被 `check_graph` 和 `comfy_run` 拒绝。
- 模板绑定当前模型文件名；换模型要同步改三份模板的加载器字段。
- `reference/nodes.md` 里的节点号对应作者的两个源工作流，仅作排查参考，模板本身不依赖画布文件。
