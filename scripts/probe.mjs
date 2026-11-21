#!/usr/bin/env node
// 读取视频元数据（不依赖 ffprobe）
import { spawnSync } from 'node:child_process';

export function probe(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  const dur = text.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const vid = text.match(/Stream #0:0.*?,\s*(\d+)x(\d+).*?,\s*([\d.]+) fps/);
  return {
    ok: Boolean(dur && vid),
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null,
    width: vid ? Number(vid[1]) : null,
    height: vid ? Number(vid[2]) : null,
    fps: vid ? Number(vid[3]) : null,
    hasAudio: /Stream #0:1.*Audio/.test(text),
    raw: r.status,
  };
}
