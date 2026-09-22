# MediaForge · 网页格式工厂

一个纯浏览器端运行的「格式工厂」。基于 **ffmpeg.wasm**（自托管组件，无外部 CDN），
所有音视频、图片处理都在你本机的浏览器内存里完成——**文件绝不传输到任何服务器**。

> ✨ **MediaForge**：在浏览器里就地锻造媒体，文件不出你的电脑。

## 功能

| 类别 | 功能 |
| --- | --- |
| 🎬 视频 | 转码 / 压缩、提取音频（剥离音轨）、拼接多段、转 GIF、截取片段 |
| 🎵 音频 | 转码（mp3/aac/wav/flac/ogg/opus）、合并多段、截取片段 |
| 🖼️ 图片 | png / jpg / webp / bmp 互转，可调画质与尺寸 |
| 🧩 合成 | 视频 + 音频合并成一个文件（配解说 / 换背景乐） |

- 视频转码可调：容器、编码、分辨率、CRF/码率、帧率、音轨去留与编码
- 图片支持批量转换
- 打开网页即开始后台预热 ffmpeg 组件（首次约 30MB，之后浏览器有缓存），无需等待

## 运行

```bash
npm install
npm start          # 或 PORT=40032 npm start（默认端口 40032）
```

浏览器打开 http://localhost:40032 即可。

> ffmpeg.wasm 必须通过 HTTP 提供（同源），所以不能直接双击 index.html 打开。

## 测试

用本地 Chrome 做真实端到端测试（加载页面 → 自动预热组件 → 喂样本 → 跑各功能）：

```bash
npm run test:e2e
```

## 目录

```
public/
  index.html      界面（四个标签页）
  app.js          各功能任务的参数构建与执行
  ffmpeg.js       ffmpeg.wasm 封装（加载/进度/日志/下载）
  lib/            自托管 @ffmpeg/ffmpeg（ffmpeg-core.wasm 约 31MB）
server.js         仅静态文件服务（不含任何上传/处理逻辑）
test/             浏览器集成测试
```

## 说明

- 所有转换调用 ffmpeg.wasm 在本机完成，内存盘临时写入，结束后自动清理。
- 处理大文件时耐心等待进度条；若浏览器未触发下载，放行弹窗即可。