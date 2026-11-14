/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/11/14
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @tip: 网易云登录·weapi 加密共享模块（EdgeOne Makers 边缘函数版）
 * @Remark: 对齐 NeteaseCloudMusicApi util/crypto.js 的 weapi 算法：
 *          1) text = JSON.stringify(params)
 *          2) 第一次 AES-128-CBC（presetKey='0CoJUm6Qyw8W8jud'，iv='0102030405060708'）→ base64
 *          3) 第二次 AES-128-CBC（随机 16 位 base62 secretKey）→ base64 → params
 *          4) encSecKey = 裸 RSA（NO_PADDING，secretKey 反转后左侧补零至 128 字节）→ hex
 *          AES-CBC 使用 Web Crypto（PKCS7 填充语义与 node createCipheriv 一致）。
 */

const PRESET_KEY = "0CoJUm6Qyw8W8jud";
const IV = "0102030405060708";
const BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const NETEASE_PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB\n-----END PUBLIC KEY-----";

function utf8Bytes(text) {
  return new TextEncoder().encode(String(text));
}

function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return btoa(s);
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
    if (m && m[1] && m[2] !== "") {
      map.set(m[1], m[2].trim());
    }
  }
  const parts = [];
  map.forEach((v, k) => parts.push(k + "=" + v));
  return parts.join("; ");
}

// AES-128-CBC 加密（Web Crypto，PKCS7 填充），输出 base64
async function aesCbcEncryptBase64(keyBytes, ivBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["encrypt"]);
  const buf = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBytes }, key, dataBytes);
  return new Uint8Array(buf);
}

// ---------- 纯 JS 裸 RSA（NO_PADDING，BigInt 实现） ----------

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
    let i = tlv.start;
    while (i < tlv.end && der[i] === 0x00) i++;
    let n = 0n;
    for (; i < tlv.end; i++) {
      n = (n << 8n) | BigInt(der[i]);
    }
    return n;
  }

  const outer = readTlv();
  pos = outer.start;
  const algoSeq = readTlv();
  pos = algoSeq.end;
  const bitString = readTlv();
  pos = bitString.start + 1;
  const innerSeq = readTlv();
  pos = innerSeq.start;
  const intN = readTlv();
  const n = readInteger(intN);
  pos = intN.end;
  const intE = readTlv();
  const e = readInteger(intE);
  return { n: n, e: e };
}

// 裸 RSA 加密（NO_PADDING：消息左侧补零至模数字节长度），输出 hex
function rsaNoPaddingEncryptHex(pubkeyPem, messageBytes) {
  const { n, e } = parseRsaPublicKey(pubkeyPem);
  const k = (n.toString(2).length + 7) >> 3;
  if (messageBytes.length > k) {
    throw new Error("消息过长，无法进行裸 RSA 加密");
  }
  // 左侧补零至 k 字节
  const padded = new Uint8Array(k);
  padded.set(messageBytes, k - messageBytes.length);
  let m = 0n;
  for (let i = 0; i < k; i++) {
    m = (m << 8n) | BigInt(padded[i]);
  }
  const c = modPow(m, e, n);
  let hex = c.toString(16);
  while (hex.length < k * 2) {
    hex = "0" + hex;
  }
  return hex;
}

function randomSecretKey() {
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += BASE62[Math.floor(Math.random() * 62)];
  }
  return s;
}

// weapi 加密：返回 { params, encSecKey }
export async function weapiEncrypt(object) {
  const text = JSON.stringify(object);
  const secretKey = randomSecretKey();
  const first = await aesCbcEncryptBase64(utf8Bytes(PRESET_KEY), utf8Bytes(IV), utf8Bytes(text));
  const params = await aesCbcEncryptBase64(utf8Bytes(secretKey), utf8Bytes(IV), utf8Bytes(bytesToBase64(first)));
  const reversed = secretKey.split("").reverse().join("");
  const encSecKey = rsaNoPaddingEncryptHex(NETEASE_PUBLIC_KEY, utf8Bytes(reversed));
  return { params: bytesToBase64(params), encSecKey: encSecKey };
}

// 生成 16 位随机 hex（用于 NMTID/_ntes_nuid 等匿名 Cookie，降低 -460 风控概率）
function randomHex(len) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  }
  return s;
}

// weapi POST：发送到指定 /weapi/ 端点并收集 Set-Cookie
// extraCookie 可为 null（自动使用浏览器级匿名 Cookie 罐）
// 网易 weapi 请求要求 payload 内含 csrf_token（可为空串），并建议带时间戳防缓存
export async function weapiPost(url, params, extraCookie) {
  const payload = Object.assign({}, params);
  if (payload.csrf_token === undefined) {
    payload.csrf_token = "";
  }
  if (payload.timestamp === undefined) {
    payload.timestamp = Date.now();
  }
  const enc = await weapiEncrypt(payload);
  const cookie =
    extraCookie ||
    "os=pc; appver=2.9.7; NMTID=00O" + randomHex(14) + "UIZmZITJzAB; WEVNSM=1.0.0; _ntes_nuid=" + randomHex(32);
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    referer: "https://music.163.com/",
    origin: "https://music.163.com",
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    cookie: cookie,
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: headers,
    body: "params=" + encodeURIComponent(enc.params) + "&encSecKey=" + encodeURIComponent(enc.encSecKey),
    redirect: "manual",
    signal: timeoutSignal(30000),
  });
  let body = null;
  try {
    body = await resp.json();
  } catch (e) {
    body = null;
  }
  return { body: body, cookies: mergeCookies(extractSetCookies(resp.headers)), status: resp.status };
}

export { extractSetCookies, mergeCookies, timeoutSignal };
