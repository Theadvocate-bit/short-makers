# short-makers 部署排查（2026-11-14）

## 现状
- 线上 `https://a.didyou.lovie.me/`：静态文件部署成功（根 `/` 返回我写的 index.html，标题 `short-makers · 短视频解析 API`）。
- 但 `cloud-functions/` 下的函数全部 404（返回 EdgeOne 默认 404 HTML）：`/test`、`/parse`、`/proxy`、`/api/parse` 全 404。
- 本地 dev server（8787）一切正常；selftest 15-15 通过；语法全通过。**代码侧无问题。**

## 已验证/已排除（结论：不是代码问题）
1. 部署源确认是 Theadvocate-bit/short-makers（根 `/` 返回我写的 index.html 独特字符串）。
2. 函数目录结构完全符合官方文档（/document/node-functions）：`cloud-functions/parse/[[default]].js`→`/parse/*`、`cloud-functions/test.js`→`/test`，导出 `onRequest` 为合法入口。
3. 加了**零依赖最小测试函数 `/test`**（无 import、export default + 命名双导出）→ 仍 404。证明函数整体未被注册，与业务代码无关。
4. 导出风格 `export default` vs 命名 `export onRequest` 都试过 → 都 404。
5. 修了 edgeone.json：`maxDuration` 从 `cloudFunctions.maxDuration`（无效位置）移到 `cloudFunctions.nodejs.maxDuration`（正确位置）→ 仍 404。
6. 去掉了 `parse/[[default]].js` 里的**动态 `import()`**（曾导致整个构建失败、连静态文件都不部署；改静态 import 后静态文件恢复部署）→ 函数仍 404。

## 根因（待控制台确认）
EdgeOne Makers 构建/控制台层面**没有注册云函数**（静态构建成功、函数未被检测或打包）。代码侧无法修复，需控制台权限。

## 待用户在 Makers 控制台确认/操作
- 查 `a.didyou.lovie.me` 项目「Deployments」最近一次**构建日志**，看函数检测/打包是否有报错。
- 查项目「Settings - Build and Deployment Configuration」的**框架预设（Framework Preset）**：应设为 `None`/`Other`/`Auto`，不能是忽略 `cloud-functions/` 的静态框架。
- 查函数管理里是否根本没有列出任何函数（证明未被检测）。
- 兜底：删除项目重新 Import short-makers（默认配置），让 Makers 重新检测函数。

## 备选方案（若控制台搞不定）
- 若用户提供 EdgeOne **API Token**（非 GitHub token），可用 EdgeOne CLI / Makers SDK 直接部署并看到构建错误。

## 提交记录（本仓 /tmp/short-makers = Theadvocate-bit/short-makers）
- 4600631 加 /test 函数隔离 → 8dd95ea 修 maxDuration 位置 → 4530cfb /test 改 export default
- 最新 HEAD 4530cfb

## 下一步
- 等 Bilibili 函数在线上跑通后，继续移植其他平台（douyin/kuaishou/xiaohongshu/weibo/toutiao/pipixia/pipigx/zuiyou/网易云）。
- 平台识别（_lib/platforms.js）已全部移植，每个未移植平台调用返回 `code:-2` 明确提示。
