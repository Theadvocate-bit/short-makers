
// 边缘运行时不支持 AbortSignal.timeout，用受支持的 AbortController 实现超时
function abortSignalTimeout(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 *@Author: JH-Ahua
 *@CreateTime: 2026/4/30 23:27
 *@email: admin@bugpk.com
 *@blog: www.jiuhunwl.cn
 *@Api: api.bugpk.com
 *@tip: 微博视频去水印解析（非文章视频图文解析）
 *@Remark: 已由 PHP 版移植为 EdgeOne Makers 边缘函数版
 */

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30000;

const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type",
};

// PHP base64_encode 等价实现（按字节编码）
function base64Encode(str) {
  const bytes = new TextEncoder().encode(String(str));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
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

// 对应 PHP getRedirectUrl()：HEAD 请求且不跟随重定向，读取 Location（CURLOPT_FOLLOWLOCATION=false）
async function getRedirectUrl(url) {
  try {
    const resp = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: abortSignalTimeout(TIMEOUT_MS),
    });
    const location = resp.headers.get("location");
    if (location === null || location === undefined) {
      return "";
    }
    // CURLINFO_REDIRECT_URL 返回绝对地址
    return new URL(location, url).href;
  } catch (e) {
    return "";
  }
}

// 对应 PHP extractVideoId()
async function extractVideoId(url) {
  let id = "";

  if (url.indexOf("video.weibo.com/show") !== -1) {
    let fid = null;
    try {
      const parsedUrl = new URL(url);
      fid = parsedUrl.searchParams.get("fid");
    } catch (e) {
      fid = null;
    }
    id = fid === null ? "" : fid;
  } else if (url.indexOf("weibo.com/tv/") !== -1) {
    let fid = null;
    try {
      const parsedUrl = new URL(url);
      fid = parsedUrl.searchParams.get("fid");
    } catch (e) {
      fid = null;
    }
    id = fid === null ? "" : fid;
    if (phpEmpty(id)) {
      const m = /weibo\.com\/tv\/(show|v)\/([^?&]+)/.exec(url);
      id = m ? m[2] : "";
    }
  } else if (url.indexOf("t.cn/") !== -1) {
    const redirectUrl = await getRedirectUrl(url);
    id = !phpEmpty(redirectUrl) ? await extractVideoId(redirectUrl) : "";
  }

  return id;
}

// 对应 PHP getRequestHeaders()：微博web端cookie
function getRequestHeaders() {
  return {
    cookie: "",
    referer: "https://weibo.com/",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
  };
}

// 对应 PHP sendCurlRequest()：跟随重定向（最多 MAX_REDIRECTS 次）
async function sendCurlRequest(url, postData = "", headers = {}, isJsonResponse = false) {
  let httpCode = 0;
  let body = "";
  let error = null;
  try {
    const fetchHeaders = { ...headers };
    if (postData !== "") {
      // curl 的 CURLOPT_POSTFIELDS 字符串默认以 application/x-www-form-urlencoded 发送
      fetchHeaders["content-type"] = "application/x-www-form-urlencoded";
    }
    const resp = await fetch(url, {
      method: postData !== "" ? "POST" : "GET",
      headers: fetchHeaders,
      body: postData !== "" ? postData : undefined,
      redirect: "follow",
      signal: abortSignalTimeout(TIMEOUT_MS),
    });
    httpCode = resp.status;
    body = await resp.text();
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  }

  if (error) {
    if (isJsonResponse) {
      return { code: 500, msg: `cURL错误: ${error}` };
    }
    return false;
  }

  if (httpCode >= 400) {
    if (isJsonResponse) {
      return { code: httpCode, msg: `API请求失败，HTTP状态码: ${httpCode}` };
    }
    return false;
  }

  return body;
}

