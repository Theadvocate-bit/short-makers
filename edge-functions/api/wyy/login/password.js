/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/11/14
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @tip: 网易云登录·手机号密码 / 邮箱密码登录（EdgeOne Makers 边缘函数版）
 * @Remark: 新增功能（非原项目接口）。POST /api/wyy/login/password
 *          body(JSON): {phone?, email?, password, countrycode?}
 *          手机号走 /weapi/login/cellphone（password 为 md5 后的值），
 *          邮箱走 /weapi/login；成功后从 Set-Cookie 提取 MUSIC_U 等返回给请求方浏览器。
 *          加密实现见同目录 weapi.js（对齐 NeteaseCloudMusicApi weapi 算法）。
 */

import { HashHexDigest } from "../../wyy.js";
import { weapiPost } from "./weapi.js";

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

  const password = body.password == null ? "" : String(body.password);
  if (!password) {
    return jsonResponse({ code: 400, msg: "密码不能为空" });
  }

  const phone = body.phone == null ? "" : String(body.phone).trim();
  const email = body.email == null ? "" : String(body.email).trim();
  const countrycode = (body.countrycode == null || String(body.countrycode) === "" ? "86" : String(body.countrycode)).trim();
  if (!phone && !email) {
    return jsonResponse({ code: 400, msg: "请输入手机号或网易邮箱" });
  }

  const md5Password = HashHexDigest(password);
  let url;
  let params;
  if (email) {
    url = "https://music.163.com/weapi/login";
    params = { email: email, password: md5Password, rememberLogin: "true" };
  } else {
    url = "https://music.163.com/weapi/login/cellphone";
    params = { phone: phone, countrycode: countrycode, password: md5Password, rememberLogin: "true" };
  }

  try {
    const r = await weapiPost(url + "?csrf_token=", params, null);
    const data = r.body;
    if (!data) {
      return jsonResponse({ code: 502, msg: "网易服务返回异常，请稍后重试" });
    }
    const code = Number(data.code) || 0;
    if (code !== 200) {
      return jsonResponse({
        code: code,
        msg: (data && (data.msg || data.message)) || "登录失败（账号或密码错误）",
        data: data,
      });
    }
    const profile = data.profile || {};
    return jsonResponse({
      code: 0,
      msg: "登录成功",
      data: {
        cookie: r.cookies,
        uid: profile.userId || (data.account && data.account.id) || "",
        nickname: profile.nickname || "",
      },
    });
  } catch (e) {
    return jsonResponse({ code: 500, msg: "登录请求失败: " + (e && e.message ? e.message : "未知错误") });
  }
}
