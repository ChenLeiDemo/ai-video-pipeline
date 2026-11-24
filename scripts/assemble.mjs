#!/usr/bin/env node
// 总装：plan 驱动的多片段拼接 → 统一画幅/帧率 → 底噪/淡入淡出 → 响度归一 → EDL
// 用法: node assemble.mjs plan.json [--dry] [--reuse]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { probe } from './probe.mjs';

const FF = process.env.COMFY_FFMPEG
  || 'D:/ComfyUI_windows_portable/python_embeded/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe';

const args = process.argv.slice(2);
const planFile = args.find(a => !a.startsWith('--'));
const DRY = args.includes('--dry');
const REUSE = args.includes('--reuse');
if (!planFile) {
  console.error('用法: node assemble.mjs plan.json [--dry] [--reuse]');
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const fps = plan.output?.fps ?? 24;
const mode = plan.output?.mode ?? 'fit';          // fit | crop | native
const wantW = plan.output?.width ?? 1920;
const wantH = plan.output?.height ?? 1080;
const crf = String(plan.output?.crf ?? 16);
const abr = plan.output?.audioBitrate ?? '320k';
const lead = plan.lead ?? 0;
const fadeSec = plan.fades?.sec ?? 0.125;
const grain = plan.grade?.grain ?? 0;
const vignette = plan.grade?.vignette ?? false;
const lufs = plan.audio?.lufs ?? -14;
const tp = plan.audio?.truePeak ?? -1;
const outFile = plan.output?.file;
if (!outFile) { console.error('plan.output.file 必填'); process.exit(1); }

const build = path.join(path.dirname(outFile), '_build');
fs.mkdirSync(build, { recursive: true });

const run = (a, label) => {
  const r = spawnSync(FF, a, { encoding: 'utf8' });
  if (r.status !== 0) { console.error(`[FAIL] ${label}\n${(r.stderr || '').slice(-1500)}`); process.exit(1); }
};
const tc = f => [Math.floor(f / (fps * 3600)), Math.floor(f / (fps * 60)) % 60, Math.floor(f / fps) % 60, f % fps]
  .map(n => String(n).padStart(2, '0')).join(':');

// 目标画幅
let W = wantW, H = wantH;
if (mode === 'native') {
  const first = probe(FF, plan.clips[0].file);
  W = first.width; H = first.height;
}

const normFilter = (w, h) => {
  const scale = mode === 'native'
    ? `scale=${w}:${h}:flags=lanczos`
    : mode === 'crop'
      ? `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`
      : `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`;
  return `${scale},setsar=1`;
};

const parts = [];
const framesById = new Map();
const timeline = [];
let total = 0;

console.log(`== 总装 ${plan.clips.length} 段 → ${W}x${H} @${fps} (${mode})`);
for (const c of plan.clips) {
  if (!fs.existsSync(c.file)) { console.error('缺片段', c.file); process.exit(1); }
  const src = probe(FF, c.file);
  const framesIn = Math.round(src.duration * fps);
  const frames = framesIn - (c.trimTail ?? 0);
  const dur = frames / fps;
  const dst = path.join(build, `${c.id}.mp4`);
  const fadeIn = c.noFadeIn ? '' : `,afade=t=in:st=0:d=${fadeSec}`;
  const fadeOut = c.noFadeOut ? '' : `,afade=t=out:st=${Math.max(0, dur - fadeSec).toFixed(4)}:d=${fadeSec}`;
  const grade = c.noGrade ? '' : `${grain ? `,noise=alls=${grain}:allf=t+u` : ''}${vignette ? ',vignette=PI/5' : ''}`;
  const blur = c.tailBlurFrames
    ? `,boxblur=12:1:enable='gte(t,${Math.max(0, dur - c.tailBlurFrames / fps).toFixed(4)})'`
    : '';

  timeline.push({ id: c.id, frames, start: total });
  total += frames;

  if (!(REUSE && fs.existsSync(dst))) {
    if (DRY) { console.log(`  [dry] ${c.id} ${framesIn}f → ${frames}f`); }
    else {
      run(['-y', '-hide_banner', '-loglevel', 'error', '-i', c.file,
        '-vf', `trim=start_frame=0:end_frame=${frames},setpts=PTS-STARTPTS,fps=${fps},${normFilter(W, H)}${grade}${blur}`,
        '-af', `atrim=start=0:end=${dur.toFixed(4)},asetpts=PTS-STARTPTS${fadeIn}${fadeOut}`,
        '-r', String(fps), '-c:v', 'libx264', '-crf', crf, '-preset', 'medium', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', abr, '-ar', '48000', '-ac', '2', dst], `normalize ${c.id}`);
    }
  }
  if (fs.existsSync(dst)) framesById.set(c.id, Math.round(probe(FF, dst).duration * fps));
  else framesById.set(c.id, frames);
  parts.push(dst);
}

const leadFrames = Math.round(lead * fps);
const black = path.join(build, 'BLACK.mp4');
if (lead > 0) {
  if (!(REUSE && fs.existsSync(black)) && !DRY) {
    run(['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=${lead}`,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-t', String(lead), '-c:v', 'libx264', '-crf', crf, '-preset', 'medium', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', abr, '-ar', '48000', '-ac', '2', black], 'black lead');
  }
  parts.unshift(black);
}

const totalSec = (total + leadFrames) / fps;
console.log(`  预计 ${totalSec.toFixed(2)}s / ${total + leadFrames} 帧`);
if (DRY) {
  for (const t of timeline) console.log(`  ${t.start + leadFrames}..${t.start + t.frames + leadFrames}  ${t.id}  ${t.frames}f`);
  process.exit(0);
}

// 视频拼接（重编码，保证帧数精确）
const concatV = path.join(build, 'concat_v.mp4');
const inputs = parts.flatMap(p => ['-i', p]);
const vfilter = parts.map((_, i) => `[${i}:v]setpts=PTS-STARTPTS,fps=${fps}[v${i}]`).join(';')
  + ';' + parts.map((_, i) => `[v${i}]`).join('') + `concat=n=${parts.length}:v=1:a=0[v]`;
if (!(REUSE && fs.existsSync(concatV))) {
  run(['-y', '-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', vfilter, '-map', '[v]',
    '-r', String(fps), '-c:v', 'libx264', '-crf', crf, '-preset', 'medium', '-pix_fmt', 'yuv420p', concatV], 'concat video');
}

// 音频拼接
const concatA = path.join(build, 'concat_a.wav');
const afilter = parts.map((_, i) => `[${i}:a]asetpts=PTS-STARTPTS,aresample=48000[a${i}]`).join(';')
  + ';' + parts.map((_, i) => `[a${i}]`).join('') + `concat=n=${parts.length}:v=0:a=1[a]`;
if (!(REUSE && fs.existsSync(concatA))) {
  run(['-y', '-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', afilter, '-map', '[a]',
    '-c:a', 'pcm_s16le', concatA], 'concat audio');
}

// 底噪
const mix = path.join(build, 'mix.wav');
if (plan.audio?.roomTone !== false) {
  const tone = path.join(build, 'room_tone.wav');
  run(['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `anoisesrc=color=brown:sample_rate=48000:amplitude=1:duration=${totalSec.toFixed(3)}`,
    '-f', 'lavfi', '-i', `sine=frequency=50:sample_rate=48000:duration=${totalSec.toFixed(3)}`,
    '-f', 'lavfi', '-i', `sine=frequency=100:sample_rate=48000:duration=${totalSec.toFixed(3)}`,
    '-filter_complex', '[0:a]lowpass=f=350,volume=0.050[n];[1:a]volume=0.010[s1];[2:a]volume=0.004[s2];[n][s1][s2]amix=inputs=3:normalize=0[m]',
    '-map', '[m]', '-c:a', 'pcm_s16le', tone], 'room tone');
  run(['-y', '-hide_banner', '-loglevel', 'error', '-i', concatA, '-i', tone,
    '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0:duration=first,aresample=48000,asetpts=N/SR/TB[a]',
    '-map', '[a]', '-c:a', 'pcm_s16le', mix], 'mix');
} else {
  fs.copyFileSync(concatA, mix);
}

// 响度：增益 → 快速限幅 → 回测；若修正反而更差则回滚
const measure = file => {
  const r = spawnSync(FF, ['-hide_banner', '-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
  const t = `${r.stdout || ''}\n${r.stderr || ''}`;
  return JSON.parse(t.slice(t.lastIndexOf('{'), t.lastIndexOf('}') + 1));
};
const mixM = measure(mix);
// AAC 编码后真峰值会比限幅器高约 0.5 dB，先压低补偿
let limDb = tp - 0.7;
let gain = lufs - Number(mixM.input_i);
const mux = (g, ldB) => run(['-y', '-hide_banner', '-loglevel', 'error', '-i', concatV, '-i', mix,
  '-filter_complex', `[1:a]volume=${g.toFixed(2)}dB,alimiter=limit=${(10 ** (ldB / 20)).toFixed(4)}:level=false:attack=1:release=1,aresample=48000,apad[a]`,
  '-map', '0:v', '-map', '[a]', '-c:v', 'copy',
  '-c:a', 'aac', '-b:a', abr, '-movflags', '+faststart', '-shortest', outFile], 'final mux');
console.log(`  响度 mix I=${mixM.input_i} LUFS → 增益 ${gain.toFixed(2)} dB，限幅 ${limDb.toFixed(1)} dB`);
mux(gain, limDb);
let best = measure(outFile);
let bestGain = gain, bestLim = limDb;

const dI = lufs - Number(best.input_i);
const dTP = Number(best.input_tp) - tp;
if (Math.abs(dI) > 0.5) {
  const g2 = gain + dI;
  const l2 = dTP > 0.05 ? limDb - (dTP + 0.1) : limDb;
  console.log(`  回测 I=${best.input_i} TP=${best.input_tp} → 试修正 ${dI.toFixed(2)} dB / 限幅 ${l2.toFixed(1)} dB`);
  mux(g2, l2);
  const m2 = measure(outFile);
  if (Math.abs(lufs - Number(m2.input_i)) < Math.abs(lufs - Number(best.input_i))) {
    best = m2; bestGain = g2; bestLim = l2;
  } else {
    console.log('  修正后更差，回滚首轮参数（源动态范围大，目标可能不可达）');
    mux(bestGain, bestLim);
    best = measure(outFile);
  }
}
console.log(`  成品 I=${best.input_i} LUFS TP=${best.input_tp} dBTP`);
if (Math.abs(Number(best.input_i) - lufs) > 1) {
  console.log(`  注意：目标 ${lufs} LUFS 未达成。源素材过轻/动态范围过大时，限幅到 ${tp} dBTP 后就压不动了，需先做压缩或重出音频。`);
}

// EDL
if (plan.edl) {
  const edl = [`TITLE: ${plan.output?.title ?? path.basename(outFile)}`, 'FCM: NON-DROP FRAME', ''];
  let rec = 0, idx = 1;
  const push = (name, frames) => {
    edl.push(`${String(idx).padStart(3, '0')}  AX       V     C        ${tc(0)} ${tc(frames)} ${tc(rec)} ${tc(rec + frames)}`);
    edl.push(`* FROM CLIP NAME: ${name}`);
    rec += frames; idx++;
  };
  if (leadFrames) push('BLACK.mp4', leadFrames);
  for (const c of plan.clips) push(`${c.id}.mp4`, framesById.get(c.id));
  fs.writeFileSync(plan.edl, edl.join('\n') + '\n', 'utf8');
  console.log('  EDL', plan.edl);
}

const out = probe(FF, outFile);
console.log(`\n完成 ${path.basename(outFile)} | ${out.width}x${out.height} ${out.duration.toFixed(3)}s ${Math.round(out.duration * fps)}f ${out.hasAudio ? '有音频' : '无音频'}`);
