/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/11/14
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @tip: B站登录·短信验证码登录（EdgeOne Makers 边缘函数版）
 * @Remark: 新增功能（非原项目接口）。POST /api/bilibili/login/sms/confirm
 *          body(JSON): {cid, tel, code, grecaptcha_token}
 *          调用 B 站 /x/passport-login/web/login/sms 完成登录，
 *          成功从 Set-Cookie 提取 SESSDATA/bili_jct/DedeUserID，仅返回给请求方浏览器。
 */

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type,x-bili-cookie,x-weibo-cookie,x-wyy-cookie",
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

// 从响应头提取全部 Set-Cookie（兼容 getSetCookie 与原始头两种运行时实现）
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

// 从 Set-Cookie 列表中提取指定 cookie 的值
function pickCookie(list, name) {
  const re = new RegExp("(?:^|[;,\\s])" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;,\\s]+)");
  for (const c of list) {
    const m = String(c).match(re);
    if (m) return m[1];
  }
  return null;
}

export async function onRequest(context) {
  const request = context.request;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return jsonResponse({ code: 405, msg: "仅支持 POST", data: [] }, 405);
  }

  let body = null;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ code: 400, msg: "请求体不是有效 JSON", data: [] }, 400);
  }
  const cid = String((body && body.cid) || "86").trim();
  const tel = String((body && body.tel) || "").trim();
  const code = String((body && body.code) || "").trim();
  const grecaptchaToken = String((body && body.grecaptcha_token) || "");
  if (!tel || !code) {
    return jsonResponse({ code: 400, msg: "请输入手机号和短信验证码", data: [] }, 400);
  }
  if (!grecaptchaToken) {
    return jsonResponse({ code: 400, msg: "缺少 grecaptcha_token，请先发送短信验证码", data: [] }, 400);
  }

  try {
    const form = new URLSearchParams({
      cid: cid,
      tel: tel,
      code: code,
      source: "main_web",
      grecaptcha_token: grecaptchaToken,
      keep: "0",
    });
    const res = await fetch("https://passport.bilibili.com/x/passport-login/web/login/sms?source=main_web", {
      method: "POST",
      headers: {
        "User-Agent": DESKTOP_UA,
        "Referer": "https://passport.bilibili.com/",
        "Origin": "https://passport.bilibili.com",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      redirect: "manual",
      signal: timeoutSignal(30000),
    });
    const setCookies = extractSetCookies(res.headers);
    const json = await res.json().catch(function () { return null; });

    if (!json) {
      return jsonResponse({ code: 500, msg: "登录响应不是有效 JSON", data: [] });
    }
    if (json.code !== 0) {
      return jsonResponse({ code: json.code, msg: "登录失败: " + (json.message || "未知错误"), data: [] });
    }

    const names = ["SESSDATA", "bili_jct", "DedeUserID", "buvid3", "sid", "ac_time_value"];
    const cookieMap = {};
    for (const name of names) {
      const v = pickCookie(setCookies, name);
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
        refresh_token: json.data && json.data.refresh_token ? json.data.refresh_token : "",
      },
    });
  } catch (e) {
    return jsonResponse({ code: 500, msg: "登录异常: " + (e && e.message ? e.message : "未知错误"), data: [] });
  }
}
