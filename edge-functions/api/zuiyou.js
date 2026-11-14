/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/3/31 上午11:25
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: 最右解析
 * @Remark: 已由 PHP 版移植为 EdgeOne Makers 边缘函数版
 */

const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type",
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

// PHP (int) 强制转换等价实现
function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}

// PHP empty() 等价实现
function phpEmpty(v) {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    v === 0 ||
    v === "0" ||
    v === false ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)
  );
}

// PHP isset() 等价：存在且不为 null
function issetVal(v) {
  return v !== undefined && v !== null;
}

// PHP rawurldecode() 等价实现：不转换 '+'，非法序列保留原文
function rawUrlDecode(str) {
  const s = String(str);
  try {
    return decodeURIComponent(s.replace(/%(?![0-9A-Fa-f]{2})/g, "%25"));
  } catch (e) {
    return s;
  }
}

/**
 * 构建统一格式的响应数组（对应 PHP outputJson）
 */
function outputJson(code, msg, data = []) {
  return {
    code: code,
    msg: msg,
    data: data,
  };
}

/**
 * 从URL中提取指定参数（对应 PHP getParamFromUrl：parse_url + parse_str）
 */
function getParamFromUrl(url, param) {
  const qIndex = String(url).indexOf("?");
  if (qIndex === -1) {
    return null;
  }
  let query = String(url).slice(qIndex + 1);
  const hashIndex = query.indexOf("#");
  if (hashIndex !== -1) {
    query = query.slice(0, hashIndex);
  }
  // parse_str 等价：同名参数后者覆盖前者
  const params = new URLSearchParams(query);
  const all = params.getAll(param);
  return all.length > 0 ? all[all.length - 1] : null;
}

/**
 * 获取URL重定向后的最终地址（对应 PHP getRedirectUrl：HEAD 请求、不跟随重定向、读取 Location 头）
 */
async function getRedirectUrl(url) {
  let httpCode = 0;
  let location = null;
  try {
    const resp = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      headers: { "user-agent": USER_AGENT },
      // PHP CURLOPT_TIMEOUT=12
      signal: timeoutSignal(12000),
    });
    httpCode = resp.status;
    location = resp.headers.get("location");
  } catch (e) {
    // curl 失败时返回原 URL
    return url;
  }

  // 处理3xx重定向状态码
  if (httpCode >= 300 && httpCode < 400 && location !== null) {
    let redirectUrl = location.trim();
    // 处理相对路径
    if (redirectUrl.indexOf("http") !== 0) {
      let origin = "";
      try {
        const parsedOriginal = new URL(url);
        origin = parsedOriginal.protocol + "//" + parsedOriginal.host;
      } catch (e) {
        origin = "";
      }
      redirectUrl = origin + redirectUrl;
    }
    return redirectUrl;
  }

  // 无重定向或获取失败，返回原URL
  return url;
}

/**
 * 从URL或其重定向地址中提取指定参数（对应 PHP getParamFromUrlWithRedirect）
 */
async function getParamFromUrlWithRedirect(url, param) {
  // 先尝试从原始URL提取参数
  let value = getParamFromUrl(url, param);
  if (!phpEmpty(value)) {
    return value;
  }

  // 原始URL无参数，获取重定向后的URL再尝试提取
  const redirectUrl = await getRedirectUrl(url);
  if (redirectUrl && redirectUrl !== url) {
    value = getParamFromUrl(redirectUrl, param);
    if (!phpEmpty(value)) {
      return value;
    }
  }

  return null;
}

/**
 * curl请求处理函数（对应 PHP curlRequest：跟随重定向、AUTOREFERER）
 */
async function curlRequest(url, headers = null, data = null) {
  try {
    const fetchHeaders = { "user-agent": USER_AGENT };
    if (issetVal(headers)) {
      Object.assign(fetchHeaders, headers);
    }
    const resp = await fetch(url, {
      method: issetVal(data) ? "POST" : "GET",
      headers: fetchHeaders,
      body: issetVal(data) ? data : undefined,
      redirect: "follow",
      // PHP CURLOPT_TIMEOUT=20
      signal: timeoutSignal(20000),
    });
    return await resp.text();
  } catch (e) {
    // PHP: trigger_error 并返回 false
    return null;
  }
}

