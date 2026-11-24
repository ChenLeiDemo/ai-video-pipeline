# 实测常量与错误原文

全部数据来自 2026-11-21 在本机的真实提交，环境：ComfyUI 0.46.2 / Desktop 1.1.10 / torch 2.12.1+cu130 / RTX 5060 Laptop 8124MB / 32GB RAM。

## 耗时

| 任务 | 规模 | 耗时 |
|---|---|---|
| Qwen 单图编辑 | 1 参考图，672×384，9 sigma | 19.7s |
| Qwen 四图合成 | 4 参考图，1376×768，9 sigma | 187.5s（约 18s/步） |
| H3 一采 | 124 帧，608×352，8 步 | 94.9s |
| H3 一采 | 243 帧，608×352，8 步 | 约 180s |
| H3 一采 + 二采 | 243 帧，608×352 → 1216×704 | **682s（11 分 22 秒）** |
| 模型热切换 | Qwen ↔ H3 | 20–40s（staged 重载） |

agent 侧超时建议：生图 600s，一采 900s，二采 1800s。

## 分辨率

- `8.megapixels = 0.2`、16:9、multiple 32 → **608×352**
- `151 = 2`（二采倍数） → **1216×704**
- 要 1344×768：`megapixels ≈ 0.26` → 672×384，×2 才等于 1344×768
- Qwen 母图：1376×768（1MP），单图修复可降到 1024×576

## 帧数

公式（`40` 号节点）：`max(5, round(a*24)) + (5 - (max(5, round(a*24)) % 17)) % 17`

| 输入秒数 | 帧数 | 实际时长 |
|---|---|---|
| 5.17 | 124 | 5.167s |
| 8 | 192 | 8.0s |
| 10.13 | 243 | 10.125s |
| 5.2（被四舍五入的结果） | 141 | 5.875s ← 多出 0.7s |

秒数必须原样传文档里的值，四舍五入会改变成片长度。

## 时间分块（二采）

- `98`：`chunk_length=153`、`temporal_overlap=17`、`anchor_strength=0.99`
- 243 帧 → 采样分 2 块（日志可见两次 4 步，3:08 + 2:09）
- 3D 放大节点自带一层分块：`[MinimaxH3-3D] temporal chunking: T=72 chunks=3 overlap=5`
- 二采阶段显存最低余量 **970MB**；`/free` 后回到 6.9GB
- 全程 **0 次 OOM**（含 243 帧）

## 二采 sigma 预设（原工作流子图「二采步数选择」）

| 子图输出 | 标签 | sigmas |
|---|---|---|
| 337 | 3步 | 0.65, 0.44, 0.21, 0 |
| **338** | **4步（模板使用）** | **0.65, 0.53, 0.33, 0.13, 0** |
| 339 | 5步 | 0.65, 0.54, 0.42, 0.28, 0.13, 0 |
| 5502 | 6步 | 0.65, 0.55, 0.45, 0.34, 0.23, 0.12, 0 |

## 一采 / 二采的关系

- 同一提交内：二采复用一采的 latent（`90 ← 7.denoised_output`），内容天然一致，seed 只影响一采。
- 分两次提交：一采会重算，`12.seed` 必须回填，否则二采内容变化。

## 错误原文对照

| HTTP | 原文 | 原因 |
|---|---|---|
| 400 | `{"error":{"type":"prompt_outputs_failed_validation"},"node_errors":{"54":{... "details":"image - Invalid image file: 椅子2.png"}}}` | input 目录没有该文件 |
| 500 | `Server got itself in trouble` + 日志 `AttributeError: 'str' object has no attribute 'get'`（Goohaitools `展示任意 GH.py` on_prompt） | 提交的是画布 JSON，不是 API 图 |
| 500 | 日志 `UnicodeDecodeError: 'utf-8' codec can't decode byte 0xd2` | 中文被 shell 转成 GBK 发送 |
| 200 但产物缺失 | `Failed to validate prompt for output 114 ... Output will be ignored` | 部分输出校验失败，其余仍会执行 |
| 日志 WARNING | `Lora "H3-Licon-VBVR-I2V.safetensors" not found, skipping` | 该 LoRA 不存在（模板已剔除节点） |
| 日志 WARNING | `lora key not loaded: diffusion_model.transformer_blocks.N.img_mlp.gate_up.lora_A/B.weight` | Qwen 换头/换体 LoRA 与 UC 底模部分键不匹配，属已知情况 |

