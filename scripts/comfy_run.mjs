#!/usr/bin/env node
// ComfyUI 提交器：校验占位符 → POST /prompt → 轮询 /history → 打印产物 → 记账
// 用法: node comfy_run.mjs <graph.json> [--base http://127.0.0.1:8188] [--timeout 1800] [--free]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const flag = name => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

async function main() {
  if (!file) {
    console.error('用法: node comfy_run.mjs <graph.json> [--base URL] [--timeout 秒] [--free]');
    return 1;
  }
  const base = opt('--base', 'http://127.0.0.1:8188').replace(/\/$/, '');
  const timeoutMs = Number(opt('--timeout', '1800')) * 1000;
  const raw = fs.readFileSync(file, 'utf8');

  if (raw.includes('REPLACE_WITH')) {
    console.error('拒绝执行：图里还有 REPLACE_WITH_* 占位符，先填提示词。');
    return 1;
  }

  const parsed = JSON.parse(raw);
  const graph = parsed.prompt && typeof parsed.prompt === 'object' ? parsed.prompt : parsed;
  const body = Buffer.from(JSON.stringify({ prompt: graph, client_id: 'pi-comfy' }), 'utf8');

  const call = async (url, init) => {
    const res = await fetch(url, init);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };

  if (flag('--free')) {
    const r = await call(`${base}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
    console.log('free:', r.status);
  }

  const sub = await call(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body,
  });
  if (sub.status !== 200) {
    console.error('提交失败 HTTP', sub.status);
    console.error(JSON.stringify(sub.data, null, 2).slice(0, 4000));
    return 2;
  }
  const id = sub.data.prompt_id;
  console.log('prompt_id:', id, '| number:', sub.data.number);

  const started = Date.now();
  const deadline = started + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const h = await call(`${base}/history/${id}`);
    const entry = h.data && h.data[id];
    if (entry) {
      const msgs = entry.status?.messages || [];
      const failure = msgs.find(m => m[0] === 'execution_error');
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      if (failure) {
        console.error(`失败 (${elapsed}s)`);
        console.error(JSON.stringify(failure[1], null, 2).slice(0, 3000));
        return 3;
      }
      console.log(`完成 (${elapsed}s) 状态: ${entry.status?.status_str}`);
      const outputs = [];
      for (const [node, out] of Object.entries(entry.outputs || {})) {
        for (const list of Object.values(out)) {
          for (const f of list) {
            const sub = f.subfolder ? `${f.subfolder}/` : '';
            const abs = f.fullpath || (process.env.COMFY_OUTPUT ? path.join(process.env.COMFY_OUTPUT, sub, f.filename) : `${sub}${f.filename}`);
            outputs.push({ node, file: abs, meta: f.metadata || null });
          }
        }
      }
      for (const o of outputs) {
        const m = o.meta ? ` ${o.meta.width}x${o.meta.height}${o.meta.frame_count ? ' ' + o.meta.frame_count + 'f' : ''}` : '';
        console.log(`  [${o.node}] ${o.file}${m}`);
      }
      const seed = graph['12']?.inputs?.seed ?? graph['67']?.inputs?.noise_seed ?? null;
      const ledger = path.join(process.cwd(), 'comfy_runs.jsonl');
      fs.appendFileSync(ledger, JSON.stringify({
        at: new Date().toISOString(), template: path.basename(file), prompt_id: id,
        elapsed_s: Number(elapsed), seed, outputs,
      }) + '\n', 'utf8');
      console.log('已记账:', ledger);
      return 0;
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (elapsed - last >= 30) {
      last = elapsed;
      const q = await call(`${base}/queue`);
      const running = (q.data?.queue_running || []).length;
      console.log(`… ${elapsed}s 运行中=${running}`);
    }
  }
  console.error('超时。prompt_id 仍在运行或排队:', id);
  return 4;
}

process.exitCode = await main();
