// app.js — 网页版「格式工厂」主逻辑
// 所有处理调用 ffmpeg.wasm 在浏览器本地完成，文件不上传服务器。
import { preload, runJob, sanitize, triggerDownload, runParallelSegments } from './ffmpeg.js';

const $ = (id) => document.getElementById(id);

/* ---------- 小工具 ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
function extOf(name) { const m = String(name).match(/\.([a-zA-Z0-9]{1,6})$/); return m ? m[1].toLowerCase() : 'bin'; }
async function readBytes(file) { return new Uint8Array(await file.arrayBuffer()); }
function parseTime(str) {
  const s = String(str || '').trim();
  if (!s) return NaN;
  const m = s.match(/^(\d{1,3}):(\d{1,2})(?::?(\d{1,2}))?$/); // 1:30 或 1:30:05
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
  const f = parseFloat(s);
  return isNaN(f) ? NaN : f;
}
const MIME = {
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
  avi: 'video/x-msvideo', gif: 'image/gif', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg',
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp',
};
// ffmpeg 输出容器 → 默认视频/音频编码
const CONT = {
  mp4: { ve: 'libx264', ae: 'aac', flags: '+faststart' },
  webm: { ve: 'libvpx-vp9', ae: 'libopus' },
  mkv: { ve: 'libx264', ae: 'aac' },
  mov: { ve: 'libx264', ae: 'aac', flags: '+faststart' },
  avi: { ve: 'libx264', ae: 'libmp3lame' },
};
const AE_CODEC = { aac: 'aac', 'libmp3lame': 'libmp3lame', libopus: 'libopus', libvorbis: 'libvorbis' };
// 用大白话的「画质」档位映射到底层参数，不向小白暴露 CRF / 码率这些术语
const Q_CRF = { high: '18', mid: '23', low: '28' };    // 视频 CRF：越小越清晰、文件越大
const Q_ABR = { high: '256', mid: '192', low: '128' }; // 音频码率 kb/s：越大越好、文件越大
const Q_IMG = { hi: '2', mid: '6', low: '12' };        // 图片 jpg 质量（2 最好）

// ---------- 简单 / 专家模式（localStorage 记住用户偏好） ----------
let MODE = 'simple';
const FPS_LIST = ['24', '25', '29.94', '30', '50', '59.97', '60', '120', '144'];
// expert=true 时帧率额外提供「原始（不改变）」，默认都是 60
function fpsOpts({ expert }) {
  const items = [];
  if (expert) items.push('<option value="0">原始（不改变）</option>');
  for (const v of FPS_LIST) items.push(`<option value="${v}"${v === '60' ? ' selected' : ''}>${v}</option>`);
  return items.join('');
}
function loadMode() { try { return localStorage.getItem('mediaforge_mode') || 'simple'; } catch { return 'simple'; } }
function saveMode(m) { try { localStorage.setItem('mediaforge_mode', m); } catch { /* 忽略 */ } }
function applyModeButtons() {
  const s = $('mode-simple'), e = $('mode-expert');
  if (s) s.classList.toggle('active', MODE === 'simple');
  if (e) e.classList.toggle('active', MODE === 'expert');
}
function setMode(m) {
  MODE = m; saveMode(m); applyModeButtons();
  renderVideoOpts(); renderAudioOpts(); renderImageOpts(); renderMixOpts();
}

/* ---------- 文件投放区 ---------- */
function createZone(inputId, dropId, listId, multiple = true) {
  const input = $(inputId), drop = $(dropId), list = $(listId);
  const items = [];
  let seq = 0;

  input.addEventListener('change', () => { add(Array.from(input.files)); input.value = ''; });
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragenter', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer) add(Array.from(e.dataTransfer.files)); });

  function add(files) {
    for (const f of files) {
      if (!multiple) items.splice(0);
      items.push({ id: ++seq, file: f, name: f.name, size: f.size });
    }
    render();
  }
  const ico = (t) => t.startsWith('image') ? '🖼️' : t.startsWith('audio') ? '🎵' : '🎬';
  function render() {
    list.innerHTML = items.map((it) => `
      <div class="file-chip">
        <span class="ico">${ico(it.file.type)}</span>
        <span class="name">${escapeHtml(it.name)}</span>
        <span class="size">${fmtSize(it.size)}</span>
        ${multiple ? `<button class="up" data-i="${it.id}" title="上移">↑</button><button class="down" data-i="${it.id}" title="下移">↓</button>` : ''}
        <button class="x" data-i="${it.id}" title="移除">✕</button>
      </div>`).join('');
  }
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    const id = Number(btn.getAttribute('data-i'));
    const idx = items.findIndex((x) => x.id === id); if (idx < 0) return;
    if (btn.classList.contains('x')) { items.splice(idx, 1); }
    else if (btn.classList.contains('up') && idx > 0) { const t = items[idx - 1]; items[idx - 1] = items[idx]; items[idx] = t; }
    else if (btn.classList.contains('down') && idx < items.length - 1) { const t = items[idx + 1]; items[idx + 1] = items[idx]; items[idx] = t; }
    render();
  });
  return {
    list: () => items.slice(),
    count: () => items.length,
    isEmpty: () => items.length === 0,
    clear: () => { items.length = 0; render(); },
    names: () => items.map((x) => x.name),
  };
}

