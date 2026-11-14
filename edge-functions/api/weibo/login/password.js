/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/11/14
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @tip: 微博登录·账号密码登录（EdgeOne Makers 边缘函数版）
 * @Remark: 新增功能（非原项目接口）。POST /api/weibo/login/password
 *          body(JSON): {username, password}
 *          流程（经典 sina SSO，实测可用）：
 *          1) login.sina.com.cn/sso/prelogin.php 取 servertime/nonce/pubkey(hex)/rsakv
 *          2) 纯 JS RSA PKCS1v1.5 加密 "servertime\tnonce\n密码"（pubkey hex 模数，e=65537）→ hex sp
 *          3) POST login.sina.com.cn/sso/login.php 提交表单
 *          4) retcode=0 时遍历 crossDomainUrlList（302 链）收集 SUB/SUBP 等完整 Cookie
 *          登录成功 Cookie 仅返回给请求方浏览器，服务端不存储。
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

// 合并 Set-Cookie 列表为 "name=value; name2=value2" 串（后者覆盖前者）
function mergeCookies(list) {
  const map = new Map();
  for (const item of list) {
    const m = String(item).match(/^\s*([^=;\s]+)\s*=\s*([^;]*)/);
    if (m && m[1] && m[2].trim() !== "") {
      map.set(m[1].trim(), m[2].trim());
    }
  }
  const parts = [];
  map.forEach((v, k) => parts.push(k + "=" + v));
  return parts.join("; ");
}

// ==================== 纯 JS RSA PKCS1 v1.5（hex 模数，BigInt 实现） ====================

// BigInt 模幂运算
function modPow(base, exp, mod) {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) {
      result = (result * base) % mod;
    }
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

// RSA PKCS1 v1.5 加密（EM = 0x00 || 0x02 || PS || 0x00 || T），hex 模数版本，输出 hex
function rsaPkcs1EncryptHex(pubkeyHex, messageBytes) {
  const n = BigInt("0x" + pubkeyHex);
  const e = 65537n;
  const k = (n.toString(2).length + 7) >> 3; // 模数字节数（1024-bit → 128）
  if (messageBytes.length > k - 11) {
    throw new Error("消息过长，无法进行 PKCS1 v1.5 加密");
  }
  // 填充 PS：非零随机字节
  const psLen = k - messageBytes.length - 3;
  const em = new Uint8Array(k);
  em[0] = 0x00;
  em[1] = 0x02;
  for (let i = 0; i < psLen; i++) {
    let r = 0;
    while (r === 0) {
      r = Math.floor(Math.random() * 256);
    }
    em[2 + i] = r;
  }
  em[2 + psLen] = 0x00;
  em.set(messageBytes, 3 + psLen);

  // 字节 → BigInt（大端）→ m^e mod n → hex（左侧补零至 k*2 位）
  let m = 0n;
  for (let i = 0; i < k; i++) {
    m = (m << 8n) | BigInt(em[i]);
  }
  const c = modPow(m, e, n);
  let hex = c.toString(16);
  while (hex.length < k * 2) {
    hex = "0" + hex;
  }
  return hex;
}

// su：用户名 urlencode 后 base64（与 ssologin.js 一致）
function encodeSu(username) {
  const quoted = encodeURIComponent(String(username));
  return btoa(unescape(encodeURIComponent(quoted)));
}

// 手动跟随一次重定向链（collect cookies，最多 5 跳）
async function followCollectCookies(url, cookieStore) {
  let current = url;
  for (let hop = 0; hop < 5 && current; hop++) {
    const resp = await fetch(current, {
      method: "GET",
      headers: { "user-agent": DESKTOP_UA, referer: "https://weibo.com/" },
      redirect: "manual",
      signal: timeoutSignal(30000),
    });
    for (const c of extractSetCookies(resp.headers)) {
      const m = String(c).match(/^\s*([^=;\s]+)\s*=\s*([^;]*)/);
      if (m && m[1] && m[2].trim() !== "") {
        cookieStore.set(m[1].trim(), m[2].trim());
      }
    }
    const location = resp.headers.get("location");
    if ((resp.status === 301 || resp.status === 302 || resp.status === 303 || resp.status === 307) && location) {
      current = new URL(location, current).toString();
    } else {
      // 非 302 时读取最终响应体（wbsso/login 的 JSONP userinfo）
      let text = "";
      try {
        text = await resp.text();
      } catch (e) {
        text = "";
      }
      return text.slice(0, 500);
    }
  }
  return "";
}

