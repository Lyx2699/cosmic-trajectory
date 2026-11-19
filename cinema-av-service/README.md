# Deep Space Cinema · 影院内音画接入服务

开源的影院内部音画服务：把使用者的视频/音频插入影院服务器，影院端通过 HTTP Range 实时拉流，通过 SSE 接收播放/暂停/定位/换片指令。PC 与 Android 共用同一客户端协议。

## 启动

```bash
cd cinema-av-service
export LICENSE_SECRET='换成你自己的长随机密钥'
node server.js
```

默认监听 `0.0.0.0:8787`。本机访问 `http://127.0.0.1:8787`；局域网设备访问 `http://<服务器局域网IP>:8787`。

## 生成授权码

```bash
export LICENSE_SECRET='同一个密钥'
node tools/make-license.js pro 365 studio-a
```

输出的 `xxxx.yyyy` 即 licenseKey，交给已购买授权的用户。**授权校验只认同一个 LICENSE_SECRET**；泄露密钥等于泄露签发能力。

## API

- `GET /api/health`
- `POST /api/license/verify` `{licenseKey}`
- `POST /api/session` `{licenseKey}` → `{session:{token,plan,exp},sse}`
- `PUT /api/upload?name=xxx.mp4&token=...` 原始二进制上传，支持 4 GB 以内
- `GET /api/library?token=...`
- `GET /api/stream/:file?token=...` 支持 HTTP Range，可被 `<video>` 直接拉流
- `GET /api/proxy?url=...&token=...` 外部直链 / HLS(m3u8) 代理；HLS 播放列表与分片地址会重写回代理，影院端可直接拉流
- `GET /api/events?token=...` SSE：`hello` / `library` / `insert`
- `POST /api/insert?token=...` `{action:"play|pause|seek|load|stop",mediaId,time}`

## 外部播放器 / 流媒体

- **直链/HLS**：客户端「外部播放器 / 流媒体平台」粘贴 MP4、m3u8 或 DASH 直链，经 `/api/proxy` 进入影院服务端，再交给影院画布处理。
- **本机播放器**：PC 端「捕获播放器窗口」用系统屏幕/窗口捕获 + 系统音频回环，直接把 PotPlayer/VLC/浏览器等画面送进影院引擎，FNAR/JOC 实时处理。
- **Android**：原生 MediaProjection 屏幕捕获（`DsScreenCapture` 桥）把其他 App 画面按 10fps 送入影院画布；系统音频受 Android 平台限制，当前默认不强制内录。
- **DRM**：Netflix/Disney+/腾讯/优酷等受 DRM 保护的流，服务端不能解密；只能依赖本机捕获，且部分平台会黑屏。

## 授权与购买

官网「服务区」提交购买申请，服务端记录 `data/orders.json`，管理员完成付款后用 `tools/make-license.js` 签发 licenseKey。未购买授权时，客户端只能连接自建开发服务，不能访问正式影院内部服务器。

## 开源

MIT License。服务端只依赖 Node.js 标准库，不含任何闭源音画算法；影院图像增强、FNAR/JOC 仍由影院端本地引擎处理。