// 对应 PHP fetchVideoInfo()
async function fetchVideoInfo(videoId, headers) {
  const apiUrl = "https://weibo.com/tv/api/component";
  const pagePath = `/tv/show/${videoId}`;
  const requestUrl = `${apiUrl}?page=` + encodeURIComponent(pagePath);

  const requestData = {
    Component_Play_Playinfo: { oid: videoId },
  };
  const postData = "data=" + encodeURIComponent(JSON.stringify(requestData));
  const response = await sendCurlRequest(requestUrl, postData, headers, true);

  if (response !== null && response !== false && typeof response === "object") {
    return response;
  }

  if (phpEmpty(response)) {
    return { code: 500, msg: "API请求失败，无响应数据" };
  }

  let responseData;
  try {
    responseData = JSON.parse(response);
  } catch (e) {
    return { code: 500, msg: "API响应解析失败", raw: response };
  }

  const hasCode =
    responseData !== null &&
    typeof responseData === "object" &&
    responseData.code !== undefined &&
    responseData.code !== null;
  const playInfo =
    responseData !== null &&
    typeof responseData === "object" &&
    responseData.data !== undefined &&
    responseData.data !== null &&
    typeof responseData.data === "object"
      ? responseData.data.Component_Play_Playinfo
      : undefined;

  if (hasCode && responseData.code == 100000 && !phpEmpty(playInfo)) {
    const proxyBase = "https://svproxy.168299.xyz/?type=weibo&proxyurl=";
    const videoInfo = playInfo;

    const backupUrls = [];
    let bestQuality = { priority: -1, url: "", label: "", quality: "" };

    if (videoInfo.urls !== undefined && videoInfo.urls !== null && typeof videoInfo.urls === "object") {
      for (const quality of Object.keys(videoInfo.urls)) {
        const urlValue = videoInfo.urls[quality];
        const fullUrl =
          proxyBase + base64Encode("https:" + (urlValue === null || urlValue === undefined ? "" : String(urlValue)));
        let qualityKey = "unknown";
        let priority = 0;

        if (String(quality).indexOf("2K") !== -1) {
          qualityKey = "origin";
          priority = 4;
        } else if (String(quality).indexOf("1080P") !== -1) {
          qualityKey = "origin";
          priority = 3;
        } else if (String(quality).indexOf("720P") !== -1) {
          qualityKey = "origin";
          priority = 2;
        } else if (String(quality).indexOf("480P") !== -1) {
          qualityKey = "hd";
          priority = 1;
        } else if (String(quality).indexOf("360P") !== -1) {
          qualityKey = "sd";
          priority = 0;
        }

        backupUrls.push({ label: quality, quality: qualityKey, url: fullUrl });

        if (priority > bestQuality.priority) {
          bestQuality = { priority: priority, url: fullUrl, label: quality, quality: qualityKey };
        }
      }
    }

    const mainUrl = bestQuality.url;
    const mainQuality = bestQuality.quality;

    // PHP: is_numeric($videoInfo['duration_time']) ? (int)... : 0
    let duration = 0;
    if (videoInfo.duration_time !== undefined && videoInfo.duration_time !== null) {
      const n = Number(videoInfo.duration_time);
      if (!Number.isNaN(n)) {
        duration = Math.trunc(n);
      }
    }

    let avatar = "";
    if (!phpEmpty(videoInfo.avatar)) {
      avatar = proxyBase + base64Encode("https:" + videoInfo.avatar);
    }

    let cover = "";
    if (!phpEmpty(videoInfo.cover_image)) {
      cover = proxyBase + base64Encode("https:" + videoInfo.cover_image);
    }

    return {
      code: 200,
      msg: "解析成功",
      data: {
        type: "video",
        title: videoInfo.title ?? "",
        desc: videoInfo.title ?? "",
        author: {
          name: videoInfo.author ?? "",
          id: String(videoInfo.author_id ?? ""),
          avatar: avatar,
        },
        cover: cover,
        url: mainUrl,
        quality: mainQuality,
        duration: duration,
        video_backup: backupUrls,
        extra: {
          play_count: videoInfo.play_count ?? "",
          reposts_count: videoInfo.reposts_count ?? "",
          comments_count: videoInfo.comments_count ?? "",
          attitudes_count: videoInfo.attitudes_count ?? "",
          ip_info: videoInfo.ip_info_str ?? "",
          date: videoInfo.date ?? "",
        },
      },
    };
  } else {
    let errorMsg = "解析失败,当前链接中的视频不存在。";
    if (!hasCode) {
      errorMsg = "当前官方接口已失效！";
    } else if (responseData.code != 100000) {
      errorMsg = "官方接口响应错误！";
    }
    return { code: 404, msg: errorMsg };
  }
}

// 对应 PHP main()
export async function parse(shareUrl, env) {
  const url = shareUrl === undefined || shareUrl === null ? "" : String(shareUrl);

  if (phpEmpty(url)) {
    return { code: 400, msg: "参数url不能为空" };
  }

  const videoId = await extractVideoId(url);
  if (phpEmpty(videoId)) {
    return { code: 404, msg: `无法从URL中提取视频ID: ${url}` };
  }

  const headers = getRequestHeaders();
  const result = await fetchVideoInfo(videoId, headers);
  return result;
}

export function jsonResponse(data) {
  return new Response(JSON.stringify(data), { status: 200, headers: CORS_HEADERS });
}

export async function onRequest(context) {
  const request = context.request;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  // PHP: POST 时取 $_POST，否则取 $_GET
  let input = "";
  const u = new URL(request.url);
  if (request.method === "POST") {
    try {
      const form = await request.formData();
      input = form.get("url") || "";
    } catch (e) {
      input = "";
    }
  } else {
    input = u.searchParams.get("url") || "";
  }
  input = String(input).trim();
  if (!input) {
    return jsonResponse({ code: 400, msg: "参数url不能为空" });
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
