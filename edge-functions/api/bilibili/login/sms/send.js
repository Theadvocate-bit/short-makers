/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/11/14
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @tip: B站登录·发送短信验证码（EdgeOne Makers 边缘函数版）
 * @Remark: 新增功能（非原项目接口）。POST /api/bilibili/login/sms/send
 *          body(JSON): {cid, tel, token, challenge, validate, seccode}
 *          先由前端 /api/bilibili/login/captcha 获取 token/gt/challenge，
 *          geetest 滑块由用户手动完成后再调用本接口发送短信。
 *          成功返回 data.grecaptcha_token 供 confirm 接口使用。
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
  const token = String((body && body.token) || "");
  const challenge = String((body && body.challenge) || "");
  const validate = String((body && body.validate) || "");
  const seccode = String((body && body.seccode) || "");
  if (!tel) {
    return jsonResponse({ code: 400, msg: "请输入手机号", data: [] }, 400);
  }

  try {
    const form = new URLSearchParams({
      cid: cid,
      tel: tel,
      source: "main_web",
      token: token,
      challenge: challenge,
      validate: validate,
      seccode: seccode,
    });
    const res = await fetch("https://passport.bilibili.com/x/passport-login/web/sms/send?source=main_web", {
      method: "POST",
      headers: {
        "User-Agent": DESKTOP_UA,
        "Referer": "https://passport.bilibili.com/",
        "Origin": "https://passport.bilibili.com",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: timeoutSignal(30000),
    });
    const json = await res.json().catch(function () { return null; });
    if (!json) {
      return jsonResponse({ code: 500, msg: "响应不是有效 JSON", data: [] });
    }
    if (json.code !== 0) {
      return jsonResponse({
        code: json.code,
        msg: "发送验证码失败: " + (json.message || "未知错误"),
        data: { need_captcha: json.code === -105 },
      });
    }
    const data = json.data || {};
    const grecaptchaToken = data.grecaptcha_token || data.recaptcha_token || data.token || "";
    return jsonResponse({
      code: 0,
      msg: "验证码已发送，请查收短信",
      data: {
        grecaptcha_token: grecaptchaToken,
        token: grecaptchaToken, // 别名字段：兼容不同命名的读取方
        recaptcha_token: grecaptchaToken,
        recaptcha_url: data.recaptcha_url || "",
      },
    });
  } catch (e) {
    return jsonResponse({ code: 500, msg: "发送验证码异常: " + (e && e.message ? e.message : "未知错误"), data: [] });
  }
}
