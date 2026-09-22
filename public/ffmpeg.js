// ffmpeg.js — 浏览器端 ffmpeg.wasm 封装（自托管组件库，无外部 CDN 依赖）。
// 所有媒体处理都在本机浏览器内存里完成，绝不把文件上传到任何服务器。
import { FFmpeg } from './lib/esm/index.js';

const CORE_PATH = '/lib/ffmpeg-core.esm.js';
const CORE_WASM = '/lib/ffmpeg-core.wasm';

let ffmpeg = null;

/**
 * 确保 ffmpeg core 已加载。首次会拉取约 30MB 的 wasm（浏览器有缓存，之后秒开）。
 * 页面打开时即可调用 preload()，让加载和用户选文件并行。
 */
export async function ensureLoaded(onPhase) {
  if (ffmpeg) return ffmpeg;
  if (onPhase) onPhase('正在加载 ffmpeg 组件（首次约 30MB，之后有缓存）…');
  ffmpeg = new FFmpeg();
  await ffmpeg.load({ coreURL: CORE_PATH, wasmURL: CORE_WASM });
  return ffmpeg;
}

/** 页面一打开就调它，把 30MB 组件在后台预热。 */
export function preload() {
  if (ffmpeg) return Promise.resolve(ffmpeg);
  try { return ensureLoaded(); } catch (e) { /* 加载失败不阻塞页面，任务执行时会重试 */ return Promise.reject(new Error('preload failed')); }
}

function sanitize(name) {
  const base = String(name || 'out').replace(/\.\w+$/, '');
  return (base.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 60) || 'out');
}

function triggerDownload(name, data, mime) {
  const blob = new Blob([data], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
}

/**
 * 执行一个 ffmpeg 任务并下载结果。
 * @param {object} job
 *   - files: [{ name, data: Uint8Array }]   写入 ffmpeg 内存盘的文件
 *   - args:  string[]                       除输入写盘外的完整 ffmpeg 参数（含 -y）
 *   - out:   string                         输出文件名
 *   - mime:  string                         下载的 MIME 类型
 *   - label: string                         用于进度提示
 * @param {(p:number)=>void} onProgress  0~1
 * @param {(msg:string)=>void} onPhase
 */
export async function runJob(job, onProgress, onPhase) {
  const f = await ensureLoaded(onPhase);

  // 已有的 this.gen 事件重复挂会叠加，用单例回调并返回解绑函数
  const progressCb = ({ progress }) => { if (onProgress && typeof progress === 'number') onProgress(progress); };
  f.on('progress', progressCb);
  // 捕获 ffmpeg 日志，出错时能把原因带给用户
  const logs = [];
  const logCb = ({ message }) => { if (message && logs.length < 60) logs.push(message); };
  f.on('log', logCb);
  try {
    for (const file of job.files) {
      if (onPhase) onPhase(`写入 ${file.name} …`);
      await f.writeFile(file.name, file.data);
    }
    if (onPhase) onPhase(`处理中…${job.label ? '（' + job.label + '，量大时较慢）' : ''}`);
    const rc = await f.exec(job.args);
    if (rc !== 0) {
      const tail = logs.slice(-12).join('\n').slice(0, 1000);
      throw new Error(`ffmpeg 执行失败（code ${rc}）${tail ? '\n' + tail : ''}`);
    }
    if (onPhase) onPhase('读取结果…');
    const outData = await f.readFile(job.out);
    // 清理内存盘
    for (const file of job.files) { try { await f.deleteFile(file.name); } catch { /* 忽略 */ } }
    try { await f.deleteFile(job.out); } catch { /* 忽略 */ }
    if (onProgress) onProgress(1);
    triggerDownload(job.out, outData, job.mime);
    if (onPhase) onPhase(`✅ 完成「${job.out}」，已触发下载。若没弹下载，请放行浏览器弹窗。`);
    return job.out;
  } finally {
    f.off('progress', progressCb);
    f.off('log', logCb);
  }
}

export { sanitize, triggerDownload };