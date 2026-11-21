---
name: comfyui-drama-pipeline
description: 用本地 ComfyUI 的 REST API 按分镜文档投产 AI 短剧：Qwen-Image-2.1 多参考图生母图，MiniMax H3 一采预览 + 二采高清（含时间分块）。覆盖体检、校验、提交、轮询、质检门禁、抽帧与归档，已在 RTX 5060 8GB 上实测跑通 10.13s / 243 帧全流程。任何能执行 shell 的 agent 可直接使用。
---

# ComfyUI 短剧投产（API 执行版）

驱动本地 ComfyUI 跑两条**已模板化**的 API 图。分镜文档是唯一的内容来源，本技能只管"怎么跑、改哪个字段、怎么验"。

## 0. 五条铁律

1. **只提交 `templates/*.json` 里的 `.prompt`（API 格式）。** 画布 JSON 提交会 HTTP 500，且错误不可读。
2. **JSON 以 UTF-8 文件发送**（用 `scripts/comfy_run.mjs`），提交前先过 `scripts/check_graph.mjs`。
3. **串行**：一次一个 prompt，前一个打印"完成"后再提交下一个。
4. **不改**采样器、CFG、LoRA、模型加载器、分辨率，除非 §6 明确要求。
5. **节点号必须带工作流前缀**：`Qwen/83`、`H3/83`、`Qwen/125`、`H3/125`。两个工作流有 31 个节点号重复，裸写会改错节点。

## 1. 开工体检（失败就停）

```bash
curl -s 127.0.0.1:8188/system_stats            # 有 devices[0]
curl -s 127.0.0.1:8188/queue                   # running / pending 都为空
curl -s 127.0.0.1:8188/object_info/LoadImage   # image 列表里要有模板中的全部文件名
```

- 服务没开：让用户打开 ComfyUI Desktop；命令行启动方式见 `reference/constants.md`。
- 模板里任何 `LoadImage.image` 不在列表 → `POST /upload/image`（`file=…, type=input`）或复制到 `D:\Comfy-Desktop\ComfyUI-Shared\input`。
- 跨工作流（Qwen → H3）前：`POST /free {"unload_models":true,"free_memory":true}`。实测 3.8GB → 6.9GB。
- 已知缺失、不要补：`H3-Licon-VBVR-I2V.safetensors`（模板已剔除依赖它的节点）。

## 2. 每镜执行链（整片按这个顺序走）

对分镜文档里的每个 SEG：

1. 读该段的「第一步」与「第二步」，取三样东西：参考图清单、提示词、秒数。
2. 第一步是**生成母图** → 走 §3；是**资产确认/尾帧抽取** → 跳过生图。
3. 写图 → `check_graph` → `comfy_run` 一采 → 抽帧质检（§7）。
4. 一采不过：只换 `12.seed`，最多 3 次；超限停机并输出归因。
5. 一采过：用**同一个 seed** 走二采（§5）；同一提交跑两采时不必回填。
6. 二采成片质检 → 归档（§8）。
7. 文档写「从某段抽取尾帧」时：从上一段成片抽末帧（`-sseof -0.3`），作为本段 Picture 1；不重新生图。

不要跳步、不要并发、不要为了省时间关掉 `98`。

## 3. 生图（Qwen 母图）

复制 `templates/qwen_edit.json` 到工作目录，只改这几处：

| 字段 | 填什么 |
|---|---|
| `83.value` | 分镜文档「编辑提示词」整段，原样 |
| `54/127/129/141.image` | 文档的 `image_1..4`；**文档用几张就删掉其余 LoadImage + 318..321 + `125.image_0N`** |
| `125.image_01..0N` | 与文档 `<image1..N>` 一一对应，**数量必须相等** |
| `67.noise_seed` | 换卡就换整数 |
| `64.filename_prefix` | `EP01/KF-05A` 之类 |
| `125.latent_width/height` | 默认 1376×768；单图局部修复可用 1024×576 |

```bash
node scripts/check_graph.mjs kf.json --images 4
node scripts/comfy_run.mjs kf.json --timeout 600
```

实测：4 图 1376×768 = 187s；1 图 672×384 = 20s。参考图少于提示词里的 `<imageN>` **不会报错**，会退化成纯文字生成——`check_graph` 就是拦这个。

## 4. 一采（H3 预览）

`templates/h3_pass1.json`，只改：

