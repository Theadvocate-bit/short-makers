/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/11/14
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @tip: B站扫码登录·状态轮询（EdgeOne Makers 边缘函数版）
 * @Remark: 新增功能（非原项目接口）。轮询 B 站官方 passport 接口登录状态：
 *          GET /api/bilibili/login/poll?qrcode_key=xxx
 *          返回 {code, msg, data:{status, cookie, cookie_map}}
 *          status: waiting=未扫码 / scanned=已扫码待确认 / confirmed=登录成功 / expired=二维码过期
 *          登录成功时从 Set-Cookie 提取 SESSDATA/bili_jct/DedeUserID 等，仅返回给
 *          发起本次轮询的浏览器（由前端自行保存在 localStorage，服务端不存储）。
 */

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type,x-bili-cookie",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status: status, headers: CORS_HEADERS });
}

// ---------- 兼容性辅助：边缘函数运行时不支持 AbortSignal.timeout() ----------
function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), Number(ms) || 0);
  return controller.signal;
}

/**
 * 从响应头提取全部 Set-Cookie（兼容 getSetCookie 与原始头两种运行时实现）
 */
function extractSetCookies(headers) {
  let raw = [];
  try {
    if (typeof headers.getSetCookie === "function") {
      raw = headers.getSetCookie() || [];
    } else {
      const one = headers.get("set-cookie");
      if (one) raw = [one];
    }
  } catch (e) {
    raw = [];
  }
  return raw;
}

/** 从 Set-Cookie 列表中提取指定 cookie 的值 */
function pickCookie(list, name) {
  const re = new RegExp("(?:^|[;,\\s])" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;,\\s]+)");
  for (const c of list) {
    const m = String(c).match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * 轮询登录状态：
 * 正常为 200 JSON；若运行时表现为人 302 跳转（crossDomain），手动跟随一次并合并两跳 Set-Cookie
 */
async function pollBilibili(qrcodeKey) {
  const pollUrl = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=" + encodeURIComponent(qrcodeKey);
  const headers = { "User-Agent": DESKTOP_UA, "Referer": "https://passport.bilibili.com/" };

  let setCookies = [];
  let json = null;
  let res = await fetch(pollUrl, { redirect: "manual", headers: headers, signal: timeoutSignal(15000) });
  setCookies = setCookies.concat(extractSetCookies(res.headers));

  // 3xx 跳转兜底：跟随 Location 再取一次 Set-Cookie 与 JSON
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (loc) {
      try {
        res = await fetch(new URL(loc, pollUrl).href, { redirect: "manual", headers: headers, signal: timeoutSignal(15000) });
        setCookies = setCookies.concat(extractSetCookies(res.headers));
      } catch (e) {
        // 跟随失败不影响主流程
      }
    }
  }

  try {
    json = await res.json();
  } catch (e) {
    json = null;
  }
  return { json: json, setCookies: setCookies };
}

export async function onRequest(context) {
  const request = context.request;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const u = new URL(request.url);
  const qrcodeKey = (u.searchParams.get("qrcode_key") || "").trim();
  if (!qrcodeKey) {
    return jsonResponse({ code: 400, msg: "缺少 qrcode_key 参数", data: [] });
  }

  try {
    const result = await pollBilibili(qrcodeKey);
    const json = result.json;
    if (!json || json.code === undefined) {
      return jsonResponse({ code: 500, msg: "请求B站接口失败：响应不是有效JSON", data: [] });
    }
    if (json.code !== 0) {
      return jsonResponse({ code: json.code, msg: "轮询失败: " + (json.message || "未知错误"), data: [] });
    }

    // B 站登录状态码：86101 未扫码 / 86090 已扫码未确认 / 86038 过期 / 0 登录成功
    const statusCode = json.data && json.data.code !== undefined ? json.data.code : -1;
    if (statusCode === 86101) {
      return jsonResponse({ code: 0, msg: "等待扫码", data: { status: "waiting" } });
    }
    if (statusCode === 86090) {
      return jsonResponse({ code: 0, msg: "已扫码，请在手机上确认", data: { status: "scanned" } });
    }
    if (statusCode === 86038) {
      return jsonResponse({ code: 0, msg: "二维码已过期，请重新生成", data: { status: "expired" } });
    }
    if (statusCode !== 0) {
      return jsonResponse({ code: statusCode, msg: "未知的登录状态: " + (json.data && json.data.message ? json.data.message : statusCode), data: [] });
    }

    // 登录成功：提取 Cookie
    const names = ["SESSDATA", "bili_jct", "DedeUserID", "buvid3", "sid", "ac_time_value"];
    const cookieMap = {};
    for (const name of names) {
      const v = pickCookie(result.setCookies, name);
      if (v) cookieMap[name] = v;
    }
    if (!cookieMap.SESSDATA) {
      return jsonResponse({ code: 500, msg: "登录成功但未从响应中提取到 SESSDATA", data: [] });
    }
    const cookieString = Object.keys(cookieMap).map(function (k) { return k + "=" + cookieMap[k]; }).join("; ");

    return jsonResponse({
      code: 0,
      msg: "登录成功",
      data: {
        status: "confirmed",
        cookie: cookieString,
        cookie_map: cookieMap,
        uid: cookieMap.DedeUserID || null,
        // B 站返回的 crossDomain 跳转地址（前端可忽略）
        cross_domain_url: (json.data && json.data.url) || "",
      },
    });
  } catch (e) {
    return jsonResponse({ code: 500, msg: "轮询异常: " + (e && e.message ? e.message : "未知错误"), data: [] });
  }
}