/* ---------- 执行器 ---------- */
// run(tab) 运行时需异步读文件再构建参数，所以 job 由 async 函数生成
function makeRunner(runBtnId, progId, statusId, build) {
  const btn = $(runBtnId), prog = $(progId), status = $(statusId);
  let running = false;
  btn.addEventListener('click', async () => {
    if (running) return;
    running = true; btn.disabled = true; prog.style.width = '0%';
    status.className = 'status'; status.textContent = '准备…';
    try {
      const jobs = await build(); // 返回单个 job 或 job 数组
      const list = Array.isArray(jobs) ? jobs : [jobs];
      let done = 0;
      for (const job of list) {
        if (job && job.segmented) {
          await runParallelSegments(job.segOpts,
            (p) => prog.style.width = Math.round(((done + (p || 0)) / list.length) * 100) + '%',
            (msg) => { status.textContent = msg; });
        } else {
          await runJob(job,
            (p) => prog.style.width = Math.round(((done + p) / list.length) * 100) + '%',
            (msg) => { status.textContent = msg; });
        }
        done++;
        prog.style.width = Math.round((done / list.length) * 100) + '%';
      }
      status.className = 'status done';
      if (list.length > 1) status.textContent = `✅ 全部完成，共 ${list.length} 个文件，已逐个触发下载。`;
    } catch (e) {
      status.className = 'status err';
      status.textContent = '出错：' + e.message;
    } finally {
      running = false; btn.disabled = false;
    }
  });
}
// 单任务跑: 返回 runJob 所需的 job descriptor。确保输出文件名是 ffmpeg 命令的最后一个参数。
function makeJob(files, args, outName, mime, label) {
  const finalArgs = args[args.length - 1] === outName ? args : [...args, outName];
  return { files, args: finalArgs, out: outName, mime, label };
}

/* ================= 视频 ================= */
const vZone = createZone('v-file', 'v-drop', 'v-files', true);
const TASK_LABEL = {
  transcode: '转码 / 压缩 视频', extract: '剥离音频', concat: '拼接视频',
  gif: '视频转 GIF', trim: '截取片段',
};

