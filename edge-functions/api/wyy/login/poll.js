/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/11/14
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @tip: 网易云音乐扫码登录·状态轮询（EdgeOne Makers 边缘函数版）
 * @Remark: 新增功能（非原项目接口）。GET /api/wyy/login/poll?key=xxx
 *          通过 eapi 调用官方 /eapi/login/qrcode/client/login 轮询登录状态：
 *          801=等待扫码 / 802=已扫码待确认 / 803=登录成功 / 800=已过期。
 *          803 时从 Set-Cookie 提取 MUSIC_U/__csrf，仅返回给发起轮询的浏览器，
 *          服务端不存储。返回的 cookie 供 wyy 解析接口通过 x-wyy-cookie 头使用。
 */

import { HashHexDigest, aes128EcbEncryptHex } from "../../wyy.js";

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/2.10.2.200154";

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

// eapi 请求（匿名 Cookie）：返回 {json, setCookies}
async function eapiRequest(path, payload) {
  const url = "https://interface3.music.163.com" + path;
  const AES_KEY = "e82ckenh8dichen8"; // 16 字节
  const config = {
    os: "pc",
    appver: "",
    osver: "",
    deviceId: "pyncm!",
    requestId: String(20000000 + Math.floor(Math.random() * 10000000)),
  };
  const full = Object.assign({}, payload);
  full.header = JSON.stringify(config);

  const url2 = path.replace("/eapi/", "/api/");
  const digest = HashHexDigest("nobody" + url2 + "use" + JSON.stringify(full) + "md5forencrypt");
  const plain = url2 + "-36cd479b6b5-" + JSON.stringify(full) + "-36cd479b6b5-" + digest;
  const params = aes128EcbEncryptHex(AES_KEY, plain);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "user-agent": DESKTOP_UA,
      "referer": "https://music.163.com/",
      "content-type": "application/x-www-form-urlencoded",
      "cookie": "os=pc; appver=; osver=; deviceId=pyncm!",
    },
    body: "params=" + encodeURIComponent(params),
    redirect: "follow",
    signal: timeoutSignal(15000),
  });
  const setCookies = extractSetCookies(resp.headers);
  const json = await resp.json().catch(function () { return null; });
  return { json: json, setCookies: setCookies };
}

export async function onRequest(context) {
  const request = context.request;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  const u = new URL(request.url);
  const key = (u.searchParams.get("key") || "").trim();
  if (!key) {
    return jsonResponse({ code: 400, msg: "缺少 key 参数", data: [] });
  }

  try {
    const result = await eapiRequest("/eapi/login/qrcode/client/login", { key: key, type: 1 });
    const json = result.json;
    if (!json || json.code === undefined) {
      return jsonResponse({ code: 500, msg: "请求网易云接口失败：响应不是有效 JSON", data: [] });
    }

    // 800=已过期 / 801=等待扫码 / 802=已扫码待确认 / 803=登录成功
    const code = Number(json.code);
    if (code === 800) {
      return jsonResponse({ code: 0, msg: "二维码已过期，请重新生成", data: { status: "expired" } });
    }
    if (code === 801) {
      return jsonResponse({ code: 0, msg: "等待扫码", data: { status: "waiting" } });
    }
    if (code === 802) {
      return jsonResponse({
        code: 0,
        msg: "已扫码，请在手机上确认",
        data: { status: "scanned", nickname: json.nickname || "" },
      });
    }
    if (code !== 803) {
      return jsonResponse({ code: code, msg: "未知的登录状态: " + (json.message || code), data: [] });
    }

    // 登录成功：提取 Cookie（MUSIC_U 为登录凭证本体，__csrf 为令牌）
    const names = ["MUSIC_U", "__csrf", "NMTID", "ntes_kaola_ad"];
    const cookieMap = {};
    for (const name of names) {
      const v = pickCookie(result.setCookies, name);
      if (v) cookieMap[name] = v;
    }
    if (!cookieMap.MUSIC_U) {
      return jsonResponse({ code: 500, msg: "登录成功但未从响应中提取到 MUSIC_U", data: [] });
    }
    const cookieString = Object.keys(cookieMap).map(function (k) { return k + "=" + cookieMap[k]; }).join("; ");
    return jsonResponse({
      code: 0,
      msg: "登录成功",
      data: {
        status: "confirmed",
        cookie: cookieString,
        cookie_map: cookieMap,
        nickname: json.nickname || (json.account && json.account.uname) || "",
      },
    });
  } catch (e) {
    return jsonResponse({ code: 500, msg: "轮询异常: " + (e && e.message ? e.message : "未知错误"), data: [] });
  }
}
