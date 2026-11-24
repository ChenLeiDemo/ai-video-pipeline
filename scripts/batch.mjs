#!/usr/bin/env node
// 批量执行：按 plan.json 逐镜生成母图与两采视频，支持断点续跑、尾帧接力、产物校验
// 用法: node batch.mjs plan.json [--prefix agent] [--assets DIR] [--base URL] [--timeout 2400] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { probe } from './probe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.COMFY_BASE || 'http://127.0.0.1:8188').replace(/\/$/, '');
const INPUT = process.env.COMFY_INPUT || 'D:/ComfyUI_windows_portable/ComfyUI/input';
const OUTPUT = process.env.COMFY_OUTPUT || 'D:/ComfyUI_windows_portable/ComfyUI/output';
const FF = process.env.COMFY_FFMPEG
  || 'D:/ComfyUI_windows_portable/python_embeded/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe';
const QWEN_SLOT = { 1: ['54', '318'], 2: ['127', '319'], 3: ['129', '320'], 4: ['141', '321'] };
const H3_SLOT = { 1: '24', 2: '15', 3: '123', 4: '130' };
const FORMULA = 'max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17';

const args = process.argv.slice(2);
const planFile = args.find(a => !a.startsWith('--'));
const val = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const has = name => args.includes(name);

const PREFIX = val('--prefix', 'agent');
const ASSETS = val('--assets', process.cwd());
const TIMEOUT = Number(val('--timeout', '2400'));
const FORCE = has('--force');
const LEDGER = path.join(process.cwd(), 'batch_runs.jsonl');

const log = m => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(s);
  fs.appendFileSync(LEDGER, '');
  fs.appendFileSync(path.join(process.cwd(), 'batch.log'), s + '\n');
};

const tpl = {
  qwen: JSON.parse(fs.readFileSync(path.join(HERE, '../templates/qwen_edit.json'), 'utf8')).prompt,
  p2: JSON.parse(fs.readFileSync(path.join(HERE, '../templates/h3_pass2.json'), 'utf8')).prompt,
  moss: JSON.parse(fs.readFileSync(path.join(HERE, '../templates/moss_t2i.json'), 'utf8')).prompt,
};

function buildT2i(job) {
  const g = structuredClone(tpl.moss);
  g['1'].inputs.text = job.t2i.prompt;
  g['13'].inputs.seed = job.t2i.seed ?? job.seed ?? 1;
  g['15'].inputs.width = job.t2i.width ?? 1376;
  g['15'].inputs.height = job.t2i.height ?? 768;
  g['49'].inputs.filename_prefix = `${PREFIX}/${job.id}`;
  return g;
}

let inputList = new Set();
async function loadInputs() {
  const r = await fetch(`${BASE}/object_info/LoadImage`).then(x => x.json());
  const v = (r.LoadImage || r).input.required.image;
  inputList = new Set(Array.isArray(v[0]) ? v[0] : v[1]?.options || []);
}
async function upload(filePath, name) {
  const fd = new FormData();
  fd.append('image', new Blob([fs.readFileSync(filePath)]), name);
  fd.append('type', 'input');
  const res = await fetch(`${BASE}/upload/image`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`上传 ${name} 失败 HTTP ${res.status}`);
  inputList.add(name);
  log(`  上传 ${name}`);
}
function resolveRef(ref) {
  if (path.isAbsolute(ref) && fs.existsSync(ref)) return ref;
  for (const dir of [ASSETS, INPUT]) {
    const p = path.join(dir, ref);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`参考图找不到: ${ref}`);
}
async function ensure(ref) {
  const p = resolveRef(ref);
  const name = path.basename(p);
  if (!(inputList.has(name) && fs.existsSync(path.join(INPUT, name)))) await upload(p, name);
  return name;
}