export async function onRequest(context) {
  const request = context.request;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  let body = {};
  try {
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("application/json")) {
      body = await request.json();
    } else if (ct.includes("form")) {
      const form = await request.formData();
      body = Object.fromEntries(form.entries());
    }
  } catch (e) {
    body = {};
  }

  const username = body.username == null ? "" : String(body.username).trim();
  const password = body.password == null ? "" : String(body.password);
  if (!username || !password) {
    return jsonResponse({ code: 400, msg: "账号和密码不能为空" });
  }

  try {
    // 1) prelogin：取 servertime/nonce/pubkey/rsakv
    const su = encodeSu(username);
    const preResp = await fetch(
      "https://login.sina.com.cn/sso/prelogin.php?entry=weibo&su=" +
        encodeURIComponent(su) +
        "&rsakt=mod&checkpin=1&client=ssologin.js(v1.4.18)&_=" +
        Date.now(),
      { headers: { "user-agent": DESKTOP_UA, referer: "https://weibo.com/" }, signal: timeoutSignal(30000) }
    );
    const pre = await preResp.json();
    if (!pre || Number(pre.retcode) !== 0 || !pre.pubkey) {
      return jsonResponse({ code: 502, msg: "预登录失败，请稍后重试", data: pre });
    }

    // 2) RSA 加密密码："servertime\tnonce\npassword"
    const message = String(pre.servertime) + "\t" + String(pre.nonce) + "\n" + password;
    const sp = rsaPkcs1EncryptHex(pre.pubkey, new TextEncoder().encode(message));

    // 3) 提交登录表单
    const form = new URLSearchParams({
      entry: "weibo",
      gateway: "1",
      from: "",
      savestate: "7",
      useticket: "1",
      vsnf: "1",
      su: su,
      service: "miniblog",
      servertime: String(pre.servertime),
      nonce: String(pre.nonce),
      pwencode: "rsa2",
      rsakv: String(pre.rsakv),
      sp: sp,
      sr: "1920*1080",
      encoding: "UTF-8",
      cdult: "2",
      domain: "weibo.com",
      prelt: String(38 + Math.floor(Math.random() * 100)),
      returntype: "TEXT",
    });
    const loginResp = await fetch("https://login.sina.com.cn/sso/login.php?client=ssologin.js(v1.4.18)", {
      method: "POST",
      headers: {
        "user-agent": DESKTOP_UA,
        referer: "https://weibo.com/",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      redirect: "manual",
      signal: timeoutSignal(30000),
    });
    let loginJson = null;
    try {
      loginJson = await loginResp.json();
    } catch (e) {
      loginJson = null;
    }
    if (!loginJson) {
      return jsonResponse({ code: 502, msg: "登录服务返回异常，请稍后重试" });
    }

    const retcode = Number(loginJson.retcode);
    if (retcode !== 0) {
      return jsonResponse({
        code: retcode === 101 ? 400 : retcode,
        msg: (loginJson && loginJson.reason) || "登录失败（账号或密码错误）",
        data: { retcode: loginJson.retcode },
      });
    }

    // 4) 遍历 crossDomainUrlList 收集 Cookie
    const cookieStore = new Map();
    // login.php 自身 Set-Cookie 也并入
    for (const c of extractSetCookies(loginResp.headers)) {
      const m = String(c).match(/^\s*([^=;\s]+)\s*=\s*([^;]*)/);
      if (m && m[1] && m[2].trim() !== "") {
        cookieStore.set(m[1].trim(), m[2].trim());
      }
    }
    const crossList = Array.isArray(loginJson.crossDomainUrlList) ? loginJson.crossDomainUrlList : [];
    let lastBody = "";
    for (const u of crossList) {
      try {
        lastBody = await followCollectCookies(u, cookieStore);
      } catch (e) {
        /* 单个域失败不阻断 */
      }
    }

    const cookie = mergeCookies([...cookieStore.entries()].map(([k, v]) => k + "=" + v + "; Path=/"));
    if (!cookie || (!/SUB=/.test(cookie) && !/SUP=/.test(cookie))) {
      return jsonResponse({ code: 500, msg: "未能获取登录 Cookie，请重试", data: { last: lastBody } });
    }

    return jsonResponse({
      code: 0,
      msg: "登录成功",
      data: {
        cookie: cookie,
        uid: String(loginJson.uid || ""),
        nickname: String(loginJson.nick || ""),
      },
    });
  } catch (e) {
    return jsonResponse({ code: 500, msg: "登录请求失败: " + (e && e.message ? e.message : "未知错误") });
  }
}
