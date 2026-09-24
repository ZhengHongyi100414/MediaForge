// test/e2e.mjs — 端到端浏览器测试
// 前置：服务已在运行（PORT=4200）。用本地 Chrome 真实加载页面，
// 验证：① ffmpeg.wasm 页面打开即自动预热 → ② 用 wasm 生成样本视频 →
//       ③ 驱动 UI 跑「提取音频」「转码」「视频转 GIF」→ 检查完成状态。
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.TEST_BASE || 'http://localhost:4200';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type === 'error') pageErrors.push('console: ' + m.text); });

try {
  await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 40000 });

  // ① 页面一打开就该自动预热组件 → 组件胶囊变为就绪
  try {
    await page.waitForSelector('#wasm-pill.on', { timeout: 90000 });
  } catch (e) { /* 超时 */ }
  const pill = await page.evaluate(() => document.getElementById('wasm-text').textContent);
  check('页面打开后 ffmpeg 组件自动加载就绪（无需用户操作）', pill.includes('就绪'), `pill="${pill}"`);

  // ② 用 wasm 直接生成一个带音轨的样本视频，读回并落盘（同一实例内完成）
  const gen = await page.evaluate(async () => {
    const lib = await import('/lib/esm/index.js');
    const ff = new lib.FFmpeg();
    await ff.load({ coreURL: '/lib/ffmpeg-core.esm.js', wasmURL: '/lib/ffmpeg-core.wasm' });
    const rc = await ff.exec(['-f', 'lavfi', '-i', 'color=c=red:s=160x120:d=1.2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', 'sample.mp4']);
    if (rc !== 0) return { rc };
    const d = await ff.readFile('sample.mp4');
    const bytes = d;
    let bin = '';
    for (let i = 0; i < bytes.length; i += 3) bin += String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2]);
    return { rc, len: bytes.length, dataUrl: btoa(bin) };
  });
  check('wasm 生成了有效的样本视频 (mp4)', gen.rc === 0 && gen.len > 500, JSON.stringify({ rc: gen.rc, len: gen.len }).slice(0, 120));
  if (gen.len > 500) {
    const samplePath = 'test/sample.mp4';
    fs.writeFileSync(samplePath, Buffer.from(gen.dataUrl, 'base64'));
    console.log('  sample.mp4 written:', fs.statSync(samplePath).size, 'bytes');

    // ③ 通过文件选择器把样本喂给「视频」投放区
    async function dropFile(selector, path) {
      const [chooser] = await Promise.all([
        page.waitForFileChooser(),
        page.click(selector),
      ]);
      await chooser.accept([path]);
    }
    await dropFile('#v-drop', samplePath);
    await sleep(400);
    await page.select('#v-task', 'extract');
    await page.select('#v-afmt', 'mp3');
    await page.click('#v-run');
    await page.waitForFunction(() => {
      const s = document.getElementById('v-status');
      return s.textContent.includes('完成');
    }, { timeout: 120000 });
    const st1 = await page.evaluate(() => document.getElementById('v-status').textContent);
    check('UI 提取音频成功（视频 → mp3）', st1.includes('完成') && !st1.includes('出错'), st1);
    check('  -- 全程无页面报错', pageErrors.length === 0, pageErrors.join('; '));

    // ④ 驱动 UI：视频转码（默认 mp4）
    await page.select('#v-task', 'transcode');
    await page.select('#v-res', '640');
    await page.click('#v-run');
    await page.waitForFunction(() => {
      const s = document.getElementById('v-status');
      return s.textContent.includes('完成');
    }, { timeout: 120000 });
    const st2 = await page.evaluate(() => document.getElementById('v-status').textContent);
    check('UI 视频转码成功（默认转 mp4）', st2.includes('完成') && !st2.includes('出错'), st2);

    // ⑤ 驱动 UI：视频转 GIF
    await page.select('#v-task', 'gif');
    await page.click('#v-run');
    await page.waitForFunction(() => {
      const s = document.getElementById('v-status');
      return s.textContent.includes('完成');
    }, { timeout: 120000 });
    const st3 = await page.evaluate(() => document.getElementById('v-status').textContent);
    check('UI 视频转 GIF 成功', st3.includes('完成') && !st3.includes('出错'), st3);

    // ⑥ 视频拼接（同一段重复两次 → 转码拼接）
    await dropFile('#v-drop', samplePath);
    await sleep(300);
    await page.select('#v-task', 'concat');
    await page.click('#v-run');
    await page.waitForFunction(() => {
      const s = document.getElementById('v-status');
      return s.textContent.includes('完成') || s.textContent.includes('出错');
    }, { timeout: 120000 });
    const st4 = await page.evaluate(() => document.getElementById('v-status').textContent);
    check('UI 视频拼接成功（2 段转码拼接）', st4.includes('完成') && !st4.includes('出错'), st4);

    // ⑦ 音频转码：把样本视频的音频转成 mp3
    await page.click('.tab-btn[data-tab="audio"]');
    await sleep(300);
    await dropFile('#a-drop', samplePath);
    await sleep(300);
    await page.select('#a-fmt', 'mp3');
    await page.click('#a-run');
    await page.waitForFunction(() => {
      const s = document.getElementById('a-status');
      return s.textContent.includes('完成') || s.textContent.includes('出错');
    }, { timeout: 90000 });
    const st5 = await page.evaluate(() => document.getElementById('a-status').textContent);
    check('UI 音频转码成功（视频→mp3）', st5.includes('完成') && !st5.includes('出错'), st5);

    // ⑧ 图片转换：先用 wasm 生成一张 png，再转 jpg
    const pngB64 = await page.evaluate(async () => {
      const lib = await import('/lib/esm/index.js');
      const ff = new lib.FFmpeg();
      await ff.load({ coreURL: '/lib/ffmpeg-core.esm.js', wasmURL: '/lib/ffmpeg-core.wasm' });
      await ff.exec(['-f', 'lavfi', '-i', 'color=c=blue:s=100x100:d=1', '-frames:v', '1', '-f', 'image2', '-vcodec', 'png', 'pic.png']);
      const d = await ff.readFile('pic.png');
      let bin = '';
      for (let i = 0; i < d.length; i += 3) bin += String.fromCharCode(d[i], d[i + 1], d[i + 2]);
      return btoa(bin);
    });
    const pngPath = 'test/sample.png';
    fs.writeFileSync(pngPath, Buffer.from(pngB64, 'base64'));
    await page.click('.tab-btn[data-tab="image"]');
    await sleep(300);
    await dropFile('#img-drop', pngPath);
    await sleep(300);
    await page.select('#img-fmt', 'jpg');
    await page.click('#img-run');
    await page.waitForFunction(() => {
      const s = document.getElementById('img-status');
      return s.textContent.includes('完成') || s.textContent.includes('出错');
    }, { timeout: 90000 });
    const st6 = await page.evaluate(() => document.getElementById('img-status').textContent);
    check('UI 图片转换成功（png→jpg）', st6.includes('完成') && !st6.includes('出错'), st6);

    // ⑨ 合成音视频：视频 + 生成的 mp3
    const mp3B64 = await page.evaluate(async () => {
      const lib = await import('/lib/esm/index.js');
      const ff = new lib.FFmpeg();
      await ff.load({ coreURL: '/lib/ffmpeg-core.esm.js', wasmURL: '/lib/ffmpeg-core.wasm' });
      await ff.exec(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=1.5', '-c:a', 'libmp3lame', '-b:a', '128k', 'tone.mp3']);
      const d = await ff.readFile('tone.mp3');
      let bin = '';
      for (let i = 0; i < d.length; i += 3) bin += String.fromCharCode(d[i], d[i + 1], d[i + 2]);
      return btoa(bin);
    });
    const mp3Path = 'test/sample.mp3';
    fs.writeFileSync(mp3Path, Buffer.from(mp3B64, 'base64'));
    await page.click('.tab-btn[data-tab="mix"]');
    await sleep(300);
    await dropFile('#mx-v-drop', samplePath);
    await sleep(300);
    await dropFile('#mx-a-drop', mp3Path);
    await sleep(300);
    await page.select('#mx-fmt', 'mp4');
    await page.click('#mx-run');
    await page.waitForFunction(() => {
      const s = document.getElementById('mx-status');
      return s.textContent.includes('完成') || s.textContent.includes('出错');
    }, { timeout: 120000 });
    const st7 = await page.evaluate(() => document.getElementById('mx-status').textContent);
    check('UI 合成音视频成功（视频+音频→mp4）', st7.includes('完成') && !st7.includes('出错'), st7);
  } else {
    check('样本生成失败，跳过 UI 驱动测试', false, 'sample.mp4 bytes too small');
  }

  check('全程无页面/脚本报错', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));
} finally {
  await browser.close();
}

console.log(`\n== e2e: ${pass} passed, ${fail} failed ==`);
process.exit(fail > 0 ? 1 : 0);