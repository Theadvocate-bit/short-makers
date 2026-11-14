<div align="center">
  <img width="100px" alt="logo" src="public/img/icon.png"/>
  <h1>短视频去水印解析接口 · EdgeOne Makers 版</h1>
  <p><em>多平台短视频解析 · 免 Cookie · 无水印直链 · 边缘函数部署</em></p>
</div>

---

## 🎯 项目简介

本项目是 [jiuhunwl/short_videos](https://github.com/jiuhunwl/short_videos)（PHP 版短视频去水印解析接口）的 **EdgeOne Makers 改造版**：

- 原 PHP 接口全部移植为 **EdgeOne 边缘函数**（`edge-functions/` 目录，文件即路由），部署在腾讯 EdgeOne 全球 3200+ 边缘节点上
- 抖音解析复用项目自带的 Cloudflare Workers 版逻辑（与边缘函数运行时语法兼容），其余平台由 PHP 逐一移植为 JavaScript
- `api/sv.php` 聚合入口从「HTTP 自转发」改为「模块 import 直接调用」，省去一次回环请求
- `wyy.py`（Python/Flask 版网易云解析）移植为边缘函数（AES-128 + MD5 以纯 JS 实现，兼容 Web Crypto 运行时）
- 新增静态首页（`public/`）：平台列表、接口文档、在线解析测试

> ⚠️ 原项目重要声明继续适用：本项目仅用于学习交流与技术测试，解析素材的版权归原平台及权利人所有，不得用于任何非法用途。

## 📂 项目结构

```
short_videos-edgeone/
├── public/                        # 静态站点（Makers 构建输出目录）
│   ├── index.html                 #   首页：平台列表 + 在线测试 + 接口文档
│   └── img/                       #   图片资源（来自原项目）
├── edge-functions/                # 边缘函数（文件即路由）
│   └── api/
│       ├── sv.js                  #   聚合解析 /api/sv
│       ├── douyin.js              #   抖音 /api/douyin（视频/图集/实况，原画直链）
│       ├── douyin/home.js         #   抖音主页批量 /api/douyin/home（需 Cookie）
│       ├── kuaishou.js            #   快手 /api/kuaishou
│       ├── xiaohongshu.js         #   小红书 /api/xiaohongshu
│       ├── bilibili.js            #   哔哩哔哩 /api/bilibili（?ver=old 走旧版）
│       ├── weibo.js               #   微博·接口版 /api/weibo
│       ├── weibo_v.js             #   微博·爬虫版 /api/weibo_v
│       ├── toutiao.js             #   今日头条 /api/toutiao
│       ├── ppxia.js               #   皮皮虾 /api/ppxia
│       ├── pipigx.js              #   皮皮搞笑 /api/pipigx
│       ├── zuiyou.js              #   最右 /api/zuiyou
│       ├── wyy.js                 #   网易云音乐 /api/wyy（原 Python 版）
│       ├── doubao/video.js        #   豆包 AI 视频 /api/doubao/video
│       ├── doubao/duihua.js       #   豆包对话分享 /api/doubao/duihua
│       ├── jimengai.js            #   即梦 AI 视频 /api/jimengai
│       ├── proxy.js               #   媒体防盗链代理 /api/proxy
│       └── PORTING_CONVENTIONS.md #   移植统一约定（内部文档）
├── docs/                          # 原 JSON 格式文档
├── package.json
└── README.md
```

## 🚀 部署到 EdgeOne Makers

### 方式一：控制台直接上传（最快）

1. 登录 [EdgeOne Makers 控制台](https://edgeone.ai/zh/document/70404)，选择 **创建项目 → 直接上传**
2. 上传本项目压缩包（或先推到 Git 再导入）
3. 构建配置：**无需构建命令**，构建输出目录填 `public`（`edge-functions/` 会被平台自动识别并部署）
4. 部署完成后即可通过分配的域名访问，可再绑定自定义域名

### 方式二：Git 仓库导入（推荐，支持自动部署）

1. 将本项目推送到 GitHub / Gitee
2. Makers 控制台选择 **导入 Git 仓库** → 关联仓库
3. 构建输出目录填 `public`
4. 此后每次 push 自动触发部署

### 方式三：CLI 部署

```bash
npm install -g edgeone@latest
edgeone login
edgeone pages deploy   # 或本地调试：edgeone pages dev
```

### 环境变量

| 变量 | 必需 | 说明 |
|------|:---:|------|
| `DOUYIN_HOME_COOKIE` | 仅 /api/douyin/home 需要 | 抖音登录 Cookie，用于主页批量解析；其余接口均免 Cookie |

## 📖 接口速查

所有接口统一返回 `{code, msg, data}` JSON，入参支持 `GET ?url=` 或 `POST`（form/JSON body 的 `url` 字段），支持整段分享文本，开放 CORS。

| 路由 | 对应原 PHP 接口 |
|------|----------------|
| `/api/sv?url=` | `api/sv.php` |
| `/api/douyin?url=` | `api/douyin/douyin.php` |
| `/api/douyin/home?url=` | `api/douyin-home/home.php` |
| `/api/kuaishou?url=` | `api/kuaishou/ksjx.php` |
| `/api/xiaohongshu?url=` | `api/xiaohongshu/xhsjx.php` |
| `/api/bilibili?url=` | `api/bilibili/bilibili.php`（`&ver=old` 旧版） |
| `/api/weibo?url=` | `api/weibo.php` |
| `/api/weibo_v?url=` | `api/weibo_v.php` |
| `/api/toutiao?url=` | `api/toutiao.php` |
| `/api/ppxia?url=` | `api/ppxia.php` |
| `/api/pipigx?url=` | `api/pipigx.php` |
| `/api/zuiyou?url=` | `api/zuiyou.php` |
| `/api/wyy?url=` | `api/wyy.py` |
| `/api/doubao/video?url=` | `api/doubao/video/api.php` |
| `/api/doubao/duihua?url=` | `api/doubao/duihua/duihua.php` |
| `/api/jimengai?url=` | `api/jimengai/index.php` |
| `/api/proxy?proxyurl=` | `cf_sv_proxy/worker.js`（原 `api/svproxyurl.php`） |

> 视频直链 403 防盗链时，用 `/api/proxy?proxyurl=<直链>` 代理转发，支持 `type=douyin|weibo`、`download=true` 等参数，行为与原 `cf_sv_proxy` 一致。

字段说明详见 `docs/视频解析统一JSON格式3.0.md`。

## ⚠️ 与 PHP 版的行为差异（移植说明）

- 运行环境为边缘节点（UTC 时区）：`/api/douyin/home` 输出的 `create_time` 等时间字段与东八区 PHP 服务器相差 8 小时
- `json_encode(…, 480)` 的 `JSON_NUMERIC_CHECK` 语义未复刻：个别纯数字字符串字段（如新版 B 站 `cid`）JS 版保持字符串
- `sv.php` 聚合入口不再回环 HTTP 自转发，而是直接调用解析器模块，`$allowedHosts`/SSRF 防护不再需要
- 边缘函数单次执行 CPU 时间上限 200ms、代码包 5MB，本项目的纯 I/O 型解析逻辑不受影响
- **B 站取数链路变更**：原 view 接口（`x/web-interface/view`）在边缘节点出口 IP 上易被 412 风控，已改为 `pagelist → playurl`（`x/player/pagelist` → `x/player/playurl`）链路，**无需任何 Cookie** 即返回真实视频数据；标题/封面/作者改从视频页 `__INITIAL_STATE__`/meta 标签兜底提取（失败时该字段降级为 null，分P直链不受影响）

## 📄 许可证

MIT License（见 [LICENSE](LICENSE)），原项目版权归 [JH-Ahua](https://github.com/jiuhunwl/short_videos) 所有。
