// test/probe.mjs — 隔离诊断 extract 命令失败原因
import puppeteer from 'puppeteer-core';
const BASE = process.env.TEST_BASE || 'http://localhost:4200';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 40000 });
const out = await page.evaluate(async () => {
  const lib = await import('/lib/esm/index.js');
  const ff = new lib.FFmpeg();
  await ff.load({ coreURL: '/lib/ffmpeg-core.esm.js', wasmURL: '/lib/ffmpeg-core.wasm' });
  // 造一个带音轨的输入
  await ff.exec(['-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=0.5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', 'in0.mp4']);

  const logs = [];
  ff.on('log', ({ message }) => logs.push(message));
  const run = async (name, args) => {
    logs.length = 0;
    const rc = await ff.exec(args);
    return { name, rc, tail: logs.slice(-6).join(' | ').slice(0, 300) };
  };
  const results = [];
  results.push(await run('extract(原样)', ['-i', 'in0.mp4', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', 'out.mp3']));
  results.push(await run('extract(wav)', ['-i', 'in0.mp4', '-vn', 'out.wav']));
  results.push(await run('extract(空)', ['-i', 'in0.mp4', 'out.mp4']));
  return results;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
process.exit(0);