| 字段 | 填什么 |
|---|---|
| `6.prompt` | 文档「视频生成提示词」整段（含首行 `<Picture 1>…` 或 `subject_definitions:`） |
| `17.value` | 文档秒数原样（5.17 / 8 / 10.13），**不要四舍五入** |
| `12.seed` | 整数，自己生成；不要用 -1 |
| `24/15/123.image` | Picture 1/2/3 对应文件；只用 1 张就删掉 `ref_images.ref_image_1/2` 与对应 LoadImage |
| `126.filename_prefix` | `EP01/SEG05_p1` |

帧数不用算：`40` 的公式自动出 `17k+5`（10.13 → 243）。`6` 的 width/height/length 由连线决定，widget 里的 1344/768 是死值。

```bash
node scripts/check_graph.mjs p1.json --pictures 3 --frames 243
node scripts/comfy_run.mjs p1.json --timeout 900
```

实测：124 帧 95s；243 帧约 180s。

## 5. 二采（高清成片）

`templates/h3_pass2.json`：一次提交跑完一采 + 二采，`126` 与 `114` 两个 VHS 都写文件。

- **帧数 > 192 必须保留 `98`**（时间分块 153/17）。243 帧分 2 块采样；二采阶段实测最低只剩 970MB，关掉后大概率 OOM。
- **分两次跑时**，`12.seed` 必须回填上一采成功的值，否则二采重算的 latent 不同、成片会变。
- `151=2` 是二采倍数；`118` 里显示的 1.5 被连线覆盖，不要改。
- 二采 sigmas 用 `338`（原工作流子图「二采步数选择」的 4 步预设），不是数字步数，也没有 Node 5496 可改。

```bash
node scripts/check_graph.mjs final.json --pictures 3 --frames 243
node scripts/comfy_run.mjs final.json --timeout 1800
```

实测：243 帧全流程 682s，成片 1216×704、24fps、h264+aac。

## 6. 需要改分辨率时

- 换算：`8.megapixels=0.2` → 608×352；×2 → 1216×704。
- 要文档里的 1344×768：`8.megapixels ≈ 0.26`（672×384）。同时把 `98.chunk_length` 从 153 降到 121。
- 其它分辨率相关字段不要动。

## 7. 质检门禁

判定顺序固定，不要先看"好不好看"：

1. **把提示词拆成可核对项**：场景与机位/景别、主体数量与左右站位、每个人物的面部/发型/服装/标志物、道具的位置与朝向、光色与时间、构图留白与裁切。
2. **逐项判定**，只写"符合"或"偏离（差在哪）"，不写形容词。
3. 提示词里写到的每一条都要能在图里找到对应，没做到即不合格，与画质无关。
4. 技术缺陷（多指、悬空手、面部崩解、画面内文字糊化）另列，一并计入不合格。
5. 结果按 `段号 | 项目 | 符合/偏离 | 差异` 记到 ledger 旁边；重抽只改 seed，提示词结构问题才改词。

- **生图**：以提示词为唯一基准；最多 4 次。超限停机出归因：是提示词歧义就改词，是参考图不足就补图，不要盲目加抽。
- **一采**：抽 1fps 网格 + 切点前后 0.2s。先核动作/走位/台词口型是否按提示词发生，再看手部完整度、面部崩解、画外人声错嘴。最多 3 次。
- **二采**：只在一采确认后跑；二采继承一采 latent，不能当新抽卡用。

抽帧（系统 PATH 里没有 ffmpeg）：

```bash
FF="D:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\.venv\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v9.0.2.exe"
"$FF" -ss 5.2 -i in.mp4 -frames:v 1 shot.png      # 单帧
"$FF" -sseof -0.2 -i in.mp4 -frames:v 1 tail.png  # 尾帧
```

## 8. 归档

- 产物路径取 `comfy_run.mjs` 打印的 fullpath（或 `GET /history/<id>`）。
- 命名：`<集>_<段>_KF-<号>.png`、`<集>_<段>_p1_seed<seed>.mp4`、`<集>_<段>_final.mp4`。
- 每次运行自动记账到 `comfy_runs.jsonl`（cwd），含 prompt_id、耗时、seed、产物。

整片拼接（可选，段间编码一致，直接流复制）：

```bash
FF="D:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\.venv\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v9.0.2.exe"
cd "D:/Comfy-Desktop/ComfyUI-Shared/output/EP01"
for f in SEG-0[1-9]_p2_00001-audio.mp4 SEG-1*_p2_00001-audio.mp4; do echo "file '$f'"; done > list.txt   # 必须用相对路径：Windows 版 ffmpeg 不认 /d/... 的 MSYS 路径
"$FF" -f concat -safe 0 -i list.txt -c copy EP01_full.mp4
```

POST-01 是后期合成镜（裂屏手机 + 微信 UI），不参与 concat，需在剪映/AE 叠加。

