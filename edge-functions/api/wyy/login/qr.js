/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/11/14
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @tip: 网易云音乐扫码登录·二维码生成（EdgeOne Makers 边缘函数版）
 * @Remark: 新增功能（非原项目接口）。GET /api/wyy/login/qr
 *          通过 eapi（AES-128-ECB + MD5 签名，复用 wyy.js 导出的加密函数）
 *          调用官方 /eapi/login/qrcode/unikey 获取登录码，
 *          二维码内容为 https://music.163.com/login?codekey=<unikey>，
 *          前端用本地 qrcode.min.js 渲染，用 GET /api/wyy/login/poll?key=xxx 轮询。
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

// eapi 请求（匿名 Cookie）：payload JSON + 签名 → AES-128-ECB hex → 表单提交
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
  const json = await resp.json().catch(function () { return null; });
  return json;
}

export async function onRequest(context) {
  const request = context.request;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  try {
    const json = await eapiRequest("/eapi/login/qrcode/unikey", { type: 1 });
    if (!json || (json.code !== 200 && json.code !== "200") || !json.unikey) {
      return jsonResponse({
        code: json && json.code ? json.code : 500,
        msg: "生成二维码失败: " + (json && json.message ? json.message : json && json.msg ? json.msg : "未知错误"),
        data: [],
      });
    }
    return jsonResponse({
      code: 0,
      msg: "ok",
      data: {
        unikey: json.unikey,
        qr_url: "https://music.163.com/login?codekey=" + json.unikey,
      },
    });
  } catch (e) {
    return jsonResponse({ code: 500, msg: "请求网易云接口失败: " + (e && e.message ? e.message : "未知错误"), data: [] });
  }
}
