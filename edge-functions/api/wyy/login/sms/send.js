/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/11/14
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @tip: 网易云登录·发送手机短信验证码（EdgeOne Makers 边缘函数版）
 * @Remark: 新增功能（非原项目接口）。POST /api/wyy/login/sms/send
 *          body(JSON): {phone, ctcode?}（ctcode 默认 86）
 *          weapi 调用 /weapi/sms/captcha/sent 发送验证码。
 */

import { weapiPost } from "../weapi.js";

const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type,x-bili-cookie,x-weibo-cookie,x-wyy-cookie",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status: status, headers: CORS_HEADERS });
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

  const phone = body.phone == null ? "" : String(body.phone).trim();
  const ctcode = (body.ctcode == null || String(body.ctcode) === "" ? "86" : String(body.ctcode)).trim();
  if (!phone) {
    return jsonResponse({ code: 400, msg: "手机号不能为空" });
  }

  try {
    const r = await weapiPost(
      "https://music.163.com/weapi/sms/captcha/sent?csrf_token=",
      { phone: phone, ctcode: ctcode },
      null
    );
    const data = r.body;
    if (!data) {
      return jsonResponse({ code: 502, msg: "网易服务返回异常，请稍后重试" });
    }
    if (Number(data.code) !== 200) {
      return jsonResponse({ code: Number(data.code) || 500, msg: (data && (data.msg || data.message)) || "验证码发送失败", data: data });
    }
    return jsonResponse({ code: 0, msg: "验证码已发送", data: data });
  } catch (e) {
    return jsonResponse({ code: 500, msg: "发送验证码失败: " + (e && e.message ? e.message : "未知错误") });
  }
}