export async function parse(shareUrl, env) {
  // 获取并验证输入URL（修复编码和参数截断问题）
  let url = shareUrl === undefined || shareUrl === null ? "" : String(shareUrl);
  url = url.trim();

  if (phpEmpty(url)) {
    return outputJson(201, "请输入url");
  }

  // 验证URL格式（等价 filter_var FILTER_VALIDATE_URL）
  try {
    new URL(url);
  } catch (e) {
    return outputJson(201, "请输入有效的URL");
  }

  // 提取pid和vid参数
  const pid = await getParamFromUrlWithRedirect(url, "pid");
  if (phpEmpty(pid)) {
    return outputJson(201, "找不到有效的pid参数（包括重定向后）");
  }
  const vidFromUrl = await getParamFromUrlWithRedirect(url, "vid");

  // 调用API获取数据
  const apiUrl = "https://share.xiaochuankeji.cn/planck/share/post/detail_h5";
  const requestData = JSON.stringify({
    pid: toInt(pid),
    h_av: "5.2.13.011",
  });

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const apiResponse = await curlRequest(apiUrl, headers, requestData);
  if (apiResponse === null) {
    return outputJson(500, "API请求失败");
  }

  let data = null;
  try {
    data = JSON.parse(apiResponse);
  } catch (e) {
    return outputJson(500, "API响应解析失败: " + (e && e.message ? e.message : "Syntax error"));
  }

  // 安全提取数据，避免未定义索引错误
  const postData =
    data !== null && typeof data === "object" && issetVal(data.data) && typeof data.data === "object"
      ? data.data.post ?? []
      : [];
  const memberData = postData !== null && typeof postData === "object" ? postData.member ?? [] : [];
  const videosData = postData !== null && typeof postData === "object" ? postData.videos ?? [] : [];
  const imgsData = postData !== null && typeof postData === "object" ? postData.imgs?.[0] ?? [] : [];
  // PHP: $vid = $imgsData['id']（不存在时为 null）
  const vid = imgsData !== null && typeof imgsData === "object" ? imgsData["id"] ?? null : null;
  let responseData = null;
  if (phpEmpty(vid)) {
    // 注意：PHP 版此处虽赋值，但随后被无条件覆盖（保留原逻辑）
    responseData = outputJson(201, "找不到有效的vid参数（包括重定向后）");
  }
  const json = {
    author: memberData !== null && typeof memberData === "object" ? memberData["name"] ?? null : null,
    avatar:
      memberData !== null && typeof memberData === "object"
        ? memberData["avatar_urls"]?.["origin"]?.["urls"]?.[0] ?? null
        : null,
    title: postData !== null && typeof postData === "object" ? postData["content"] ?? null : null,
    cover:
      imgsData !== null && typeof imgsData === "object"
        ? imgsData["urls"]?.["540_webp"]?.["urls"]?.[0] ?? null
        : null,
    url: videosData !== null && typeof videosData === "object" ? videosData[vid]?.["url"] ?? null : null,
  };

  responseData = outputJson(200, "请求成功", json);

  return responseData;
}

export function jsonResponse(data) {
  return new Response(JSON.stringify(data), { status: 200, headers: CORS_HEADERS });
}

export async function onRequest(context) {
  const request = context.request;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  // PHP: 在原始 QUERY_STRING 中定位 url=，取其后全部内容并 rawurldecode（保留后续参数）
  const u = new URL(request.url);
  const queryString = u.search.startsWith("?") ? u.search.slice(1) : u.search;
  let input = "";
  const urlStart = queryString.indexOf("url=");
  if (urlStart !== -1) {
    const urlPart = queryString.slice(urlStart + 4);
    input = rawUrlDecode(urlPart);
  }
  input = String(input).trim();
  try {
    return jsonResponse(await parse(input, context.env));
  } catch (e) {
    return jsonResponse({
      code: 500,
      msg: "解析失败: " + (e && e.message ? e.message : "未知错误"),
      data: [],
    });
  }
}

// ---------- 兼容性辅助：边缘函数运行时不支持 AbortSignal.timeout() ----------
function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), Number(ms) || 0);
  return controller.signal;
}