## 模板与工作流的差异（不要"修回去"）

- 模板不含任何 `SetNode/GetNode/Reroute/Note/Label/Fast Bypasser/忽略多组孤海` —— 这些是前端虚拟节点，API 里不存在。
- 模板不含 `5507 Power Lora Loader`、`129 ModelPreviewOverrideKJ`、`5497 VRAM_Debug`、`120 VideoCompareSlider`。
- `6` 的 `prompt` 前缀（`For the target video, at 0.00 seconds…` 或 `subject_definitions:`）必须整段保留，删掉会失去参考图指令。
- `6` 的 width/height/length widget 值是死值，实际由 `8` 和 `40` 的连线决定。

## 输入目标准路径

`D:\ComfyUI_windows_portable\ComfyUI\input`（LoadImage 只认这里，或 `POST /upload/image` 的返回值）

## 产物路径

- `D:\ComfyUI_windows_portable\ComfyUI\output\<filename_prefix>_00001-audio.mp4`（VHS 会同时写 `-audio.mp4`、无声 `.mp4`、预览 `.png`）
- `GET /history/<prompt_id>` 的 `outputs.*[].fullpath` 是最可靠的取值方式
- 图片（SaveImage）**没有** `fullpath`，只有 `filename` + `subfolder`。设 `COMFY_OUTPUT=D:/ComfyUI_windows_portable/ComfyUI/output`，`comfy_run.mjs` 才会打印绝对路径；否则打印 `subfolder/filename`。

## 本机依赖路径

| 用途 | 路径 |
|---|---|
| Node | `C:\Program Files\nodejs\node.exe`（≥18，脚本用 fetch/ESM） |
| Python（ComfyUI 自带） | `D:\ComfyUI_windows_portable\python_embeded\Scripts\python.exe` |
| ffmpeg | `…\python_embeded\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v9.0.2.exe` |
| 工作流（参考） | `…\ComfyUI\user\default\workflows\` |
| 输入 / 输出 | `D:\ComfyUI_windows_portable\ComfyUI\input` / `…\output` |
| 分镜文档 | `D:\AI短剧《暴雪前七天，我换了铁皮小卖部》\storyboard-baixue-ep01-10.md` |

## 服务启动

双击 `D:\ComfyUI_windows_portable\run_nvidia_gpu.bat`（便携版自带参数，input/output/models 都在 `ComfyUI\` 下，无需额外参数）。

需要命令行时：

```bat
cd /d D:\ComfyUI_windows_portable
python_embeded\python.exe -s ComfyUI\main.py
```

- `python_embeded` 是便携 Python，**没有 venv**，ffmpeg 也在它下面。
- 启动到 `/system_stats` 返回 200 约需 20–40s；默认端口 8188。
- **不要同时跑 Desktop 版与 portable 版**，8188 会冲突。

## 环境变量（覆盖默认值，不改代码）

| 变量 | 默认 | 用途 |
|---|---|---|
| `COMFY_BASE` | `http://127.0.0.1:8188` | 服务地址（远程需 `--listen`） |
| `COMFY_INPUT` | `D:/ComfyUI_windows_portable/ComfyUI/input` | 素材目录 |
| `COMFY_OUTPUT` | `D:/ComfyUI_windows_portable/ComfyUI/output` | 产物根目录（图片没有 fullpath 时靠它拼绝对路径） |
| `COMFY_FFMPEG` | `python_embeded\…\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v9.0.2.exe` | 抽帧与元数据读取 |

## MOSS 文生图

| 项 | 实测值 |
|---|---|
| 分辨率 | 1376×768（16:9，EmptyFlux2Latent 默认）；竖构图 768×1376 |
| 采样 | er_sde / simple / 30 步 / cfg 3.5 / denoise 1 |
| 耗时 | **55s/张**（1376×768，模型已热） |
| 连续出图 | 2 张无 OOM；换尺寸不重建模型 |
| 模型 | `moss_image_sft_int8_convrot` + `qwen3.5_9b_int8_convrot` + `flux2-vae` + LoRA `KOOK-MOSS-SFT-观澜` |
| 身份一致性 | 同角色换装不要重 T2I，改走 Qwen 多图编辑（§4） |
