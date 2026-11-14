/**
 *@Author: JH-Ahua
 * @CreateTime: 2025/8/5 下午2:19
 *@email: admin@bugpk.com
 *@blog: www.jiuhunwl.cn
 *@Api: api.bugpk.com
 *@tip: 皮皮搞笑去水印解析
 *@Remark: 已由 PHP 版移植为 EdgeOne Makers 边缘函数版
 */

const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type",
};

// PHP (int) 强制转换等价实现
function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}

// PHP isset() 等价：存在且不为 null
function issetVal(v) {
  return v !== undefined && v !== null;
}

/**
 * 格式化响应信息（对应 PHP formatResponse）
 */
function formatResponse(code = 200, msg = "解析成功", data = []) {
  return {
    code: code,
    msg: msg,
    data: data,
  };
}

/**
 * 从 URL 中提取 pid 和 mid 参数（对应 PHP extractParamsFromUrl）
 */
function extractParamsFromUrl(url) {
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
  const pidAll = params.getAll("pid");
  const midAll = params.getAll("mid");
  const pid = pidAll.length > 0 ? pidAll[pidAll.length - 1] : null;
  const mid = midAll.length > 0 ? midAll[midAll.length - 1] : null;
  if (pid === null || mid === null) {
    return null;
  }
  return { pid: pid, mid: mid };
}

/**
 * 发送 POST 请求到指定 API（对应 PHP sendPostRequest）
 * 注意：PHP curl 未开启 CURLOPT_FOLLOWLOCATION，不跟随重定向
 */
async function sendPostRequest(apiurl, payload) {
  const jsonPayload = JSON.stringify(payload);
  try {
    const resp = await fetch(apiurl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Content-Length 由 fetch 自动计算
      },
      body: jsonPayload,
      redirect: "manual",
      signal: timeoutSignal(30000),
    });
    const responseText = await resp.text();
    return { code: resp.status, response: responseText };
  } catch (e) {
    return { code: 500, msg: "请求发生错误: " + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * 处理 API 响应（对应 PHP processApiResponse）
 */
function processApiResponse(apiResponse) {
  const httpCode = apiResponse.code;
  // PHP: $apiResponse['response'] 不存在时为 null（拼接后为空串）
  const response = issetVal(apiResponse.response) ? String(apiResponse.response) : "";
  if (httpCode >= 400) {
    return formatResponse(httpCode, "HTTP 错误发生: HTTP 状态码 " + httpCode);
  }
  let decodedResponse = null;
  try {
    decodedResponse = JSON.parse(response);
  } catch (e) {
    decodedResponse = null;
  }
  if (decodedResponse === null) {
    return formatResponse(500, "响应内容不是有效的 JSON 数据: " + response);
  }
  const post =
    decodedResponse !== null &&
    typeof decodedResponse === "object" &&
    issetVal(decodedResponse.data) &&
    typeof decodedResponse.data === "object"
      ? decodedResponse.data.post
      : undefined;
  if (!issetVal(post)) {
    return formatResponse(500, "响应中缺少 data.post 字段");
  }
  const json = post;
  const videoData = [];
  if (issetVal(json.videos) && typeof json.videos === "object") {
    for (const video of Object.values(json.videos)) {
      if (video !== null && typeof video === "object") {
        videoData.push(video);
      }
    }
  }
  const first = videoData.length > 0 ? videoData[0] : null;
  const arr = {
    title: issetVal(json.content) ? json.content : null,
    cover:
      "https://file.ippzone.com/img/frame/id/" +
      (first !== null && issetVal(first.thumb) ? first.thumb : ""),
    video: first !== null && issetVal(first.url) ? first.url : null,
  };
  return formatResponse(200, "解析成功", arr);
}

export async function parse(shareUrl, env) {
  const url = shareUrl;
  if (url === null || url === undefined) {
    return { code: 400, msg: "未提供 url 参数" };
  }

  // 提取参数
  const params = extractParamsFromUrl(url);
  if (params === null) {
    return { code: 400, msg: "提取参数出错" };
  }

  // 构建请求体数据
  const apiurl = "https://h5.pipigx.com/ppapi/share/fetch_content";
  const payload = {
    pid: toInt(params.pid),
    mid: toInt(params.mid),
    type: "post",
  };

  // 发送请求
  const apiResponse = await sendPostRequest(apiurl, payload);
  const finalResponse = processApiResponse(apiResponse);

  return finalResponse;
}

export function jsonResponse(data) {
  return new Response(JSON.stringify(data), { status: 200, headers: CORS_HEADERS });
}

export async function onRequest(context) {
  const request = context.request;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const u = new URL(request.url);
  // PHP: isset($_GET['url']) 时使用 REQUEST_URI（原始路径+查询串）；否则 POST 分支取 $_POST['url']
  let urlValue = null;
  if (u.searchParams.has("url")) {
    urlValue = u.pathname + u.search;
  } else if (request.method === "POST") {
    try {
      const form = await request.formData();
      if (form.has("url")) {
        urlValue = String(form.get("url"));
      }
    } catch (e) {
      urlValue = null;
    }
  }
  if (urlValue === null) {
    return new Response(JSON.stringify(formatResponse(400, "未提供 url 参数")), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }
  let result;
  try {
    result = await parse(urlValue, context.env);
  } catch (e) {
    result = {
      code: 500,
      msg: "解析失败: " + (e && e.message ? e.message : "未知错误"),
      data: [],
    };
  }
  // PHP: http_response_code($finalResponse['code']) —— HTTP 状态码与 JSON code 一致
  return new Response(JSON.stringify(result), {
    status: Number(result.code) || 200,
    headers: CORS_HEADERS,
  });
}

// ---------- 兼容性辅助：边缘函数运行时不支持 AbortSignal.timeout() ----------
function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), Number(ms) || 0);
  return controller.signal;
}
