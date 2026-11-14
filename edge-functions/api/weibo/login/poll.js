/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/11/14
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @tip: 微博扫码登录·状态轮询（EdgeOne Makers 边缘函数版）
 * @Remark: 新增功能（非原项目接口）。轮询微博官方 passport 接口：
 *          GET /api/weibo/login/poll?qrid=xxx
 *          retcode 状态映射：50114001=未使用(等待扫码) / 50114002=已扫码待确认 /
 *          50114004=已过期 / 20000000=确认成功（data.url 或 data.alt 换取登录 Cookie）。
 *          登录 Cookie（SUB/SUBP 等）仅返回给发起轮询的浏览器，服务端不存储。
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

async function fetchWithCookies(url) {
  const res = await fetch(url, {
    redirect: "manual",
    headers: {
      "User-Agent": DESKTOP_UA,
      "Referer": "https://weibo.com/",
    },
    signal: timeoutSignal(15000),
  });
  return res;
}

export async function onRequest(context) {
  const request = context.request;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const u = new URL(request.url);
  const qrid = (u.searchParams.get("qrid") || "").trim();
  if (!qrid) {
    return jsonResponse({ code: 400, msg: "缺少 qrid 参数", data: [] });
  }

  try {
    // 1) 轮询扫码状态
    const checkUrl =
      "https://passport.weibo.com/sso/v2/qrcode/check?entry=miniblog&qrid=" +
      encodeURIComponent(qrid) +
      "&rid=&ver=20250520";
    const checkRes = await fetchWithCookies(checkUrl);
    const checkJson = await checkRes.json();
    const retcode = checkJson.retcode;

    if (retcode === 50114001) {
      return jsonResponse({ code: 0, msg: "等待扫码", data: { status: "waiting" } });
    }
    if (retcode === 50114002) {
      return jsonResponse({ code: 0, msg: "已扫码，请在手机上确认", data: { status: "scanned" } });
    }
    if (retcode === 50114004) {
      return jsonResponse({ code: 0, msg: "二维码已过期，请重新生成", data: { status: "expired" } });
    }
    if (retcode !== 20000000) {
      return jsonResponse({ code: retcode, msg: "未知的登录状态: " + (checkJson.msg || retcode), data: [] });
    }

    // 2) 确认成功：通过 data.url 或 alt 换取登录 Cookie
    const data = checkJson.data || {};
    let loginUrl;
    if (data.url) {
      loginUrl = data.url;
    } else if (data.alt) {
      loginUrl = "https://passport.weibo.com/sso/v2/login?entry=miniblog&alt=" + encodeURIComponent(data.alt) + "&returntype=META";
    } else {
      return jsonResponse({ code: 500, msg: "确认成功但未返回登录跳转地址", data: [] });
    }

    // 逐跳收集 Set-Cookie（最多跟随 10 跳）
    let setCookies = [];
    let current = loginUrl;
    let finalStatus = 0;
    for (let i = 0; i < 10; i++) {
      const res = await fetchWithCookies(current);
      finalStatus = res.status;
      setCookies = setCookies.concat(extractSetCookies(res.headers));
      const loc = res.headers.get("location");
      if (loc) {
        try {
          current = new URL(loc, current).href;
        } catch (e) {
          break;
        }
      } else {
        break;
      }
    }

    // 3) 提取关键 Cookie（SUB/SUBP 为登录凭证本体）
    const names = ["SUB", "SUBP", "SINAGLOBAL", "ALF", "ALC", "SCF", "SSOLoginState", "XSRF-TOKEN"];
    const cookieMap = {};
    for (const name of names) {
      const v = pickCookie(setCookies, name);
      if (v) cookieMap[name] = v;
    }
    if (!cookieMap.SUB) {
      return jsonResponse({ code: 500, msg: "登录成功但未从响应中提取到 SUB Cookie（HTTP " + finalStatus + "）", data: [] });
    }
    const cookieString = Object.keys(cookieMap).map(function (k) { return k + "=" + cookieMap[k]; }).join("; ");

    return jsonResponse({
      code: 0,
      msg: "登录成功",
      data: {
        status: "confirmed",
        cookie: cookieString,
        cookie_map: cookieMap,
      },
    });
  } catch (e) {
    return jsonResponse({ code: 500, msg: "轮询异常: " + (e && e.message ? e.message : "未知错误"), data: [] });
  }
}