## 9. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 400 + `node_errors` | LoadImage/VHS 指向的文件不在 input | 上传或复制，再提交 |
| 500 `Server got itself in trouble` | 提交了画布 JSON，或中文未按 UTF-8 发送 | 用模板 + runner |
| `execution_error` / OOM | >192 帧没带 `98`，或调高了分辨率 | 恢复 `98`、降 `chunk_length`、`/free` |
| 出图像纯文字生成 | `<imageN>` 多于实际连线 | 补齐 `image_0N` 或删掉多余引用 |
| 成片时长不对 | 秒数被四舍五入（5.2 → 141 帧） | 传文档原值（5.17 → 124 帧） |

## 10. 不要做的

- 不要提交 UI 画布 JSON，不要试图"点开关"。
- 不要加回 `5507 Power Lora Loader`（依赖缺失 LoRA）。
- Qwen：不要碰 `34/35`（提示词优化器，与主链无关）、不要改 `354/355/356` 三个 LoRA。
- 不要给 `12` 填 -1：API 只认字面值，随机由 agent 自己生成。

## 11. 给其它 agent 的接入说明

- **技能根目录** = 本 SKILL.md 所在目录。下面的 `templates/`、`scripts/`、`reference/` 都相对它。
- 依赖：Node ≥ 18（`node` 在 PATH 即可），无需 npm install。没有 Node 就用 `curl --data-binary @body.json` 手工提交，但 UTF-8 与轮询要自己实现。
- ComfyUI 不在本机：所有命令加 `--base http://<host>:8188`（服务端需 `--listen`）。
- 素材必须在 ComfyUI 的 input 目录：`cp <项目>/assets/SC-01.png "$COMFY_INPUT/"`，或 `POST /upload/image`。
- 分镜文档由调用方指定（示例：`<项目>/v3.x_EPxx_场面调度_剧本与投产分镜.md`）；换集只换这一个路径。
- 机器相关路径、启动命令、实测常量都在 `reference/constants.md`，换机器只改那一处。
- 路径用环境变量覆盖，不改代码：`COMFY_BASE`、`COMFY_INPUT`、`COMFY_OUTPUT`、`COMFY_FFMPEG`（默认值见 `reference/constants.md`）。
- 自检：`node scripts/check_graph.mjs templates/h3_pass2.json` 应当**失败**（`REPLACE_WITH_PROMPT`），失败即说明脚本在工作。

## 12. 批量与校验（多镜时用）

`scripts/batch.mjs` 用一份外部 plan 跑整批：断点续跑、尾帧接力、产物校验都内置。**plan 由 agent 读文档后生成**，不写进代码，所以换集只改 plan。

```json
{"jobs":[{
  "id": "EP01_SEG05",
  "seed": 20261121805,
  "image": {"prompt": "…", "refs": ["SC-01.png","CH-01.png"], "width": 1376, "height": 768},
  "video": {"prompt": "…", "seconds": 10.13, "refs": ["@kf","CH-01.png","CH-05A.png"]},
  "tail": "EP01_SEG07"
}]}
```

- `@kf` = 本镜刚生成的母图；`@tail` = `tail` 指定那段的末帧。其余 refs 是文件名（在 `--assets` 或 input 里找）或绝对路径。
- 已有 `<prefix>/<id>_p2_*` 就跳过，`--force` 才重跑。
- 母图校验尺寸，成片校验音轨/时长/帧数，不达标立即中止，不会笑着产出废片。

```bash
node scripts/batch.mjs plan.json --assets "D:/ai video/assets" --prefix EP01
```

单文件校验：

```bash
node scripts/verify_output.mjs out.mp4 --frames 243 --audio --width 1216 --height 704
```

## 文件地图

- `templates/qwen_edit.json` — 24 节点，4 参考图编辑
- `templates/h3_pass1.json` — 25 节点，一采
- `templates/h3_pass2.json` — 36 节点，一采 + 二采（含分块）
- `scripts/check_graph.mjs` — 提交前校验（占位符/类/必填/连线/参考图数/帧数/分块/前缀）
- `scripts/comfy_run.mjs` — 提交/轮询/报错/记账
- `scripts/verify_output.mjs` — 产物校验（帧数/时长/分辨率/音轨）
- `scripts/batch.mjs` — 批量执行（plan 驱动、断点续跑、尾帧接力）
- `scripts/probe.mjs` — ffmpeg 元数据读取（被上面两个脚本引用）
- `reference/nodes.md` — 节点对照与消歧
- `reference/constants.md` — 路径、启动命令、实测耗时与错误原文
