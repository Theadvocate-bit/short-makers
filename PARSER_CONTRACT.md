# 解析器移植契约（所有平台解析器必须遵守）

每个平台解析器是一个 ES Module，导出**唯一的** `parse` 函数。移植自 short_videos 的对应 PHP。

## 1. 文件位置与导出
- 路径：`cloud-functions/_lib/parsers/<platform>.js`
- 导出：`export async function parse(url, env)` —— **只导出这一个 parse**，不要导出 `onRequest`。
  （多个模块若都导出 `onRequest`，esbuild 打包会报 `onRequest has already been declared` 导致构建失败。）
- **禁止动态 `import()`**：Makers 打包器对 `[[default]].js` 里的动态 import 会构建失败 Code 18。
  需要共享工具就静态 `import`，或直接内联。

## 2. 函数签名
```js
export async function parse(url, env = {}) { ... }
```
- `url`：用户提交的视频链接（字符串）。
- `env`：环境变量对象，含：
  - `env.PROXY_BASE`：本部署防盗链代理基地址，形如 `https://a.didyou.lovie.me/api/proxy?proxyurl=`
    —— douyin/weibo 等解析出的媒体直链有防盗链，**必须**用
    `env.PROXY_BASE + btoa(直链)` 包一层返回（见下方代理规则）。
  - `env.<PLATFORM>_COOKIE`：该平台 cookie（可选，如 `env.DOUYIN_COOKIE`）。PHP 里写死
    「自行更新」的 cookie，移植时改成读 `env.<PLATFORM>_COOKIE`，没有就不带 Cookie 头。

## 3. 返回值
**必须返回一个 `Response` 对象**（不是普通对象）。统一用这个 helper（每个文件自带一份）：
```js
function jsonOut(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
```
返回体是统一 JSON：`{ code, msg, data? }`（沿用原 PHP 的 code/msg 语义）：
- 成功：`{ code: 200, msg: '解析成功！', data: { ... } }`
- 链接为空：`{ code: 201, msg: '链接不能为空！' }`
- 无法识别/链接不对：`{ code: -1, msg: '...' }`
- 上游失败：`{ code: 0, msg: '解析失败！', detail? }`

## 4. data 字段（尽量对齐原 PHP 输出）
常见字段：`title`、`cover`、`url`（视频直链或代理后的直链）、`author`/`user`、`description`、
`videos`（多 P/多清晰度数组）、`duration`。有原 PHP 的 `video_backup`（多清晰度）就保留。

## 5. 媒体直链防盗链代理规则（douyin/weibo 等必需）
解析出的视频/封面/头像直链若来自有防盗链的 CDN，返回前用本部署代理包裹：
```js
const proxied = (rawUrl) => rawUrl ? (env.PROXY_BASE || '') + btoa(rawUrl) : '';
// 用法：url: proxied(videoUrl), cover: proxied(coverUrl)
```
（`btoa` 对含非 ASCII 的 URL 先 `encodeURI` 或用 `btoa(unescape(encodeURIComponent(s)))`。）
若原 PHP 已自带第三方代理前缀（如 `https://svproxy.168299.xyz/...`），**替换成 `env.PROXY_BASE`**。

## 6. 网络请求
只用边缘运行时标准 `fetch`（无 node:crypto 之外的 npm 包）。带防盗链的平台请求要带
`User-Agent` + `Referer`。跟随短链用 `redirect: 'manual'` 取 `location`。

## 7. 自检
写完运行 `node --check cloud-functions/_lib/parsers/<platform>.js` 必须通过；
`node -e "import('...').then(m=>console.log(typeof m.parse))"` 应输出 `function`。

## 模板参考
`cloud-functions/_lib/parsers/toutiao.js` 和 `bilibili.js` 是标准范例，照结构写。
