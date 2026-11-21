#!/usr/bin/env node
// 提交前校验：占位符、节点类、必填、连线、参考图数量、帧数、分块、输出前缀
// 用法: node check_graph.mjs <graph.json> [--frames N] [--images N] [--pictures N]
//        [--base http://127.0.0.1:8188] [--allow-default-prefix]
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const val = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const has = name => args.includes(name);

async function main() {
  if (!file) {
    console.error('用法: node check_graph.mjs <graph.json> [--frames N] [--images N] [--pictures N] [--base URL]');
    return 1;
  }

  const base = val('--base', 'http://127.0.0.1:8188').replace(/\/$/, '');
  const errors = [];
  const warnings = [];
  const err = m => errors.push(m);
  const warn = m => warnings.push(m);

  const raw = fs.readFileSync(file, 'utf8');
  if (raw.includes('REPLACE_WITH')) err('还有 REPLACE_WITH_* 占位符');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { console.error('JSON 解析失败:', e.message); return 1; }
  const g = parsed.prompt && typeof parsed.prompt === 'object' ? parsed.prompt : parsed;

  const res = await fetch(`${base}/object_info`);
  if (!res.ok) { console.error('无法读取 /object_info，ComfyUI 没开或地址不对:', res.status); return 2; }
  const oi = await res.json();

  // 1. 节点类 / 必填 / 连线
  for (const [id, n] of Object.entries(g)) {
    const def = oi[n.class_type];
    if (!def) { err(`${id}: 未知节点类 ${n.class_type}`); continue; }
    const req = Object.keys((def.input || {}).required || {});
    const have = new Set(Object.keys(n.inputs || {}));
    for (const k of req) {
      if (!have.has(k) && ![...have].some(h => h.startsWith(`${k}.`))) err(`${id}.${k} 必填缺失`);
    }
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (Array.isArray(v) && typeof v[0] === 'string' && !g[v[0]]) err(`${id}.${k} 指向不存在的节点 ${v[0]}`);
    }
  }

  // 2. 输入文件
  const listFor = cls => {
    const inp = oi[cls]?.input?.required || {};
    for (const v of Object.values(inp)) {
      if (Array.isArray(v[0])) return v[0];
      if (v[0] === 'COMBO' && v[1]?.options) return v[1].options;
    }
    return [];
  };
  const imageList = new Set(listFor('LoadImage'));
  for (const [id, n] of Object.entries(g)) {
    if (n.class_type === 'LoadImage' && !imageList.has(n.inputs?.image)) {
      err(`${id}: input 目录没有 ${n.inputs?.image}（先 POST /upload/image 或复制到 ComfyUI-Shared\\input）`);
    }
  }

  // 3. 参考图数量 vs 提示词里的 <imageN> / <Picture N>
  const prompt = g['6']?.inputs?.prompt ?? g['83']?.inputs?.value ?? '';
  const maxTag = re => {
    const m = [...String(prompt).matchAll(re)].map(x => Number(x[1]));
    return m.length ? Math.max(...m) : 0;
  };

  if (g['125']?.class_type === 'TextEncodeQwenImage21GH') {
    const wired = Object.keys(g['125'].inputs || {}).filter(k => /^image_\d\d$/.test(k)).length;
    const tagged = maxTag(/<image(\d+)>/g);
    if (wired === 0) warn('125 没有接任何参考图，会退化成文生图');
    if (wired !== tagged && !raw.includes('REPLACE_WITH')) err(`生图参考图数量不一致：已接 ${wired} 张，提示词里最大 <image${tagged}>`);
    const expect = val('--images', null);
    if (expect && Number(expect) !== wired) err(`预期参考图 ${expect} 张，实际接 ${wired} 张`);
  }

  if (g['6']) {
    const wired = Object.keys(g['6'].inputs || {}).filter(k => k.startsWith('ref_images.ref_image_')).length;
    const tagged = maxTag(/<Picture\s*(\d+)>/g);
    if (wired !== tagged && !raw.includes('REPLACE_WITH')) err(`视频参考图数量不一致：已接 ${wired} 张，提示词里最大 <Picture ${tagged}>`);
    const expect = val('--pictures', null);
    if (expect && Number(expect) !== wired) err(`预期 Picture ${expect} 张，实际接 ${wired} 张`);
    if (g['6'].inputs?.ref_image_size === 'max') warn('ref_image_size=max 会慢数倍，除非有明确理由');
  }

  // 4. 帧数与分块
  const formula = 'max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17';
  if (g['17'] && g['40']) {
    const sec = Number(g['17'].inputs?.value);
    const n = Math.max(5, Math.round(sec * 24));
    const frames = n + ((5 - (n % 17)) % 17);
    if (g['40'].inputs?.expression !== formula) warn('40 的公式被改过，帧数不再受 17k+5 保护');
    const expect = val('--frames', null);
    if (expect && Number(expect) !== frames) err(`预期 ${expect} 帧，按 17.value=${sec} 实得 ${frames} 帧`);
    if (frames > 192 && !g['98']) err(`${frames} 帧但缺 98（时间分块），二采大概率 OOM`);
    if (frames > 192 && g['98'] && Number(g['98'].inputs?.chunk_length) > 153) {
      warn(`chunk_length=${g['98'].inputs?.chunk_length}，8GB 建议保持 153 或更低`);
    }
  }

  // 5. 输出前缀
  const defaults = new Set(['agent_test/KF', 'agent_test/P1', 'agent_test/P2']);
  for (const [id, n] of Object.entries(g)) {
    if (n.class_type !== 'SaveImage' && n.class_type !== 'VHS_VideoCombine') continue;
    const p = n.inputs?.filename_prefix;
    if (!p) err(`${id} 没有 filename_prefix`);
    else if (defaults.has(p) && !has('--allow-default-prefix')) warn(`${id} 还是模板默认前缀 ${p}`);
  }

  for (const w of warnings) console.log('WARN', w);
  for (const e of errors) console.log('ERROR', e);
  console.log(errors.length ? `\n未通过（${errors.length} 个错误）` : `\n通过（${warnings.length} 个警告）`);
  return errors.length ? 1 : 0;
}

process.exitCode = await main();
