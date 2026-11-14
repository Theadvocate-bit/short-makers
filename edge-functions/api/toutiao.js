/**
 * @Author: JH-Ahua
 * @CreateTime: 2025/10/24 下午10:37
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: 今日头条去水印解析
 * @Remark: 已由 PHP 版移植为 EdgeOne Makers 边缘函数版
 */

const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type",
};

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

// PHP urldecode() 等价实现：%xx 解码，'+' 转空格，非法序列保留原文
function urlDecode(str) {
  let s = String(str).replace(/\+/g, " ");
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return decodeURIComponent(s.replace(/%(?![0-9A-Fa-f]{2})/g, "%25"));
  }
}

// 对应 PHP curl()：跟随重定向、AUTOREFERER
async function fetchText(url, headers = null, data = null) {
  try {
    const resp = await fetch(url, {
      method: data !== null && data !== undefined ? "POST" : "GET",
      headers: headers === null ? undefined : headers,
      body: data === null || data === undefined ? undefined : data,
      redirect: "follow",
      signal: timeoutSignal(30000),
    });
    return await resp.text();
  } catch (e) {
    // PHP curl 失败时 trigger_error 并返回 false
    return null;
  }
}

// 对应 PHP extractId()：get_headers 解析重定向链，取最终地址
async function extractId(url) {
  let loc = url;
  try {
    const resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: timeoutSignal(30000),
    });
    // 等价 PHP：Location 头数组 end() 或无重定向时的原 URL
    if (resp.url) {
      loc = resp.url;
    }
  } catch (e) {
    // get_headers 失败时直接使用原始 URL
    loc = url;
  }

  if (typeof loc !== "string") {
    loc = String(loc);
  }

  const m = /[0-9]+|(?<=video\/)[0-9]+/.exec(loc);
  return m ? m[0] : null;
}

// 对应 PHP toutiao()
async function toutiao(url) {
  // 构造请求数据
  const header = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.69 Safari/537.36",
    Cookie: "自行更新",
  };
  // 尝试从 URL 中获取视频 ID
  const id = await extractId(url);
  // 检查 ID 是否有效
  if (phpEmpty(id)) {
    return { code: 400, msg: "无法解析视频 ID" };
  }

  // 发送请求获取视频信息
  const response = await fetchText("https://www.toutiao.com/video/" + id, header);
  // PHP: curl 失败返回 false 后 strpos(false) 直接致命错误，这里以抛错等价处理
  if (response === null) {
    throw new Error("cURL error: 请求失败");
  }

  const startStr = '<script id="RENDER_DATA" type="application/json">';
  const endStr = "</script>";

  // 查找起始位置
  const posStart = response.indexOf(startStr);
  if (posStart === -1) {
    return { code: 404, msg: "无法找到数据" };
  }

  // 获取起始位置之后的文本内容
  let jsonStr = response.slice(posStart + startStr.length);
  // 查找结束位置
  const posEnd = jsonStr.indexOf(endStr);
  if (posEnd === -1) {
    // 如果没找到结束位置，返回错误响应
    return { code: 404, msg: "无法正确提取JSON数据，未找到结束标签" };
  }

  // 截取中间的JSON字符串部分
  jsonStr = jsonStr.slice(0, posEnd);
  // 对URL编码的内容进行解码
  jsonStr = urlDecode(jsonStr);

  // 将JSON字符串解析为对象
  let videoInfo = null;
  try {
    videoInfo = JSON.parse(jsonStr);
  } catch (e) {
    // 如果JSON解析失败，返回错误响应
    return { code: 404, msg: "JSON解析失败：" + (e && e.message ? e.message : "Syntax error") };
  }

  const data =
    videoInfo !== null && typeof videoInfo === "object" ? videoInfo["data"] ?? null : null;
  // PHP: empty($data) && empty($data['itemId'])
  const dataItemId =
    data !== null && typeof data === "object" && !Array.isArray(data) ? data["itemId"] ?? null : null;
  if (phpEmpty(data) && phpEmpty(dataItemId)) {
    return {
      code: 404,
      msg: "当前分享链接已失效！",
      data: [],
    };
  }

  const initialVideo = data && typeof data === "object" ? data["initialVideo"] : null;
  const itemCell = initialVideo && typeof initialVideo === "object" ? initialVideo["itemCell"] : null;
  const userInfo = itemCell && typeof itemCell === "object" ? itemCell["userInfo"] : null;
  const videoPlayInfo =
    initialVideo && typeof initialVideo === "object" ? initialVideo["videoPlayInfo"] : null;
  const videoList =
    videoPlayInfo && typeof videoPlayInfo === "object" ? videoPlayInfo["video_list"] : null;

  // 构造返回数据
  return {
    code: 200,
    msg: "解析成功",
    data: {
      itemId: (data && typeof data === "object" ? data["itemId"] : undefined) ?? null,
      videoType: (data && typeof data === "object" ? data["videoType"] : undefined) ?? null,
      author: (userInfo && typeof userInfo === "object" ? userInfo["name"] : undefined) ?? null,
      userID: (userInfo && typeof userInfo === "object" ? userInfo["userID"] : undefined) ?? null,
      avatar: (userInfo && typeof userInfo === "object" ? userInfo["avatarURL"] : undefined) ?? null,
      description:
        (userInfo && typeof userInfo === "object" ? userInfo["description"] : undefined) ?? null,
      title: (initialVideo && typeof initialVideo === "object" ? initialVideo["title"] : undefined) ?? null,
      cover: (initialVideo && typeof initialVideo === "object" ? initialVideo["coverUrl"] : undefined) ?? null,
      url:
        ((videoList && typeof videoList === "object" ? videoList[2]?.["main_url"] : undefined) ??
          (videoList && typeof videoList === "object" ? videoList[1]?.["main_url"] : undefined)) ??
        null,
      music: (itemCell && typeof itemCell === "object" ? itemCell["videoAbility"]?.["music"] : undefined) ?? null,
    },
  };
}

export async function parse(shareUrl, env) {
  const url = shareUrl === undefined || shareUrl === null ? "" : String(shareUrl);
  if (phpEmpty(url)) {
    return { code: 201, msg: "url为空" };
  }
  const response = await toutiao(url);
  if (phpEmpty(response)) {
    return { code: 404, msg: "获取失败" };
  }
  return response;
}

export function jsonResponse(data) {
  return new Response(JSON.stringify(data), { status: 200, headers: CORS_HEADERS });
}

export async function onRequest(context) {
  const request = context.request;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  // PHP 仅读取 $_GET['url']
  const u = new URL(request.url);
  let input = u.searchParams.get("url") || "";
  input = String(input).trim();
  if (!input) {
    return jsonResponse({ code: 201, msg: "url为空" });
  }
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