// 视频功能选项渲染
function renderVideoOpts() {
  const t = $('v-task').value;
  const el = $('v-opts');
  const html = [];
  if (t === 'transcode') {
    if (MODE === 'expert') {
      html.push(`<div class="opt-group"><span class="gtitle">转换后（专家）</span><div class="opt-grid">
        <div class="item"><label>格式</label><select id="v-fmt"><option value="mp4">MP4（通用）</option><option value="webm">WebM</option><option value="mkv">MKV</option><option value="mov">MOV</option><option value="avi">AVI</option></select></div>
        <div class="item"><label>视频编码</label><select id="v-ve"><option value="auto">自动（按格式）</option><option value="libx264">H.264</option><option value="libx265">H.265/HEVC</option><option value="libvpx-vp9">VP9</option><option value="libvpx-vp8">VP8</option></select></div>
        <div class="item"><label>分辨率</label><select id="v-res"><option value="0">原始</option><option value="3840">3840·4K</option><option value="1920">1920·1080</option><option value="1280">1280·720</option><option value="854">854·480</option><option value="640">640·360</option><option value="custom">自定义宽度</option></select></div>
        <div class="item"><label>自定义宽度</label><input id="v-res-c" type="number" value="1280" min="32" step="2"></div>
        <div class="item"><label>帧率</label><select id="v-fps">${fpsOpts({ expert: true })}</select></div>
        <div class="item"><label>多核加速（实验）</label><select id="v-par"><option value="0">关闭（稳）</option><option value="2">2 核更快</option><option value="4">4 核最快</option></select></div>
      </div></div>
      <div class="opt-group"><span class="gtitle">画质</span><div class="opt-grid">
        <div class="item"><label>模式</label><select id="v-qmode"><option value="crf">CRF（推荐）</option><option value="br">恒定码率</option></select></div>
        <div class="item"><label>CRF 值（0-51 越小越清晰）</label><input id="v-crf" type="number" value="23" min="0" max="51"></div>
        <div class="item"><label>码率 kb/s</label><input id="v-br" type="number" value="2000" min="64"></div>
      </div></div>
      <div class="opt-group"><span class="gtitle">音频</span><div class="opt-grid">
        <div class="item"><label>处理</label><select id="v-keep"><option value="keep">保留</option><option value="drop">移除</option><option value="copy">拷原音轨</option></select></div>
        <div class="item"><label>音频编码</label><select id="v-ae"><option value="auto">自动</option><option value="aac">AAC</option><option value="libmp3lame">MP3</option><option value="libopus">Opus</option><option value="libvorbis">Vorbis</option></select></div>
        <div class="item"><label>音频码率 kb/s</label><input id="v-abr" type="number" value="192" min="32"></div>
      </div></div>`);
    } else {
      html.push(`<div class="opt-group"><span class="gtitle">转换后</span><div class="opt-grid">
        <div class="item"><label>格式</label><select id="v-fmt"><option value="mp4">MP4（通用，推荐）</option><option value="webm">WebM</option><option value="mkv">MKV</option><option value="mov">MOV</option><option value="avi">AVI（老格式）</option></select></div>
        <div class="item"><label>画质</label><select id="v-quality"><option value="high">高清（文件大）</option><option value="mid" selected>标准（推荐）</option><option value="low">低清（文件小）</option></select></div>
        <div class="item"><label>分辨率</label><select id="v-res"><option value="0">和原来一样</option><option value="1920">1920×1080（1080P）</option><option value="1280">1280×720（720P）</option><option value="854">854×480（480P）</option><option value="640">640×360（360P）</option></select></div>
        <div class="item"><label>每秒帧数</label><select id="v-fps">${fpsOpts({ expert: false })}</select></div>
      </div></div>
      <div class="opt-group"><span class="gtitle">声音</span><div class="opt-grid">
        <div class="item"><label>声音</label><select id="v-aud"><option value="keep">保留声音</option><option value="drop">不要声音（纯画面）</option></select></div>
      </div></div>`);
    }
  } else if (t === 'extract') {
    if (MODE === 'expert') {
      html.push(`<div class="opt-group"><span class="gtitle">输出音频（专家）</span><div class="opt-grid">
        <div class="item"><label>格式</label><select id="v-afmt"><option value="mp3">MP3</option><option value="m4a">M4A/AAC</option><option value="wav">WAV</option><option value="flac">FLAC</option><option value="ogg">OGG</option><option value="opus">Opus</option></select></div>
        <div class="item"><label>码率 kb/s</label><input id="v-abr" type="number" value="192" min="32"></div>
        <div class="item"><label>采样率 Hz</label><select id="v-ar"><option value="0">原始</option><option value="48000">48000</option><option value="44100">44100</option><option value="22050">22050</option></select></div>
        <div class="item"><label>声道</label><select id="v-ac"><option value="0">原始</option><option value="2">立体声</option><option value="1">单声道</option></select></div>
      </div></div>`);
    } else {
      html.push(`<div class="opt-group"><span class="gtitle">输出音频</span><div class="opt-grid">
        <div class="item"><label>格式</label><select id="v-afmt"><option value="mp3">MP3</option><option value="m4a">M4A/AAC</option><option value="wav">WAV（无损大）</option><option value="flac">FLAC（无损）</option><option value="ogg">OGG</option><option value="opus">Opus</option></select></div>
        <div class="item"><label>音质</label><select id="v-aqual"><option value="high">好（文件大）</option><option value="mid" selected>中等（推荐）</option><option value="low">一般（文件小）</option></select></div>
      </div></div>`);
    }
  } else if (t === 'concat') {
    if (MODE === 'expert') {
      html.push(`<div class="opt-group"><span class="gtitle">拼接方式（专家）</span><div class="opt-grid">
        <div class="item"><label>方式</label><select id="v-concat-method"><option value="reencode">转码拼接</option><option value="copy">快速复制</option></select></div>
        <div class="item"><label>输出格式</label><select id="v-fmt"><option value="mp4">MP4</option><option value="webm">WebM</option><option value="mkv">MKV</option></select></div>
        <div class="item"><label>视频编码</label><select id="v-ve"><option value="libx264">H.264</option><option value="libx265">H.265</option><option value="libvpx-vp9">VP9</option></select></div>
        <div class="item"><label>CRF</label><input id="v-crf" type="number" value="23" min="0" max="51"></div>
        <div class="item"><label>音频编码</label><select id="v-ae"><option value="aac">AAC</option><option value="libopus">Opus</option></select></div>
        <div class="item"><label>音频码率 kb/s</label><input id="v-abr" type="number" value="192" min="32"></div>
      </div></div>
      <div class="tips">拖入 2 个及以上视频，用 ↑↓ 调整顺序。「快速复制」要求各段编码一致。</div>`);
    } else {
      html.push(`<div class="opt-group"><span class="gtitle">拼接方式</span><div class="opt-grid">
        <div class="item"><label>方式</label><select id="v-concat-method"><option value="reencode">转码拼接（推荐，不同片段也行）</option><option value="copy">快速复制（各段编码必须一致）</option></select></div>
        <div class="item"><label>输出格式</label><select id="v-fmt"><option value="mp4">MP4</option><option value="webm">WebM</option><option value="mkv">MKV</option></select></div>
        <div class="item"><label>画质</label><select id="v-quality"><option value="high">高清</option><option value="mid" selected>标准（推荐）</option><option value="low">低清</option></select></div>
      </div></div>
      <div class="tips">拖入 2 个及以上视频，顺序即拼接顺序（用 ↑↓ 调整）。「转码拼接」对不同片段也适用；「快速复制」要求编码一致。</div>`);
    }
  } else if (t === 'gif') {
    html.push(`<div class="opt-group"><span class="gtitle">GIF 参数</span><div class="opt-grid">
      <div class="item"><label>宽度像素</label><input id="v-gif-w" type="number" value="480" min="64" step="16"></div>
      <div class="item"><label>每秒帧数</label><input id="v-gif-fps" type="number" value="10" min="1" max="30"></div>
      <div class="item"><label>颜色</label><select id="v-gif-pal"><option value="1">调色板优化（推荐）</option><option value="0">直接转换（更快但噪点多）</option></select></div>
    </div></div>
    <div class="tips">GIF 是 256 色动图，体积比较大。建议选较短片段、帧数低一点（8~15fps），宽度 320~640 最合适。</div>`);
  } else if (t === 'trim') {
    html.push(`<div class="opt-group"><span class="gtitle">截取范围（秒，支持 1:30 或 90）</span><div class="opt-grid">
      <div class="item"><label>开始时间</label><input id="v-ss" type="text" value="0"></div>
      <div class="item"><label>时长</label><input id="v-dur" type="text" value="10"></div>
      <div class="item"><label>输出</label><select id="v-trim-mode"><option value="mp4">MP4（重新编码，帧精确）</option><option value="copy">复制（快速，但取整到关键帧）</option></select></div>
    </div></div>`);
  }
  el.innerHTML = html.join('');
}

