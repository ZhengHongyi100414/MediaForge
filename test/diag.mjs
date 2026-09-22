// test/diag.mjs — 诊断 UI 驱动转码（轮询状态，快速定位）
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
const BASE = process.env.TEST_BASE || 'http://localhost:4200';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type === 'error') console.log('[console.error]', m.text); });

await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 40000 });
try { await page.waitForSelector('#wasm-pill.on', { timeout: 90000 }); } catch {}
console.log('wasm ready:', await page.evaluate(() => document.getElementById('wasm-text').textContent));

// 生成样本落盘
await page.evaluate(async () => {
  const lib = await import('/lib/esm/index.js');
  const ff = new lib.FFmpeg();
  await ff.load({ coreURL: '/lib/ffmpeg-core.esm.js', wasmURL: '/lib/ffmpeg-core.wasm' });
  const rc = await ff.exec(['-f', 'lavfi', '-i', 'color=c=red:s=160x120:d=1.2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', 'sample.mp4']);
  const d = await ff.readFile('sample.mp4');
  let bin = '';
  for (let i = 0; i < d.length; i += 3) bin += String.fromCharCode(d[i], d[i + 1], d[i + 2]);
  window.__sample64 = btoa(bin);
});
const b64 = await page.evaluate(() => window.__sample64);
const samplePath = 'test/sample.mp4';
fs.writeFileSync(samplePath, Buffer.from(b64, 'base64'));
console.log('sample:', fs.statSync(samplePath).size, 'bytes');

const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('#v-drop')]);
await chooser.accept([samplePath]);
await sleep(500);
console.log('files after drop:', await page.evaluate(() => Array.from(document.querySelectorAll('#v-files .name')).map(e => e.textContent)));

await page.select('#v-task', 'extract');
await page.select('#v-afmt', 'mp3');
await page.click('#v-run');
console.log('run clicked');

for (let i = 0; i < 40; i++) {
  await sleep(3000);
  const s = await page.evaluate(() => {
    const el = document.getElementById('v-status');
    return { text: el.textContent, cls: el.className, bar: document.getElementById('v-prog').style.width };
  });
  console.log(`[${i * 3}s]`, JSON.stringify(s));
  if (s.text && s.text.includes('完成')) break;
  if (s.text && s.text.includes('出错')) break;
}
await browser.close();
process.exit(0);