# 节点对照与消歧

两个工作流有 **31 个重复节点号**。任何一条指令都必须写成 `Qwen/83` 或 `H3/83`。

## 号重复且含义完全不同（最危险）

| 节点 | Qwen 工作流 | H3 工作流 |
|---|---|---|
| 6 | SetNode（无线变量） | MiniMaxH3ReferenceToVideo（提示词入口） |
| 17 | CFGGuider | PrimitiveFloat（时长秒数） |
| 24 | SamplerCustomAdvanced | 加载图像1（Picture 1） |
| 35 | ComfySwitchNode（提示词优化器开关，值 true=自动） | Fast Groups Bypasser【参考】总开关（Node 36 标题「关了变文生」） |
| 83 | **PrimitiveStringMultiline（提示词输入）** | **VAEDecodeAudio（音频解码）** |
| 125 | **TextEncodeQwenImage21GH（图像条件）** | **ModelAttentionBackend（注意力后端）** |
| 129 | LoadImage（参考图3） | ModelPreviewOverrideKJ（采样预览） |
| 130 | SetNode | LoadImage（加载图像4） |
| 139 | SetNode | Fast Bypasser「图片 忽略节点」 |
| 141 | LoadImage（参考图4） | Fast Bypasser「视频 忽略节点」 |
| 156 | **忽略多组孤海（参考数量开关）** | **MiniMaxH3SigmaShift** |

## Qwen 工作流（`YZ金鱼-Qwen_image_2.1-超强多合一.json`）

模板 `qwen_edit.json` 保留的节点：

| 节点 | 类型 | 作用 |
|---|---|---|
| 1 / 2 / 3 | UNETLoader / CLIPLoader / VAELoader | qwen-image-2.1-turbo-int8 + qwen3vl_8b + vae |
| 339 | QwenImage21Cache | 模型缓存 |
| 354 / 355 / 356 | LoraLoaderModelOnly | 一致性 0.5 / bfs_head 1.0 / bfs_body_swap 1.0（串联，mode 0） |
| 54 / 127 / 129 / 141 | LoadImage | 参考图 1~4（137/138 是第 5、6 槽，按需补） |
| 318~321 | 图像缩放范围孤海 | 长边限制 2048 / 32 对齐 |
| 83 | PrimitiveStringMultiline | 提示词输入 |
| 125 | TextEncodeQwenImage21GH | `image_01..10` 插槽、prompt、latent 尺寸 |
| 62 | CFGGuider | cfg 1.3 |
| 67 | RandomNoise | 种子（换卡只改这里） |
| 60 / 68 | KSamplerSelect / ManualSigmas | euler_ancestral，9 步 sigma 串 |
| 70 / 69 / 64 | SamplerCustomAdvanced / VAEDecode / SaveImage | 采样、解码、保存 |

**模板里被丢弃的节点**：`126/128/130/132/139/140/143`（SetNode 无线变量，API 不可用）、`133/144~148`（GetNode）、`122`（GoohaiRatioAndResolution，API 中直接用字面量宽高）、`124`（GoohaiRouteBlocker，遮罩阻断）、`9/16/15/22/60(文生图分支)` 等 bypass 分支、`284 LayerUtility: ColorImage`（该节点类未安装，已 bypass）、`Reroute/Note/孤海注释`（前端节点）。

参考图数量规则：`<imageN>` 有几个，就保留几条 `LoadImage → 图像缩放 → 125.image_0N`，其余整条删掉。

## H3 工作流（`up自用低配二采v1.5 minimax h3工作流.json`）

模板保留：

