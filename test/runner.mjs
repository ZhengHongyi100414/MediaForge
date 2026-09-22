// test/runner.mjs — 让测试脚本自己拉起静态服务，跑完自动清理。
// 用法：node test/runner.mjs <测试脚本>   （测试脚本用 TEST_BASE 环境变量指向服务）
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || 'e2e.mjs';
const PORT = 4210;
const BASE = `http://localhost:${PORT}`;

if (typeof spawn !== 'function') {
  console.error('当前 Node 不支持 node:child_process，请改用 >=22.15');
  process.exit(2);
}
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let up = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) { up = true; break; }
  } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 300));
}
if (!up) { console.error('服务启动失败'); srv.kill(); process.exit(1); }
console.log(`[runner] 服务就绪 ${BASE}，运行 ${target}`);

process.env.TEST_BASE = BASE;
const code = await import(pathToFileURL(path.join(__dirname, target)).href);
await new Promise((r) => setTimeout(r, 500));
if (srv.exitSignal) { /* already dead */ }
try { srv.kill(); } catch { /* ignore */ }
process.exit(0);