async function buildVideoJob() {
  const t = $('v-task').value;
  const items = vZone.list();
  if (items.length === 0) throw new Error('请先拖入视频文件');
  if ((t === 'concat') && items.length < 2) throw new Error('拼接需要至少 2 个视频');

  const base = sanitize(items[0].name);
  if (t === 'transcode') {
    const [file] = items;
    const ext = extOf(file.name), data = await readBytes(file.file);
    const fmt = $('v-fmt').value, def = CONT[fmt];
    const res = $('v-res').value;
    // 专家模式 + 打开多核加速 + 输出为 mp4 → 分段并行转码（H.264，多核吃满）
    if (MODE === 'expert' && $('v-par').value !== '0' && fmt === 'mp4') {
      const n = Number($('v-par').value);
      const ec = [];
      if (res === 'custom') ec.push('-vf', `scale=${$('v-res-c').value}:-2`);
      else if (res !== '0') ec.push('-vf', `scale=${res}:-2`);
      const fps = $('v-fps').value;
      if (fps !== '0') ec.push('-r', fps);
      ec.push('-c:v', 'libx264', '-preset', 'veryfast');
      if ($('v-qmode').value === 'crf') ec.push('-crf', $('v-crf').value);
      else ec.push('-b:v', $('v-br').value + 'k');
      const keep = $('v-keep').value;
      let withAudio = true;
      if (keep === 'drop') { ec.push('-an'); withAudio = false; }
      else {
        const aeRaw = $('v-ae').value;
        const ae = aeRaw === 'auto' ? 'aac' : aeRaw;
        if (keep === 'copy') ec.push('-c:a', 'copy');
        else ec.push('-c:a', ae, '-b:a', $('v-abr').value + 'k');
      }
      return { segmented: true, segOpts: { srcName: `in0.${ext}`, srcData: data, n, encodeArgs: ec, withAudio, outName: `${base}.mp4`, mime: MIME.mp4, label: '多核分段转码' } };
    }
    const args = ['-i', `in0.${ext}`];
    if (MODE === 'expert') {
      const veRaw = $('v-ve').value;
      const ve = veRaw === 'auto' ? def.ve : veRaw;
      if (res === 'custom') args.push('-vf', `scale=${$('v-res-c').value}:-2`);
      else if (res !== '0') args.push('-vf', `scale=${res}:-2`);
      const fps = $('v-fps').value;
      if (fps !== '0') args.push('-r', fps);
      args.push('-c:v', ve);
      if (ve.startsWith('libx26')) args.push('-preset', 'veryfast');
      if ($('v-qmode').value === 'crf') args.push('-crf', $('v-crf').value);
      else args.push('-b:v', $('v-br').value + 'k');
      const keep = $('v-keep').value;
      if (keep === 'drop') args.push('-an');
      else {
        const aeRaw = $('v-ae').value;
        const ae = aeRaw === 'auto' ? def.ae : aeRaw;
        if (keep === 'copy') args.push('-c:a', 'copy');
        else args.push('-c:a', ae, '-b:a', $('v-abr').value + 'k');
      }
    } else {
      if (res !== '0') args.push('-vf', `scale=${res}:-2`);
      args.push('-r', $('v-fps').value, '-c:v', def.ve);
      if (def.ve.startsWith('libx26')) args.push('-preset', 'veryfast');
      args.push('-crf', Q_CRF[$('v-quality').value]);
      if ($('v-aud').value === 'drop') args.push('-an');
      else args.push('-c:a', def.ae, '-b:a', '160k');
    }
    if (fmt === 'mp4' || fmt === 'mov') args.push('-movflags', '+faststart');
    const out = `${base}.${fmt}`;
    return makeJob([{ name: `in0.${ext}`, data }], args, out, MIME[fmt], '转码');
  }

  if (t === 'extract') {
    const [file] = items;
    const ext = extOf(file.name), data = await readBytes(file.file);
    const fmt = $('v-afmt').value;
    const enc = { mp3: 'libmp3lame', m4a: 'aac', wav: 'pcm_s16le', flac: 'flac', ogg: 'libvorbis', opus: 'libopus' }[fmt];
    const args = ['-i', `in0.${ext}`, '-vn', '-c:a', enc];
    if (fmt !== 'wav' && fmt !== 'flac') {
      args.push('-b:a', (MODE === 'expert' ? $('v-abr').value : Q_ABR[$('v-aqual').value]) + 'k');
    }
    if (MODE === 'expert') {
      if ($('v-ar').value !== '0') args.push('-ar', $('v-ar').value);
      if ($('v-ac').value !== '0') args.push('-ac', $('v-ac').value);
    }
    const out = `${base}.${fmt}`;
    return makeJob([{ name: `in0.${ext}`, data }], args, out, MIME[fmt], '剥离音频');
  }

  if (t === 'concat') {
    const files = [];
    const inputs = [];
    for (let i = 0; i < items.length; i++) {
      const ext = extOf(items[i].name);
      inputs.push(`in${i}.${ext}`);
      files.push({ name: inputs[i], data: await readBytes(items[i].file) });
    }
    const fmt = $('v-fmt').value, n = items.length;
    let out, args, label;
    if ($('v-concat-method').value === 'copy') {
      const list = inputs.map((p) => `file '${p}'`).join('\n');
      files.push({ name: 'list.txt', data: new TextEncoder().encode(list) });
      args = ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy'];
      if (fmt === 'mp4') args.push('-movflags', '+faststart');
      out = `${base}_concat.${fmt}`; label = '快速拼接';
    } else {
      const ve = MODE === 'expert' ? $('v-ve').value : CONT[fmt].ve;
      const ae = MODE === 'expert' ? $('v-ae').value : CONT[fmt].ae;
      let filter;
      if (n === 2) filter = `[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[vout][aout]`;
      else {
        const vs = [], as = [];
        for (let i = 0; i < n; i++) { vs.push(`[${i}:v:0]`); as.push(`[${i}:a:0]`); }
        filter = `${vs.join('')}${as.join('')}concat=n=${n}:v=1:a=1[vout][aout]`;
      }
      args = [...inputs.map((p) => ['-i', p]).flat(),
        '-filter_complex', filter, '-map', '[vout]', '-map', '[aout]',
        '-c:v', ve];
      if (MODE === 'expert') args.push('-crf', $('v-crf').value, '-c:a', ae, '-b:a', $('v-abr').value + 'k');
      else args.push('-crf', Q_CRF[$('v-quality').value], '-c:a', ae, '-b:a', '160k');
      if (ve.startsWith('libx26')) args.push('-preset', 'veryfast');
      if (fmt === 'mp4' || fmt === 'mov') args.push('-movflags', '+faststart');
      out = `${base}_concat.${fmt}`; label = '转码拼接';
    }
    return makeJob(files, args, out, MIME[fmt], label);
  }

  if (t === 'gif') {
    const [file] = items;
    const ext = extOf(file.name), data = await readBytes(file.file);
    const w = $('v-gif-w').value, fps = $('v-gif-fps').value;
    let vf = `fps=${fps},scale=${w}:-1:flags=lanczos`;
    if ($('v-gif-pal').value === '1') vf += ',split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse';
    const args = ['-i', `in0.${ext}`, '-vf', vf, `${base}.gif`];
    return makeJob([{ name: `in0.${ext}`, data }], args, `${base}.gif`, 'image/gif', '转 GIF');
  }

  if (t === 'trim') {
    const [file] = items;
    const ext = extOf(file.name), data = await readBytes(file.file);
    const ss = parseTime($('v-ss').value), dur = parseTime($('v-dur').value);
    if (isNaN(ss)) throw new Error('开始时间格式不对，请用秒数或 1:30');
    if (isNaN(dur) || dur <= 0) throw new Error('时长格式不对');
    const mode = $('v-trim-mode').value;
    const args = ['-ss', String(ss), '-t', String(dur), '-i', `in0.${ext}`];
    if (mode === 'copy') args.push('-c', 'copy', '-movflags', '+faststart');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart');
    const out = `${base}_trim.mp4`;
    return makeJob([{ name: `in0.${ext}`, data }], args, out, 'video/mp4', '截取');
  }
  throw new Error('未知的视频功能');
}

