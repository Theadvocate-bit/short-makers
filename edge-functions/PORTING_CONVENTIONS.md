# EdgeOne Makers 移植统一约定（所有边缘函数必须遵守）

1. 运行环境：EdgeOne Makers 边缘函数，标准 Web API（fetch/Request/Response/URL/URLSearchParams/TextEncoder/TextDecoder/Web Crypto/Cache）。仅 JavaScript（ES2023+）。禁止 Node API（fs/crypto/Buffer/process）、禁止 addEventListener、禁止第三方依赖，单文件自包含。

2. 每个解析器文件必须导出两个函数：

   - `export async function parse(shareUrl, env)`：参数为用户输入的分享文本/链接字符串与 EdgeOne 环境变量对象（可能为 undefined）；返回**最终 JSON 对象**（即原 PHP 版 echo 的内容结构，字段名、层级、错误结构 {code,msg,data} 必须与 PHP 版完全一致）。
   - `export async function onRequest(context)`：处理请求，返回带 CORS 头的 JSON Response。

   标准包装器模板（可直接复制到每个文件末尾，按需调整）：

```js
const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type",
};

export function jsonResponse(data) {
  return new Response(JSON.stringify(data), { status: 200, headers: CORS_HEADERS });
}

export async function onRequest(context) {
  const request = context.request;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  let input = "";
  const u = new URL(request.url);
  input = u.searchParams.get("url") || "";
  if (!input && request.method === "POST") {
    try {
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const body = await request.json();
        input = (body && body.url) || "";
      } else {
        const form = await request.formData();
        input = form.get("url") || "";
      }
    } catch (e) {
      input = "";
    }
  }
  input = String(input).trim();
  if (!input) {
    return jsonResponse({ code: 400, msg: "请输入有效的链接", data: [] });
  }
  try {
    return jsonResponse(await parse(input, context.env));
  } catch (e) {
    return jsonResponse({ code: 500, msg: "解析失败: " + (e && e.message ? e.message : "未知错误"), data: [] });
  }
}
```

3. PHP → JS 移植要点：
   - curl → fetch：保留 UA、Referer、Cookie 等请求头；fetch 默认跟随 302；如 PHP 显式 `CURLOPT_FOLLOWLOCATION=false` 或需要读取 Location，使用 `redirect: "manual"`。
   - `json_decode($resp, true)` → `JSON.parse(...)`；PHP 代码里常见的 `preg_replace` 转义预处理（如 `\/`、`\\u002F` 等）要逐一对应实现。
   - `json_encode($data, 480)` → `JSON.stringify(data)`（JS 默认即不转义 unicode/slash）。
   - PHP 正则 → JS 正则：去掉分隔符与修饰符（`i`→`i`，`u`/`s` 按需），命名组 `(?<name>)` → `(?<name>)`（JS 同样支持）。
   - `strip_tags` → 用正则 `<[^>]*>` 去除。
   - 输出 JSON 结构、字段名、msg 文案必须与 PHP 版保持一致。
   - 超时：对上游 fetch 使用 `AbortSignal.timeout(30000)`。

4. 文件头注释：保留原作者信息（@Author/@email 等），追加一行 `@Remark: 已由 PHP 版移植为 EdgeOne Makers 边缘函数版`。

5. 完成后必须用 `node --check <文件路径>` 校验语法通过。
