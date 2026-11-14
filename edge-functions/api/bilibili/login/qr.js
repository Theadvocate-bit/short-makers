/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/11/14
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @tip: B站扫码登录·二维码生成（EdgeOne Makers 边缘函数版）
 * @Remark: 新增功能（非原项目接口）。调用 B 站官方 passport 接口生成登录二维码：
 *          GET /api/bilibili/login/qr → {code:0, data:{qrcode_key, qr_url}}
 *          前端用本地 qrcode.min.js 将 qr_url 渲染为二维码，用户扫码后
 *          用 GET /api/bilibili/login/poll?qrcode_key=xxx 轮询登录状态。
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

export async function onRequest(context) {
  const request = context.request;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  try {
    const res = await fetch("https://passport.bilibili.com/x/passport-login/web/qrcode/generate", {
      headers: {
        "User-Agent": DESKTOP_UA,
        "Referer": "https://passport.bilibili.com/",
      },
      signal: timeoutSignal(15000),
    });
    const json = await res.json();
    if (json.code !== 0 || !json.data || !json.data.qrcode_key) {
      return jsonResponse({
        code: json.code !== undefined ? json.code : 500,
        msg: "生成二维码失败: " + (json.message || "未知错误"),
        data: [],
      });
    }
    return jsonResponse({
      code: 0,
      msg: "ok",
      data: {
        qrcode_key: json.data.qrcode_key,
        qr_url: json.data.url,
      },
    });
  } catch (e) {
    return jsonResponse({ code: 500, msg: "请求B站接口失败: " + (e && e.message ? e.message : "未知错误"), data: [] });
  }
}