/* ================= 音频 ================= */
const aZone = createZone('a-file', 'a-drop', 'a-files', true);
const AOUT = { mp3: ['libmp3lame', 'mp3'], m4a: ['aac', 'm4a'], wav: ['pcm_s16le', 'wav'], flac: ['flac', 'flac'], ogg: ['libvorbis', 'ogg'], opus: ['libopus', 'opus'] };

function renderAudioOpts() {
  const t = $('a-task').value;
  const el = $('a-opts');
  const fmtOpts = Object.keys(AOUT).map((f) => `<option value="${f}">${f.toUpperCase()}</option>`).join('');
  let h = `<div class="opt-group"><span class="gtitle">输出</span><div class="opt-grid">
    <div class="item"><label>格式</label><select id="a-fmt">${fmtOpts}</select></div>`;
  if (MODE === 'expert') {
    h += `<div class="item"><label>码率 kb/s（无损无效）</label><input id="a-br" type="number" value="192" min="32"></div>
    <div class="item"><label>采样率 Hz</label><select id="a-ar"><option value="0">原始</option><option value="48000">48000</option><option value="44100">44100</option><option value="22050">22050</option></select></div>
    <div class="item"><label>声道</label><select id="a-ac"><option value="0">原始</option><option value="2">立体声</option><option value="1">单声道</option></select></div>`;
  } else {
    h += `<div class="item"><label>音质</label><select id="a-quality"><option value="high">好（文件大）</option><option value="mid" selected>中等（推荐）</option><option value="low">一般（文件小）</option></select></div>`;
  }
  h += `</div></div>`;
  if (t === 'trim') {
    h += `<div class="opt-group"><span class="gtitle">截取范围（秒，支持 1:30 或 90）</span><div class="opt-grid">
      <div class="item"><label>开始时间</label><input id="a-ss" type="text" value="0"></div>
      <div class="item"><label>时长</label><input id="a-dur" type="text" value="10"></div>
    </div></div>`;
  }
  el.innerHTML = h;
}

