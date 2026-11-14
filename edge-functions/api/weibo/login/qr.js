/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/11/14
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @tip: 微博扫码登录·二维码生成（EdgeOne Makers 边缘函数版）
 * @Remark: 新增功能（非原项目接口）。调用微博官方 passport 接口：
 *          GET /api/weibo/login/qr → {code:0, data:{qrid, scan_url, qr_image_url}}
 *          实测无需先访问 /sso/signin 获取 CSRF，可直接请求 qrcode/image；
 *          前端用本地 qrcode.min.js 将 scan_url 渲染为二维码，
 *          用 GET /api/weibo/login/poll?qrid=xxx 轮询登录状态。
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

export async function onRequest(context) {
  const request = context.request;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  try {
    const res = await fetch("https://passport.weibo.com/sso/v2/qrcode/image?entry=miniblog&size=180", {
      headers: {
        "User-Agent": DESKTOP_UA,
        "Referer": "https://weibo.com/",
      },
      signal: timeoutSignal(15000),
    });
    const json = await res.json();
    if (json.retcode !== 20000000 || !json.data || !json.data.qrid) {
      return jsonResponse({
        code: json.retcode !== undefined ? json.retcode : 500,
        msg: "生成二维码失败: " + (json.msg || "未知错误"),
        data: [],
      });
    }
    const qrid = json.data.qrid;
    const imageUrl = String(json.data.image || "");
    // 二维码内容 = 图片 URL 中 data 参数（即扫码确认链接）
    let scanUrl = "";
    try {
      const q = new URL(imageUrl).searchParams;
      scanUrl = q.get("data") || "";
    } catch (e) {
      scanUrl = "";
    }
    if (!scanUrl) {
      scanUrl = "https://passport.weibo.cn/signin/qrcode/scan?qr=" + encodeURIComponent(qrid);
    }
    return jsonResponse({
      code: 0,
      msg: "ok",
      data: {
        qrid: qrid,
        scan_url: scanUrl,
        qr_image_url: imageUrl,
      },
    });
  } catch (e) {
    return jsonResponse({ code: 500, msg: "请求微博接口失败: " + (e && e.message ? e.message : "未知错误"), data: [] });
  }
}