async function submit(graph) {
  const body = Buffer.from(JSON.stringify({ prompt: graph, client_id: 'pi-batch' }), 'utf8');
  const res = await fetch(`${BASE}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body });
  const data = await res.json();
  if (res.status !== 200) throw new Error(`提交失败 ${res.status}: ${JSON.stringify(data).slice(0, 1200)}`);
  return data.prompt_id;
}

async function wait(id, timeoutSec) {
  const started = Date.now();
  const deadline = started + timeoutSec * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const h = await fetch(`${BASE}/history/${id}`).then(r => r.json());
    const e = h[id];
    if (!e) continue;
    const fail = (e.status?.messages || []).find(m => m[0] === 'execution_error');
    if (fail) throw new Error(`执行失败 ${id}: ${JSON.stringify(fail[1]).slice(0, 1000)}`);
    const files = [];
    for (const [node, out] of Object.entries(e.outputs || {})) {
      for (const list of Object.values(out)) {
        for (const f of list) {
          const sub = f.subfolder ? `${f.subfolder}/` : '';
          files.push({ node, name: f.filename, abs: f.fullpath || `${OUTPUT}/${sub}${f.filename}` });
        }
      }
    }
    return { files, secs: Number(((Date.now() - started) / 1000).toFixed(1)) };
  }
  throw new Error(`超时 ${id}`);
}

function framesFor(seconds) {
  const n = Math.max(5, Math.round(seconds * 24));
  return n + ((5 - (n % 17)) % 17);
}

function buildImage(job) {
  const g = structuredClone(tpl.qwen);
  const refs = job.image.refs;
  if (refs.length < 1 || refs.length > 4) throw new Error(`${job.id}: 母图参考图需 1~4 张`);
  refs.forEach((name, i) => {
    const [load, resize] = QWEN_SLOT[i + 1];
    g[load].inputs.image = name;
    g[resize].inputs['图像'] = [load, 0];
  });
  for (let n = refs.length + 1; n <= 4; n++) {
    const [load, resize] = QWEN_SLOT[n];
    delete g[load];
    delete g[resize];
    delete g['125'].inputs[`image_0${n}`];
  }
  g['83'].inputs.value = job.image.prompt;
  g['67'].inputs.noise_seed = job.image.seed ?? job.seed ?? 1;
  g['125'].inputs.latent_width = job.image.width ?? 1376;
  g['125'].inputs.latent_height = job.image.height ?? 768;
  g['64'].inputs.filename_prefix = `${PREFIX}/${job.id}_KF`;
  return g;
}

function buildVideo(job, refs) {
  const g = structuredClone(tpl.p2);
  if (refs.length < 1 || refs.length > 4) throw new Error(`${job.id}: 视频参考图需 1~4 张`);
  refs.forEach((name, i) => {
    const node = H3_SLOT[i + 1];
    if (!g[node]) g[node] = { class_type: 'LoadImage', inputs: { image: name } };
    else g[node].inputs.image = name;
    g['6'].inputs[`ref_images.ref_image_${i}`] = [node, 0];
  });
  for (let i = refs.length; i < 4; i++) {
    delete g[H3_SLOT[i + 1]];
    delete g['6'].inputs[`ref_images.ref_image_${i}`];
  }
  g['6'].inputs.prompt = job.video.prompt;
  g['17'].inputs.value = job.video.seconds;
  g['12'].inputs.seed = job.video.seed ?? job.seed ?? 1;
  g['40'].inputs.expression = FORMULA;
  g['126'].inputs.filename_prefix = `${PREFIX}/${job.id}_p1`;
  g['114'].inputs.filename_prefix = `${PREFIX}/${job.id}_p2`;
  return g;
}

function pngSize(file) {
  const b = fs.readFileSync(file);
  const i = b.indexOf(Buffer.from('IHDR'));
  return i < 0 ? null : { width: b.readUInt32BE(i + 4), height: b.readUInt32BE(i + 8) };
}

function findExisting(id, kind) {
  const dir = path.join(OUTPUT, PREFIX);
  if (!fs.existsSync(dir)) return null;
  const hit = fs.readdirSync(dir).find(f => f.startsWith(`${id}_${kind}`));
  return hit ? path.join(dir, hit) : null;
}

async function main() {
  if (!planFile) {
    console.error('用法: node batch.mjs plan.json [--prefix agent] [--assets DIR] [--base URL] [--timeout 2400] [--force]');
    return 1;
  }
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  if (!Array.isArray(plan.jobs) || !plan.jobs.length) throw new Error('plan 缺 jobs[]');
  await loadInputs();
  const done = {};
  const report = [];

  for (const job of plan.jobs) {
    if (!job.id) throw new Error('job 缺 id');
    log(`== ${job.id}`);
    const seed = job.seed ?? Number(String(Date.now()).slice(-9));

    // 资产（MOSS 文生图）
    if (job.t2i) {
      const reused = findExisting(job.id, '');
      if (reused && !FORCE) {
        log(`  复用 ${path.basename(reused)}`);
        done[job.id] = { png: reused };
        report.push({ id: job.id, stage: 't2i', file: reused, skipped: true });
        continue;
      }
      const g = buildT2i({ ...job, seed });
      const gp = path.join(process.cwd(), `${job.id}_t2i.json`);
      fs.writeFileSync(gp, JSON.stringify({ prompt: g }, null, 1), 'utf8');
      const chk = spawnSync(process.execPath, [path.join(HERE, 'check_graph.mjs'), gp], { encoding: 'utf8' });
      if (chk.status !== 0) throw new Error(`资产校验失败\n${chk.stdout}${chk.stderr}`);
      const id = await submit(g);
      const r = await wait(id, 600);
      const file = r.files.find(f => /\.png$/i.test(f.name));
      if (!file) throw new Error(`${job.id}: 无 PNG 产物`);
      const size = pngSize(file.abs);
      const wantW = job.t2i.width || 1376;
      const wantH = job.t2i.height || 768;
      if (size && (size.width !== wantW || size.height !== wantH)) {
        throw new Error(`${job.id}: 尺寸 ${size.width}x${size.height} ≠ ${wantW}x${wantH}`);
      }
      done[job.id] = { png: file.abs };
      log(`  资产 ${path.basename(file.abs)} ${size ? size.width + 'x' + size.height : ''} ${r.secs}s`);
      report.push({ id: job.id, stage: 't2i', file: file.abs, secs: r.secs });
      continue;
    }

    // 母图
    let kf = null;
    if (job.image) {
      const reused = findExisting(job.id, 'KF');
      if (reused && !FORCE) {
        const name = `${job.id}_KF.png`;
        if (!(inputList.has(name) && fs.existsSync(path.join(INPUT, name)))) await upload(reused, name);
        kf = name;
        log(`  复用母图 ${path.basename(reused)}`);
      } else {
        for (const r of job.image.refs) await ensure(r);
        const g = buildImage({ ...job, seed });
        const gp = path.join(process.cwd(), `${job.id}_image.json`);
        fs.writeFileSync(gp, JSON.stringify({ prompt: g }, null, 1), 'utf8');
        const chk = spawnSync(process.execPath, [path.join(HERE, 'check_graph.mjs'), gp, '--images', String(job.image.refs.length)], { encoding: 'utf8' });
        if (chk.status !== 0) throw new Error(`母图校验失败\n${chk.stdout}${chk.stderr}`);
        const id = await submit(g);
        const r = await wait(id, 900);
        const file = r.files.find(f => /\.png$/i.test(f.name));
        if (!file) throw new Error(`${job.id}: 母图无 PNG 产物`);
        const size = pngSize(file.abs);
        if (job.image.width && size && size.width !== job.image.width) throw new Error(`${job.id}: 母图宽 ${size.width} ≠ ${job.image.width}`);
        if (job.image.height && size && size.height !== job.image.height) throw new Error(`${job.id}: 母图高 ${size.height} ≠ ${job.image.height}`);
        await upload(file.abs, `${job.id}_KF.png`);
        kf = `${job.id}_KF.png`;
        log(`  母图 ${path.basename(file.abs)} ${size ? size.width + 'x' + size.height : ''} ${r.secs}s`);
        report.push({ id: job.id, stage: 'image', file: file.abs, secs: r.secs });
      }
    }

    // 尾帧
    let tail = null;
    if (job.tail) {
      const src = done[job.tail]?.p2;
      if (!src) throw new Error(`${job.id}: 找不到 ${job.tail} 的成片，请把它排在前面`);
      const out = path.join(process.cwd(), `${job.id}_tail.png`);
      const r = spawnSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-sseof', '-0.3', '-i', src, '-frames:v', '1', out]);
      if (r.status !== 0) throw new Error(`${job.id}: 抽尾帧失败`);
      await upload(out, `${job.id}_tail.png`);
      tail = `${job.id}_tail.png`;
      log(`  尾帧来自 ${job.tail}`);
    }

    // 视频
    if (job.video) {
      const existing = findExisting(job.id, 'p2');
      if (existing && !FORCE) {
        log(`  已完成，跳过（${path.basename(existing)}）`);
        done[job.id] = { p2: existing };
        report.push({ id: job.id, stage: 'video', file: existing, skipped: true });
        continue;
      }
      const refs = [];
      for (const ref of job.video.refs) {
        if (ref === '@kf') {
          if (!kf) throw new Error(`${job.id}: 用了 @kf 但没有生成母图`);
          refs.push(path.basename(kf));
        } else if (ref === '@tail') {
          if (!tail) throw new Error(`${job.id}: 用了 @tail 但没配置 tail`);
          refs.push(tail);
        } else {
          refs.push(await ensure(ref));
        }
      }
      const g = buildVideo({ ...job, seed }, refs);
      const gp = path.join(process.cwd(), `${job.id}_video.json`);
      fs.writeFileSync(gp, JSON.stringify({ prompt: g }, null, 1), 'utf8');
      const chk = spawnSync(process.execPath, [
        path.join(HERE, 'check_graph.mjs'), gp,
        '--pictures', String(refs.length),
        '--frames', String(framesFor(job.video.seconds)),
      ], { encoding: 'utf8' });
      if (chk.status !== 0) throw new Error(`视频校验失败\n${chk.stdout}${chk.stderr}`);
      const id = await submit(g);
      const r = await wait(id, TIMEOUT);
      const p2 = r.files.find(f => f.node === '114');
      const p1 = r.files.find(f => f.node === '126');
      if (!p2) throw new Error(`${job.id}: 缺二采产物`);
      const meta = probe(FF, p2.abs);
      const wantFrames = framesFor(job.video.seconds);
      if (!meta.hasAudio) throw new Error(`${job.id}: 成片无音轨`);
      if (Math.abs(meta.duration - wantFrames / 24) > 0.05) {
        throw new Error(`${job.id}: 时长 ${meta.duration}s ≠ ${(wantFrames / 24).toFixed(3)}s`);
      }
      done[job.id] = { p1: p1?.abs, p2: p2.abs };
      log(`  成片 ${path.basename(p2.abs)} ${meta.width}x${meta.height} ${meta.duration}s ${r.secs}s`);
      report.push({ id: job.id, stage: 'video', p1: p1?.abs, p2: p2.abs, secs: r.secs, meta });
    }
  }

  fs.writeFileSync(path.join(process.cwd(), 'batch_report.json'), JSON.stringify({ report, done }, null, 1), 'utf8');
  log('全部完成');
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(e => {
  log(`中止: ${e.message}`);
  process.exitCode = 1;
});
