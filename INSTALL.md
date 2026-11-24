# 安装与验收

新机器上从零装到能跑，按顺序做。**所有“缺什么”的判定以 `scripts/doctor.mjs` 为准**，它读 `reference/requirements.json`。

## 1. ComfyUI

- 版本：0.46.x（模板按这个版本的节点 schema 与动态显存行为验证）。
- Desktop 或 portable 都行；记住它的 `input` / `output` 目录实际路径。

## 2. Node

- ≥ 18（脚本用 ESM + fetch + FormData）。
- 验证：`node -v`。

## 3. 节点包

模板用到 40 个节点类（清单见 `reference/requirements.json` 的 `classes`）。装齐这些包：

| 包 | 提供的类（示例） |
|---|---|
| `comfyui-vrgamedevgirl` | `MiniMaxH3ReferenceToVideo`、`MMH3UltimateUpscale`、`MMH3TemporalSplitParams`、`MinimaxH3LatentUpscaler3D`、`BlockSparseAttention`、`ModelAttentionBackend`、`MiniMaxH3SigmaShift`、`LTXVSeparateAVLatent`、`LTXVConcatAVLatent`、`QwenImage21Cache` |
| `ComfyUI-VideoHelperSuite` | `VHS_VideoCombine` |
| `rgthree-comfy` | `Seed (rgthree)` |
| MiniMax H3 支持包（你装的那个 H3 运行库） | `MiniMaxH3` 模型加载相关 |

核心类（`UNETLoader`、`CLIPLoader`、`VAELoader`、`KSampler`、`SaveImage`、`EmptyFlux2LatentImage`、`SkipLayerGuidanceDiTSimple`…）随 ComfyUI 自带。

装完重启 ComfyUI，跑 `doctor` 看 `缺节点类` 是否为空。

## 4. 模型

按 loader 类型放到对应目录（`models/<type>/`），文件名必须**完全一致**：

| 目录 | 文件 |
|---|---|
| `diffusion_models` | `moss_image_sft_int8_convrot.safetensors`、`qwen-image-2.1-turbo-int8_convrot.safetensors`、`DasiwaMinimaxH3_dasiwaHybridV2_int8.safetensors` |
| `text_encoders` | `qwen3.5_9b_int8_convrot.safetensors`、`qwen3vl_8b_int8_convrot.safetensors`、`qwen3vl_32b_minimax_h3_int8_convrot.safetensors` |
| `vae` | `flux2-vae.safetensors`、`qwen_image_2.1_vae_bf16.safetensors`、`minimax_h3_audio_vae_fp32.safetensors`、`minimax_h3_video_vae_fp16.safetensors` |
| `loras` | `KOOK-MOSS-SFT-观澜.safetensors`、`Qwen2.1 一致性无偏移_GH_V1.0.safetensors`、`Qwen21-bfs_head_v1.1_qwen_2.1.safetensors`、`Qwen21-bfs_body_swap_v1.0_qwen_2.1.safetensors`、`minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors` |
| `latent_upscale_models` | `minimax_h3_latent_upscaler_3d_fp16.safetensors` |

## 5. ffmpeg

用 ComfyUI venv 里的 `imageio_ffmpeg` 自带二进制（系统 PATH 通常没有）：

```
<portable根>/python_embeded/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe
```

没有就 `pip install imageio-ffmpeg`。

## 6. 环境变量

| 变量 | 示例 |
|---|---|
| `COMFY_BASE` | `http://127.0.0.1:8188` |
| `COMFY_INPUT` | `D:/ComfyUI_windows_portable/ComfyUI/input` |
| `COMFY_OUTPUT` | `D:/ComfyUI_windows_portable/ComfyUI/output` |
| `COMFY_FFMPEG` | 上面 ffmpeg 的完整路径 |

不设也能跑，但默认值是作者机器路径。

## 7. 验收

```bash
node scripts/doctor.mjs
```

全 OK 后，用模板自检：

```bash
node scripts/check_graph.mjs templates/h3_pass2.json   # 应失败：REPLACE_WITH_PROMPT
```


自检还会报 `input 目录没有 CH-01.png / KF-04A.jpg / CH-05A.png`——这是**正常**的：模板自带的参考图是示例项目的，新机器 input 里没有。首次真实运行前二选一：

- 把本项目参考图拷进 `COMFY_INPUT`，或
- 直接把模板里的 `LoadImage.image` 换成本项目文件名

（`REPLACE_WITH_PROMPT` 未填这条是硬闸，必须修；参考图缺失按当前任务替换即可。）
失败说明脚本在工作；再拿一个真实小样跑通一次生成，即安装完成。

## 8. 分辨率：别把 720p 硬上 1080p

- 生成端一采 608×352、二采 1216×704（0.2MP ×2）。这是 8GB 卡上的稳态。
- 总装默认 `mode: "fit"`：等比放进 1080p 画布，两侧补黑边，**不裁切、不拉伸**。
- `mode: "crop"` 会填满 1080p 并裁掉约 3% 边缘；`mode: "native"` 保持 1216×704 不放大。
- 从 704p 放大到 1080p **不会增加细节**，只是重采样。要真细节，先跑 SeedVR2（另装模型）再总装，或直接交付 1216×704。

## 9. 常见问题

| 现象 | 原因 |
|---|---|
| `doctor` 报缺节点类 | 节点包没装 / 没重启 |
| `doctor` 报缺模型 | 目录放错（unet 放进了 checkpoints）或文件名不一致 |
| `400 custom_validation_failed` | LoadImage 文件不在 input |
| `500 Server got itself in trouble` | 提交了画布 JSON，或中文未按 UTF-8 发送 |
| 二采 OOM | 帧数 > 192 没带 `98` 分块 |
