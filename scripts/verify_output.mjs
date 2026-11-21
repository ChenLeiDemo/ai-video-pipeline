#!/usr/bin/env node
// 产物校验：时长/帧数/分辨率/音轨
// 用法: node verify_output.mjs <file> [--frames N] [--duration S] [--width W] [--height H] [--audio]
import fs from 'node:fs';
import { probe } from './probe.mjs';

const FF = process.env.COMFY_FFMPEG
  || 'D:/Comfy-Desktop/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const val = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const has = name => args.includes(name);

if (!file || !fs.existsSync(file)) {
  console.error('文件不存在:', file || '(未给)');
  process.exit(1);
}

const p = probe(FF, file);
if (!p.ok) {
  console.error('无法读取视频元数据:', file);
  process.exit(1);
}

const errors = [];
const expectFrames = val('--frames', null);
const expectDur = val('--duration', null);
const expectW = val('--width', null);
const expectH = val('--height', null);

if (expectDur && Math.abs(p.duration - Number(expectDur)) > 0.05) {
  errors.push(`时长 ${p.duration}s ≠ 期望 ${expectDur}s`);
}
if (expectFrames) {
  const frames = Math.round(p.duration * p.fps);
  const want = Number(expectFrames);
  if (Math.abs(frames - want) > 1) errors.push(`帧数 ${frames} ≠ 期望 ${want}`);
}
if (expectW && p.width !== Number(expectW)) errors.push(`宽度 ${p.width} ≠ 期望 ${expectW}`);
if (expectH && p.height !== Number(expectH)) errors.push(`高度 ${p.height} ≠ 期望 ${expectH}`);
if (has('--audio') && !p.hasAudio) errors.push('缺音轨');

const summary = `${p.width}x${p.height} ${p.duration}s ${Math.round(p.duration * p.fps)}f ${p.hasAudio ? '有音频' : '无音频'}`;
if (errors.length) {
  console.log(`FAIL ${file} | ${summary}`);
  for (const e of errors) console.log('  -', e);
  process.exit(1);
}
console.log(`OK ${file} | ${summary}`);
