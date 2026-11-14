# short-makers

把 [Theadvocate-bit/short_videos](https://github.com/Theadvocate-bit/short_videos)（短视频聚合解析，原项目 `jiuhunwl/short_videos`）改造到 **EdgeOne Makers** 上部署落地。

原项目是 **纯 PHP**（PHP 8.0+ + curl/json + Apache/Nginx），而 EdgeOne Makers **没有 PHP 运行时**。
本仓库把它的解析逻辑移植到 Makers 支持的运行时（Edge Function / Node.js），做成无服务器 API。

> 原项目、解析逻辑、统一 JSON 格式全部来自 [Theadvocate-bit/short_videos](https://github.com/Theadvocate-bit/short_videos)（MIT），
> 本仓库只做 serverless 化移植。

---

## 架构

| | 原项目 (short_videos) | 本仓库 (short-makers) |
|---|---|---|
| 运行时 | PHP 8.0+（常驻，Apache/Nginx） | EdgeOne Makers Edge Function（Node.js） |
| 聚合调度 | `api/sv.php`（关键词识别平台） | `/api/parse`（同款关键词识别） |
| 各平台解析 | `api/**/*.php` | `cloud-functions/_lib/parsers/*.js` |
| 媒体直链代理 | `cf_sv_proxy/worker.js`（CF Worker） | `/proxy`（移植为 Edge Function） |
| 网易云音乐 | `api/wyy.py`（Python） | 待移植 |

## 目录结构

```
short-makers/
├── cloud-functions/
│   ├── parse/[[default]].js        # /api/parse  聚合调度（平台识别 + 分发）
│   ├── proxy/[[default]].js        # /proxy      媒体直链代理（解决 403 防盗链）
│   └── _lib/
│       ├── platforms.js            # 平台关键词表 + 识别
│       └── parsers/
│           └── bilibili.js         # Bilibili 解析器（已移植）
├── edgeone.json
├── package.json
└── README.md
```

---

## 接口

### `GET /api/parse?url=<视频链接>`

自动识别平台并解析，返回统一 JSON（见原项目 `docs/视频解析统一JSON格式3.0.md`）。

```bash
curl "https://<你的域名>/api/parse?url=https://www.bilibili.com/video/BVxxxx"
```

### `GET /proxy?proxyurl=<媒体直链>&type=douyin&download=true`

媒体直链代理：服务端带正确 Referer/UA 拉直链、手动跟随 302、流式转发，解决抖音/微博 403 防盗链。

```bash
curl "https://<你的域名>/proxy?proxyurl=<直链>&type=douyin"
```

---

## 移植状态（诚实标注）

| 平台 | 状态 | 备注 |
|---|---|---|
| bilibili | ✅ 已移植可用 | 需 `BILIBILI_COOKIE` 环境变量（不填基础解析仍可用，1080P+ 需要） |
| douyin | ⏳ 待移植 | 原 `DouyinParser.php` 924 行，含复杂签名，工作量最大 |
| kuaishou | ⏳ 待移植 | 原 `KuaishouSpider.php` 333 行 |
| xiaohongshu | ⏳ 待移植 | 原 `XiaohongshuParser.php` 476 行 |
| weibo | ⏳ 待移植 | 原 `weibo.php` 283 行 |
| toutiao | ⏳ 待移植 | 原 `toutiao.php` 152 行 |
| pipixia / pipigx / zuiyou | ⏳ 待移植 | 单文件 PHP |
| 网易云音乐 | ⏳ 待移植 | 原 `api/wyy.py`（Python），可移植为 Python 云函数或 Node |
| 媒体直链代理 | ✅ 已移植可用 | 移植自 `cf_sv_proxy/worker.js` |

识别出「待移植」平台时，`/api/parse` 会返回明确的 `code:-2` 提示，而不是假装解析。

**如何新增一个平台**：
1. 参考 `cloud-functions/_lib/parsers/bilibili.js`，把对应 PHP 解析器移植成 `parsers/<平台>.js`，导出 `parse(url, env)`。
2. 在 `_lib/platforms.js` 的 `IMPLEMENTED` 集合里加上平台 key。
3. `parse/[[default]].js` 会自动调度到它。

---

## 环境变量

| 变量 | 用途 |
|---|---|
| `BILIBILI_COOKIE` | B站 Cookie（格式 `_uuid=XXXXX`），不填解析不到 1080P 以上 |

---

## 部署

1. 登录 [EdgeOne Makers 控制台](https://console.tencentcloud.com/edgeone/makers)。
2. 新建项目 → 从 Git 仓库导入 → 选本仓库。
3. 构建配置保持默认（`cloud-functions/` 自动识别函数）。
4. 部署完成后访问 `https://<域名>/api/parse?url=<链接>`。

CLI：`npm i -g edgeone && edgeone login && edgeone pages deploy`

---

## 本地开发

```bash
npm test          # 自测（平台识别、Bilibili 解析器、调度路由）
```

---

## 许可与致谢

- 解析逻辑、统一 JSON 格式来自 [Theadvocate-bit/short_videos](https://github.com/Theadvocate-bit/short_videos)（MIT），版权归上游作者。
- 本仓库仅做 EdgeOne Makers 的 serverless 移植。
- 各平台数据与播放源版权归对应平台，仅供学习研究，请勿用于商业用途。
