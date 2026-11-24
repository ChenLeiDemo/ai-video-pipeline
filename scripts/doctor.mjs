#!/usr/bin/env node
// 环境体检：Node / ffmpeg / ComfyUI / 节点类 / 模型 / 目录
// 用法: node doctor.mjs [--base http://127.0.0.1:8188] [--input DIR] [--output DIR]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = val('--base', process.env.COMFY_BASE || 'http://127.0.0.1:8188').replace(/\/$/, '');
const INPUT = val('--input', process.env.COMFY_INPUT || 'D:/ComfyUI_windows_portable/ComfyUI/input');
const OUTPUT = val('--output', process.env.COMFY_OUTPUT || 'D:/ComfyUI_windows_portable/ComfyUI/output');
const FF = process.env.COMFY_FFMPEG
  || 'D:/ComfyUI_windows_portable/python_embeded/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe';
const req = JSON.parse(fs.readFileSync(path.join(HERE, '../reference/requirements.json'), 'utf8'));

const problems = [];
const warns = [];
const ok = m => console.log('OK  ', m);
const bad = m => { problems.push(m); console.log('FAIL', m); };
const warn = m => { warns.push(m); console.log('WARN', m); };

// Node
const major = Number(process.versions.node.split('.')[0]);
if (major >= 18) ok(`Node ${process.versions.node}`); else bad(`Node ${process.versions.node} < 18`);

// ffmpeg
if (fs.existsSync(FF)) ok(`ffmpeg ${path.basename(FF)}`); else bad(`ffmpeg 不存在: ${FF}（设 COMFY_FFMPEG）`);

// 目录
for (const [name, dir] of [['input', INPUT], ['output', OUTPUT]]) {
  if (fs.existsSync(dir)) ok(`${name} 目录 ${dir}`); else bad(`${name} 目录不存在: ${dir}`);
}

// ComfyUI
let oi = {};
try {
  const s = await fetch(`${BASE}/system_stats`).then(r => r.json());
  const v = s.system?.comfyui_version || '?';
  ok(`ComfyUI ${v} @ ${BASE}`);
  if (req.comfyui_version && !v.startsWith(req.comfyui_version.replace(/\.x$/, ''))) {
    warn(`模板按 ComfyUI ${req.comfyui_version} 验证，当前 ${v}`);
  }
  oi = await fetch(`${BASE}/object_info`).then(r => r.json());
} catch {
  bad(`连不上 ${BASE}/system_stats（ComfyUI 没开？）`);
}

// 节点类
if (Object.keys(oi).length) {
  const missing = req.classes.filter(c => !oi[c]);
  if (missing.length) bad(`缺节点类: ${missing.join(', ')}`);
  else ok(`${req.classes.length} 个节点类齐全`);
}

// 模型
const loaderMap = {
  unet: ['UNETLoader', 'unet_name'],
  clip: ['CLIPLoader', 'clip_name'],
  vae: ['VAELoader', 'vae_name'],
  lora: ['LoraLoaderModelOnly', 'lora_name'],
  upscaler: ['MinimaxH3LatentUpscaler3D', 'model_name'],
};
for (const [group, files] of Object.entries(req.models || {})) {
  const [cls, key] = loaderMap[group] || [];
  if (!cls || !oi[cls]) { warn(`无法校验 ${group}（缺 ${cls}）`); continue; }
  const v = oi[cls].input?.required?.[key];
  const options = Array.isArray(v?.[0]) ? v[0] : v?.[1]?.options || [];
  const missing = files.filter(f => !options.includes(f));
  if (missing.length) bad(`缺模型(${group}): ${missing.join(', ')}`);
  else ok(`${group} 模型 ${files.length} 个齐全`);
}

// 模板占位符自检
const tplDir = path.join(HERE, '../templates');
const tpl = fs.readdirSync(tplDir).filter(f => f.endsWith('.json'));
ok(`模板 ${tpl.length} 份: ${tpl.join(', ')}`);

console.log(`\n${problems.length ? `未通过（${problems.length} 个问题，${warns.length} 个警告）` : `通过（${warns.length} 个警告）`}`);
process.exitCode = problems.length ? 1 : 0;
