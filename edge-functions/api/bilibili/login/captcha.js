/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/11/14
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @tip: B站登录·验证码参数获取（EdgeOne Makers 边缘函数版）
 * @Remark: 新增功能（非原项目接口）。GET /api/bilibili/login/captcha
 *          返回 B 站官方 geetest 验证码参数 {token, gt, challenge}，
 *          供密码登录/短信登录使用；滑块挑战由用户在前端手动完成（geetest gt.js）。
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
    const res = await fetch(
      "https://passport.bilibili.com/x/passport-login/captcha?source=web-main&go_url=/",
      {
        headers: {
          "User-Agent": DESKTOP_UA,
          "Referer": "https://passport.bilibili.com/",
        },
        signal: timeoutSignal(15000),
      }
    );
    const json = await res.json();
    if (json.code !== 0 || !json.data) {
      return jsonResponse({
        code: json.code !== undefined ? json.code : 500,
        msg: "获取验证码参数失败: " + (json.message || "未知错误"),
        data: [],
      });
    }
    const d = json.data;
    if (d.type === "geetest" && d.geetest) {
      return jsonResponse({
        code: 0,
        msg: "ok",
        data: {
          type: "geetest",
          token: d.token || "",
          gt: d.geetest.gt || "",
          challenge: d.geetest.challenge || "",
        },
      });
    }
    // 无需验证码（type 非 geetest），直接携带 token 即可
    return jsonResponse({
      code: 0,
      msg: "ok",
      data: { type: d.type || "unknown", token: d.token || "", gt: "", challenge: "" },
    });
  } catch (e) {
    return jsonResponse({ code: 500, msg: "请求B站接口失败: " + (e && e.message ? e.message : "未知错误"), data: [] });
  }
}
