import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 40032;

const app = express();

// 纯静态站点：ffmpeg.wasm 需要同源 HTTP 提供，所有媒体处理都在浏览器端完成，
// 本服务只负责把前端文件发出去，不上传/不处理任何文件。
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, { index: 'index.html' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'format-factory', note: 'all processing happens client-side' });
});

app.listen(PORT, () => {
  console.log(`Format Factory listening on http://localhost:${PORT}`);
});