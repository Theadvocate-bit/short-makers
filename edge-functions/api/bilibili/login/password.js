/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/11/14
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @tip: B站登录·账号密码登录（EdgeOne Makers 边缘函数版）
 * @Remark: 新增功能（非原项目接口）。POST /api/bilibili/login/password
 *          body(JSON): {username, password, token, challenge, validate, seccode}
 *          流程：/x/passport-login/web/key 取 RSA 公钥 → 纯 JS RSA PKCS1v1.5 加密
 *          md5(password) → POST /x/passport-login/web/login。
 *          geetest 滑块挑战由用户在前端手动完成（先调 /api/bilibili/login/captcha
 *          获取 token/gt/challenge，前端 gt.js 弹出滑块，拿到 validate/seccode 后传入）。
 *          登录成功从 Set-Cookie 提取 SESSDATA/bili_jct/DedeUserID，仅返回给请求方浏览器。
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

// ==================== 纯 JS MD5 ====================

function md5Bytes(bytes) {
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  }
  const len = bytes.length;
  const totalLen = (((len + 8) >> 6) + 1) * 64;
  const buf = new Uint8Array(totalLen);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  const bitLen = len * 8;
  dv.setUint32(totalLen - 8, bitLen >>> 0, true);
  dv.setUint32(totalLen - 4, Math.floor(bitLen / 4294967296), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Array(16);
  for (let off = 0; off < totalLen; off += 64) {
    for (let j = 0; j < 16; j++) {
      M[j] = dv.getUint32(off + j * 4, true);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);
  return out;
}

function md5Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const out = md5Bytes(bytes);
  let s = "";
  for (let i = 0; i < out.length; i++) {
    s += out[i].toString(16).padStart(2, "0");
  }
  return s;
}

// ==================== 纯 JS RSA PKCS1 v1.5 加密（BigInt 实现） ====================

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

// 最小 DER 解析：从 SubjectPublicKeyInfo PEM 中提取 RSA 模数 n 与指数 e
function parseRsaPublicKey(pem) {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  let pos = 0;

  function readTlv() {
    const tag = der[pos++];
    let lenByte = der[pos++];
    let len;
    if (lenByte & 0x80) {
      const numBytes = lenByte & 0x7f;
      len = 0;
      for (let i = 0; i < numBytes; i++) {
        len = len * 256 + der[pos++];
      }
    } else {
      len = lenByte;
    }
    return { tag: tag, start: pos, len: len, end: pos + len };
  }

  function readInteger(tlv) {
    // INTEGER：跳过前导 0x00
    let i = tlv.start;
    while (i < tlv.end && der[i] === 0x00) i++;
    let n = 0n;
    for (; i < tlv.end; i++) {
      n = (n << 8n) | BigInt(der[i]);
    }
    return n;
  }

  // SubjectPublicKeyInfo = SEQUENCE { SEQUENCE { OID, NULL }, BITSTRING { SEQUENCE { INTEGER n, INTEGER e } } }
  const outer = readTlv();
  pos = outer.start;
  const algoSeq = readTlv(); // SEQUENCE { OID, NULL }
  pos = algoSeq.end;
  const bitString = readTlv(); // BIT STRING，首字节为未用位数 0
  pos = bitString.start + 1; // 跳过 unused bits 字节
  const innerSeq = readTlv(); // RSA SEQUENCE
  pos = innerSeq.start;
  const intN = readTlv();
  const n = readInteger(intN);
  pos = intN.end;
  const intE = readTlv();
  const e = readInteger(intE);
  return { n: n, e: e };
}

// RSA PKCS1 v1.5 加密（EM = 0x00 || 0x02 || PS || 0x00 || T），输出 base64
function rsaPkcs1EncryptBase64(pubkeyPem, messageBytes) {
  const { n, e } = parseRsaPublicKey(pubkeyPem);
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

  // 字节 → BigInt（大端）
  let m = 0n;
  for (let i = 0; i < k; i++) {
    m = (m << 8n) | BigInt(em[i]);
  }
  const c = modPow(m, e, n);
  // BigInt → 定长 k 字节大端
  const out = new Uint8Array(k);
  let v = c;
  for (let i = k - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  // 字节 → base64
  let bin = "";
  for (let i = 0; i < out.length; i++) {
    bin += String.fromCharCode(out[i]);
  }
  return btoa(bin);
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
  const username = String((body && body.username) || "").trim();
  const password = String((body && body.password) || "");
  const token = String((body && body.token) || "");
  const challenge = String((body && body.challenge) || "");
  const validate = String((body && body.validate) || "");
  const seccode = String((body && body.seccode) || "");
  if (!username || !password) {
    return jsonResponse({ code: 400, msg: "请输入用户名和密码", data: [] }, 400);
  }

  try {
    // 1) 获取 RSA 公钥与 hash
    const keyRes = await fetch("https://passport.bilibili.com/x/passport-login/web/key", {
      headers: { "User-Agent": DESKTOP_UA, "Referer": "https://passport.bilibili.com/" },
      signal: timeoutSignal(15000),
    });
    const keyJson = await keyRes.json();
    if (keyJson.code !== 0 || !keyJson.data || !keyJson.data.key) {
      return jsonResponse({ code: keyJson.code || 500, msg: "获取公钥失败: " + (keyJson.message || "未知错误"), data: [] });
    }

    // 2) RSA 加密 md5(password)
    const encrypted = rsaPkcs1EncryptBase64(keyJson.data.key, new TextEncoder().encode(md5Hex(password)));

    // 3) 提交登录
    const form = new URLSearchParams({
      username: username,
      password: encrypted,
      keep: "0",
      token: token,
      challenge: challenge,
      validate: validate,
      seccode: seccode,
      source: "web-main",
      go_url: "/",
    });
    const loginRes = await fetch("https://passport.bilibili.com/x/passport-login/web/login", {
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
    const setCookies = extractSetCookies(loginRes.headers);
    const loginJson = await loginRes.json().catch(function () { return null; });

    if (!loginJson) {
      return jsonResponse({ code: 500, msg: "登录响应不是有效 JSON", data: [] });
    }
    if (loginJson.code !== 0) {
      // 透传 B 站错误（-105 需要验证码 / -100 账号或密码错误等）
      return jsonResponse({
        code: loginJson.code,
        msg: "登录失败: " + (loginJson.message || "未知错误"),
        data: {
          // 顺带返回新的验证码参数，前端可直接弹出滑块重试
          need_captcha: loginJson.code === -105,
          url: loginJson.data && loginJson.data.url ? loginJson.data.url : "",
        },
      });
    }

    // 4) 登录成功：提取 Cookie
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
        refresh_token: loginJson.data && loginJson.data.refresh_token ? loginJson.data.refresh_token : "",
      },
    });
  } catch (e) {
    return jsonResponse({ code: 500, msg: "登录异常: " + (e && e.message ? e.message : "未知错误"), data: [] });
  }
}
