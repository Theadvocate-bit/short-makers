/**
 *@Author: JH-Ahua
 *@CreateTime: 2025/6/13 下午3:31
 *@email: admin@bugpk.com
 *@blog: www.jiuhunwl.cn
 *@Api: api.bugpk.com
 *@tip: 微博短视频解析爬虫版
 *@Remark: 已由 PHP 版移植为 EdgeOne Makers 边缘函数版
 */

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

// JSON.parse 失败时返回 null，等价 PHP json_decode(..., true)
function jsonDecode(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// 对应 PHP weibo_curl()：POST 微博组件接口（page 参数不做 urlencode，与 PHP 一致）
async function weiboCurl(id) {
  const cookie =
    "login_sid_t=6b652c77c1a4bc50cb9d06b24923210d; cross_origin_proto=SSL; WBStorage=2ceabba76d81138d|undefined; _s_tentry=passport.weibo.com; Apache=7330066378690.048.1625663522444; SINAGLOBAL=7330066378690.048.1625663522444; ULV=1625663522450:1:1:1:7330066378690.048.1625663522444:; TC-V-WEIBO-G0=35846f552801987f8c1e8f7cec0e2230; SUB=_2AkMXuScYf8NxqwJRmf8RzmnhaoxwzwDEieKh5dbDJRMxHRl-yT9jqhALtRB6PDkJ9w8OaqJAbsgjdEWtIcilcZxHG7rw; SUBP=0033WrSXqPxfM72-Ws9jqgMF55529P9D9W5Qx3Mf.RCfFAKC3smW0px0; XSRF-TOKEN=JQSK02Ijtm4Fri-YIRu0-vNj";
  const postData = `data={"Component_Play_Playinfo":{"oid":"${id}"}}`;
  try {
    const resp = await fetch("https://weibo.com/tv/api/component?page=/tv/show/" + id, {
      method: "POST",
      headers: {
        cookie: cookie,
        referer: "https://weibo.com/tv/show/" + id,
        // curl 的 CURLOPT_POSTFIELDS 字符串默认以 application/x-www-form-urlencoded 发送
        "content-type": "application/x-www-form-urlencoded",
      },
      body: postData,
      redirect: "follow",
      // PHP CURLOPT_TIMEOUT = 5 秒
      signal: timeoutSignal(5000),
    });
    return await resp.text();
  } catch (e) {
    // curl_exec 失败返回 false，json_decode 后为 null
    return "";
  }
}

// 对应 PHP weibo()
async function weibo(url) {
  const proxyurl = "https://api.bugpk.com/api/weibo?proxyurl=";
  let arr = null;
  // PHP: strpos($url, 'show?fid=') != false —— 命中且位置大于 0
  if (url.indexOf("show?fid=") > 0) {
    const m = /fid=(.*)/.exec(url);
    const id = m ? m[1] : "";
    arr = jsonDecode(await weiboCurl(id));
  } else {
    const m = /\d+\:\d+/.exec(url);
    const id = m ? m[0] : "";
    arr = jsonDecode(await weiboCurl(id));
  }
  if (arr !== null && typeof arr === "object") {
    const playInfo =
      arr.data && typeof arr.data === "object" ? arr.data.Component_Play_Playinfo : undefined;
    const urls =
      playInfo && typeof playInfo === "object" ? playInfo.urls : undefined;
    // PHP: key($arr['data']['Component_Play_Playinfo']['urls']) 取第一个键
    if (!urls || typeof urls !== "object") {
      return null;
    }
    const keys = Object.keys(urls);
    if (keys.length === 0) {
      return null;
    }
    const one = keys[0];
    const videoUrl = urls[one];
    return {
      code: 200,
      msg: "解析成功",
      data: {
        author: playInfo.author ?? null,
        avatar: proxyurl + base64Encode("https:" + (playInfo.avatar ?? "")),
        time: playInfo.real_date ?? null,
        title: playInfo.title ?? null,
        cover: proxyurl + base64Encode("https:" + (playInfo.cover_image ?? "")),
        url: proxyurl + base64Encode("https:" + (videoUrl ?? "")),
      },
    };
  }
  return null;
}

export async function parse(shareUrl, env) {
  const url = shareUrl === undefined || shareUrl === null ? "" : String(shareUrl);
  if (phpEmpty(url)) {
    return { code: 201, msg: "链接不能为空！" };
  }
  const info = await weibo(url);
  // 检查 $info 是否为数组
  if (info !== null && typeof info === "object" && info.code == 200) {
    return info;
  }
  return { code: 404, msg: "解析失败！" };
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
    return jsonResponse({ code: 201, msg: "链接不能为空！" });
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