async function buildAudioJob() {
  const t = $('a-task').value;
  const items = aZone.list();
  if (items.length === 0) throw new Error('请先拖入音频（或视频）文件');
  if (t === 'concat' && items.length < 2) throw new Error('合并需要至少 2 段音频');

  const fmt = $('a-fmt').value, [codec, fext] = AOUT[fmt];
  const base = sanitize(items[0].name);
  const common = (ext, i, data) => ({ name: `in${i}.${ext}`, data });

  if (t === 'concat') {
    const files = [], inputs = [];
    for (let i = 0; i < items.length; i++) {
      const ext = extOf(items[i].name);
      inputs.push(`in${i}.${ext}`);
      files.push(common(ext, i, await readBytes(items[i].file)));
    }
    let filter = `[0:a][1:a]`;
    for (let i = 2; i < items.length; i++) filter += `[${i}:a]`;
    filter += `concat=n=${items.length}:v=0:a=1[aout]`;
    let args = [...inputs.map((p) => ['-i', p]).flat(), '-filter_complex', filter, '-map', '[aout]', '-c:a', codec];
    if (fmt !== 'wav' && fmt !== 'flac') args.push('-b:a', (MODE === 'expert' ? $('a-br').value : Q_ABR[$('a-quality').value]) + 'k');
    const out = `${base}_merge.${fext}`;
    return makeJob(files, args, out, MIME[fmt], '合并音频');
  }

  const [file] = items;
  const ext = extOf(file.name), data = await readBytes(file.file);
  let args = ['-i', `in0.${ext}`];
  if (t === 'trim') {
    const ss = parseTime($('a-ss').value), dur = parseTime($('a-dur').value);
    if (isNaN(ss)) throw new Error('开始时间格式不对');
    if (isNaN(dur) || dur <= 0) throw new Error('时长格式不对');
    args = ['-ss', String(ss), '-t', String(dur), '-i', `in0.${ext}`];
  }
  args.push('-vn', '-c:a', codec);
  if (fmt !== 'wav' && fmt !== 'flac') args.push('-b:a', (MODE === 'expert' ? $('a-br').value : Q_ABR[$('a-quality').value]) + 'k');
  if (MODE === 'expert') {
    if ($('a-ar').value !== '0') args.push('-ar', $('a-ar').value);
    if ($('a-ac').value !== '0') args.push('-ac', $('a-ac').value);
  }
  const suffix = t === 'trim' ? '_cut' : '_out';
  const out = `${base}${suffix}.${fext}`;
  return makeJob([{ name: `in0.${ext}`, data }], args, out, MIME[fmt] || 'audio/mpeg', '转音频');
}