| 节点 | 类型 | 作用 |
|---|---|---|
| 18 / 19 / 26 | CLIPLoader / VAELoader×2 | qwen3vl_32b + audio vae + video vae |
| 20 | UNETLoader | DasiwaMinimaxH3_dasiwaHybridV2_int8 |
| 125 → 156 → 5504 → 21 | 注意力 / SigmaShift / BlockSparse / ref2v LoRA | 模型链（22 Sage 已 bypass） |
| 24 / 15 / 123 | LoadImage | Picture 1 / 2 / 3 |
| 8 | ResolutionSelector | 16:9, 0.2MP, 32 |
| 17 → 40 | PrimitiveFloat → ComfyMathExpression | 秒数 → `17k+5` 帧数 |
| 6 | MiniMaxH3ReferenceToVideo | prompt、width/height/length、`ref_images.ref_image_0..N` |
| 12 → 11 | Seed (rgthree) → RandomNoise | 种子（只改 12） |
| 10 / 5515 / 119 / 14 / 7 | 采样链 | res_multistep、8 步、simple |
| 5 / 128 / 126 | VAEDecode / VAEDecodeAudio / VHS | 一采输出 `minimax_一采_` |
| 90 / 151 / 118 / 106 / 98 | 分离 / 倍数 / 3D 放大 / 合并 / 分块 | 二采前置 |
| 110 / 338 / 113 | 负条件 / 4步 sigma / MMH3UltimateUpscale | 二采采样 |
| 83 / 107 / 114 | 音频解码 / 视频解码 / VHS | 二采输出 `minimax_二采_` |

**模板里被丢弃的节点**：

- `5507 Power Lora Loader`：引用的 `H3-Licon-VBVR-I2V.safetensors` 不存在，每次静默跳过。加回来只会让日志变脏。
- `129 ModelPreviewOverrideKJ`：仅采样预览，且依赖 `taeh3.safetensors`。
- `5503/5497 VRAM_Debug`：bypass；需要清显存用 `POST /free`。
- `120 VRGDG_VideoCompareSlider`、`42 MarkdownNote`、`36/131/145/146/151/152/16/9` 等 Label。
- `135 VHS_LoadVideo` / `27/41/134 LoadAudio`：R2V 的视频/音频参考通道，EP01 未用；需要时按同一模式加 `ref_videos.ref_video_0`、`ref_audios.ref_audio_0`。
- `5496 子图`：二采 sigma 预设，API 里展开为 `ManualSigmas 337/338/339/5502`，模板取 338。

## 原工作流的开关点（仅用于理解，不要操作）

| 开关 | 位置 | 实际含义 |
|---|---|---|
| 参考数量（图片） | `139` Fast Bypasser 每行 | 每个 `加载图像N` 的独立 bypass |
| 参考总开关 | `35` Fast Groups Bypasser（匹配「参考」） | 整组忽略 → 变文生 |
| 音频 / 视频通道 | `140` / `141` Fast Bypasser | 对应 `27/41/134` / `135` |
| 二采 | `158` Fast Groups Bypasser（匹配「二」） | 忽略整组 = 只跑一采 |
| 时间分块 | `142` → `98` | 二采采样分块 |
| 种子 | `12` | 值为 -1 时由前端随机，API 只认字面值 |

## MOSS 文生图（`YZ金鱼-MOSS-文生图.json`）

模板 `moss_t2i.json` 保留的节点：

| 节点 | 类型 | 作用 |
|---|---|---|
| 7 | CLIPLoader | `qwen3.5_9b_int8_convrot`，type=`moss_image` |
| 1 / 3 | CLIPTextEncode | 正向 / 负向提示词 |
| 12 → 18 → 19 | UNETLoader → LoRA（观澜 0.9）→ SkipLayerGuidance（single 22 层） | 模型链 |
| 15 | EmptyFlux2LatentImage | 1376×768 出图尺寸 |
| 13 | KSampler | er_sde / 30 步 / cfg 3.5 / simple |
| 2 / 4 | VAELoader(flux2-vae) / VAEDecode | 解码 |
| 49 | SaveImage | 产物 |

**剔除的节点**：SeedVR2 放大分支（55~65，另一个模型，需单独跑）、`78 easy cleanGpuUsed`（纯清理）、`88/92` 提示词中转（API 里把 88 的文本直接写进节点 1）、`98 忽略多组孤海`、`68 Reroute`、`82/93` 注释。

注意：MOSS 的提示词节点是 **1**，与 Qwen 工作流的 83、H3 的 6 不同，别混。

