# short-makers 部署排查（2026-11-14）—— 已解决

## 结论：部署阻塞已彻底解决，生产三端点全通

### 根因链（三个叠加的坑，已全部修复）
1. **bare 路径不命中 catch-all**：Makers 的 `[[default]].js` 生成的路由是 `^/parse/(.*)$`
   （必须 `/parse/子路径`），bare `/parse` 404。修法：统一挂 `/api/*`，用 `/api/parse`、`/api/proxy`。
2. **[[default]].js 里的动态 import() 导致构建失败 Code 18**：提交 175d025 就栽在这。
   必须用静态 import。
3. **静态 import 两个都导出 onRequest 的模块 → esbuild 符号冲突**
   （`The symbol "onRequest" has already been declared`）。
   修法：把 parse+proxy 合并成**单个自包含 `cloud-functions/api/[[default]].js`**，
   内部一个 `onRequest` 按子路径分发到 `handleParse`/`handleProxy`。

### 诊断手段（关键）
- 用 EdgeOne API Token（用户提供）装 `edgeone` CLI（`npm i -g edgeone`，
  bin 在 `/app/user-packages/node/bin/edgeone`），`edgeone login -t <token>`。
- **本地 CLI 构建**能立即暴露打包错误（动态 import / 符号冲突），不必反复推 GitHub 试错。
- **Makers REST API 查部署列表/状态/路由**：
  `POST https://pages-api.edgeone.ai/v1`，body `{Action:"DescribePagesDeployments",ProjectId,...}`，
  Bearer token。MetaData.routes 能看到实际生成的路由正则（确诊 bare 路径问题）。
- 用 Upload 类型诊断项目 `short-makers-diag`（`edgeone makers deploy -n short-makers-diag`）
  做部署验证；GitHub 连接的生产项目 `short-makers`（makers-xbn77x4v69wv）不支持直接 deploy。

### 当前生产状态（commit 537f329，UsedInProd）
`https://a.didyou.lovie.me`，路由 `^/api/(.*)$` → api-node：
- `/api/parse?url=<B站链接>` → 200，解析器已运行（无 cookie 时返回 B站 412 风控提示）
- `/api/parse?url=<不支持>` → code -1 + 9 平台列表
- `/api/parse?url=<douyin等>` → code -2 待移植提示
- `/api/proxy` → 400/200 正常（媒体防盗链代理）

### 唯一遗留：Bilibili 412 风控
代码正确、跑到 fetch，但 B 站对「数据中心 IP + 无 cookie」返回 412。
**解法**：在 Makers 控制台为 `short-makers` 项目配置环境变量 `BILIBILI_COOKIE`
（或用 CLI `edgeone makers env set BILIBILI_COOKIE <值>`）。
配置后 `/api/parse` 的 B站链接即返回真实视频数据。

## 最终结构
```
cloud-functions/
├── api/[[default]].js      # 单一入口：/api/parse + /api/proxy + /api（按子路径分发）
└── _lib/
    ├── platforms.js        # 9 平台识别 + IMPLEMENTED（已移植 bilibili）
    └── parsers/bilibili.js # B站解析器（需 BILIBILI_COOKIE 过 412）
```

## 下一步
- 配置 BILIBILI_COOKIE 让 B站解析真正通过（用户提供 cookie）。
- B站通过后继续移植其他平台（douyin/kuaishou/xiaohongshu/weibo/toutiao/pipixia/pipigx/zuiyou/网易云）。
- 平台识别（platforms.js）已全部就位，未移植平台返回 code:-2。