/* ================= 图片 ================= */
const imgZone = createZone('img-file', 'img-drop', 'img-files', true);
const IMG_EXT = { png: 'png', jpg: 'jpg', webp: 'webp', bmp: 'bmp' };
function renderImageOpts() {
  const sizeOpts = MODE === 'expert'
    ? `<option value="0">原始</option><option value="50">缩放 50%</option><option value="75">缩放 75%</option><option value="custom">自定义宽度</option>`
    : `<option value="0">和原来一样</option><option value="50">缩小到 50%</option><option value="25">缩小到 25%</option>`;
  const customW = MODE === 'expert' ? `<div class="item"><label>宽度（按比例）</label><input id="img-w" type="number" value="1280" min="16"></div>` : '';
  $('img-opts').innerHTML = `<div class="opt-group"><span class="gtitle">输出</span><div class="opt-grid">
    <div class="item"><label>格式</label><select id="img-fmt"><option value="png">PNG（无损）</option><option value="jpg">JPG（有损）</option><option value="webp">WebP</option><option value="bmp">BMP（无损大）</option></select></div>
    <div class="item"><label>画质（仅 JPG/WebP）</label><select id="img-q"><option value="hi" selected>高</option><option value="mid">中</option><option value="low">低</option></select></div>
    <div class="item"><label>尺寸</label><select id="img-size">${sizeOpts}</select></div>
    ${customW}
  </div></div>`;
}
async function buildImageJobs() {
  const items = imgZone.list();
  if (items.length === 0) throw new Error('请先拖入图片');
  const fmt = $('img-fmt').value;
  const q = Q_IMG[$('img-q').value];
  const sz = $('img-size').value;
  const jobs = [];
  for (const it of items) {
    const ext = extOf(it.name), data = await readBytes(it.file);
    const args = ['-i', `in.${ext}`];
    if (sz === 'custom' && MODE === 'expert') args.push('-vf', `scale=${$('img-w').value}:-1`);
    else if (sz !== '0') args.push('-vf', `scale=iw*${sz / 100}:-1`);
    if (fmt === 'jpg') args.push('-q:v', q);
    if (fmt === 'webp') args.push('-q:v', q === '2' ? '90' : (q === '6' ? '70' : '45'));
    const out = `${sanitize(it.name)}.${fmt}`;
    jobs.push(makeJob([{ name: `in.${ext}`, data }], args, out, MIME[fmt], '图片转换'));
  }
  return jobs;
}

/* ================= 合成（音视频合并） ================= */
const mxvZone = createZone('mx-v-file', 'mx-v-drop', 'mx-v-files', false);
const mxaZone = createZone('mx-a-file', 'mx-a-drop', 'mx-a-files', false);
function renderMixOpts() {
  $('mx-opts').innerHTML = `<div class="opt-group"><span class="gtitle">输出</span><div class="opt-grid">
    <div class="item"><label>容器</label><select id="mx-fmt"><option value="mp4">MP4</option><option value="mkv">MKV</option><option value="webm">WebM</option></select></div>
    <div class="item"><label>视频轨</label><select id="mx-ve"><option value="reencode">重新编码（H.264，兼容）</option><option value="copy">直接复制（快）</option></select></div>
    <div class="item"><label>音频轨</label><select id="mx-ae"><option value="reencode">转成 AAC（推荐）</option><option value="copy">直接复制（快）</option></select></div>
  </div></div>`;
}
async function buildMixJob() {
  const v = mxvZone.list(), a = mxaZone.list();
  if (v.length === 0) throw new Error('请先选择视频轨');
  if (a.length === 0) throw new Error('请先选择音频轨');
  const vex = extOf(v[0].name), aex = extOf(a[0].name);
  const fmt = $('mx-fmt').value, def = CONT[fmt];
  const files = [
    { name: `in0.${vex}`, data: await readBytes(v[0].file) },
    { name: `in1.${aex}`, data: await readBytes(a[0].file) },
  ];
  const args = ['-i', `in0.${vex}`, '-i', `in1.${aex}`];
  if ($('mx-ve').value === 'copy') args.push('-c:v', 'copy');
  else args.push('-c:v', def.ve, '-preset', 'veryfast');
  if ($('mx-ae').value === 'copy') args.push('-c:a', 'copy');
  else args.push('-c:a', def.ae, '-b:a', '192k');
  args.push('-shortest');
  if (fmt === 'mp4' || fmt === 'mov') args.push('-movflags', '+faststart');
  const base = sanitize(v[0].name);
  const out = `${base}_muxed.${fmt}`;
  return makeJob(files, args, out, MIME[fmt], '合成音视频');
}

/* ================= 装配 ================= */
function init() {
  // 预热组件（页面一打开就走，不等用户操作）
  preload().then(() => {
    $('wasm-text').textContent = '组件已就绪 ✓';
    $('wasm-pill').className = 'pill on';
  }).catch(() => {
    $('wasm-text').textContent = '组件加载失败，请刷新重试';
    $('wasm-pill').className = 'pill warn';
  });

  // 标签页切换
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));
      $(`tab-${btn.getAttribute('data-tab')}`).classList.remove('hidden');
    });
  });

  // 视频任务下拉 → 渲染选项
  $('v-task').addEventListener('change', () => { renderVideoOpts(); $('v-status').textContent = '就绪'; });
  $('a-task').addEventListener('change', () => { renderAudioOpts(); $('a-status').textContent = '就绪'; });

  // 简单/专家模式：先读 localStorage 记住的偏好，再渲染选项；切换按钮会写回偏好
  MODE = loadMode();
  $('mode-simple').addEventListener('click', () => setMode('simple'));
  $('mode-expert').addEventListener('click', () => setMode('expert'));
  applyModeButtons();
  renderVideoOpts(); renderAudioOpts(); renderImageOpts(); renderMixOpts();

  // 运行按钮
  makeRunner('v-run', 'v-prog', 'v-status', buildVideoJob);
  makeRunner('a-run', 'a-prog', 'a-status', buildAudioJob);
  makeRunner('img-run', 'img-prog', 'img-status', buildImageJobs);
  makeRunner('mx-run', 'mx-prog', 'mx-status', buildMixJob);
}

init();