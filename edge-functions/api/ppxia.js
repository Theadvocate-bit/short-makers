/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/2/23 下午11:21
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: 皮皮虾去水印解析
 * @Remark: 已由 PHP 版移植为 EdgeOne Makers 边缘函数版
 */

const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type",
};

// PHP empty() 等价实现
function phpEmpty(v) {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    v === 0 ||
    v === "0" ||
    v === false ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)
  );
}

// PHP isset($a['b']) 等价：存在且不为 null
function issetVal(v) {
  return v !== undefined && v !== null;
}

// 对应 PHP getRedirectUrl()：HEAD 请求并跟随重定向，取 CURLINFO_EFFECTIVE_URL（最终地址）
async function getRedirectUrl(url) {
  let resp;
  try {
    resp = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: timeoutSignal(30000),
    });
  } catch (e) {
    throw new Error(
      "Curl error while getting redirect URL: " + (e && e.message ? e.message : String(e))
    );
  }
  // resp.url 为跟随重定向后的最终 URL；无重定向时即原 URL
  return resp.url || String(url);
}

// 对应 PHP curl()：跟随重定向的通用请求
async function request(url, headers = null, data = null) {
  try {
    const resp = await fetch(url, {
      method: data !== null && data !== undefined ? "POST" : "GET",
      headers: headers === null ? undefined : headers,
      body: data === null || data === undefined ? undefined : data,
      redirect: "follow",
      signal: timeoutSignal(30000),
    });
    return await resp.text();
  } catch (e) {
    throw new Error(
      "Curl error while making request: " + (e && e.message ? e.message : String(e))
    );
  }
}

// 对应 PHP pipixia()
async function pipixia(url) {
  try {
    url = await getRedirectUrl(url);
    const newurl = await getRedirectUrl(url);
    const m = /item\/(.*)\?/.exec(url);
    if (!m || !issetVal(m[1])) {
      return { code: 404, msg: "无法从 URL 中提取视频 ID" };
    }
    const id = m[1];

    const apiUrl = `https://h5.pipix.com/bds/cell/cell_h5_comment/?count=5&aid=1319&app_name=super&cell_id=${id}`;
    const response = await request(apiUrl);
    let arr = null;
    try {
      arr = JSON.parse(response);
    } catch (e) {
      return { code: 404, msg: "JSON 解析失败" };
    }

    const item = issetVal(arr) && typeof arr === "object"
      ? arr?.data?.cell_comments?.[1]?.comment_info?.item
      : undefined;
    if (arr !== null && typeof arr === "object" && issetVal(item)) {
      const videoUrl = item?.video?.video_high?.url_list?.[0]?.url ?? null;
      const imageData = item?.note ?? null;
      // 1. 先初始化数组，避免后续使用时出现未定义变量警告
      const imgurl = [];

      // 2. 第一层防护：检查 multi_image 是否存在且是数组/对象
      if (
        imageData !== null &&
        typeof imageData === "object" &&
        issetVal(imageData.multi_image) &&
        typeof imageData.multi_image === "object"
      ) {
        for (const sub of Object.values(imageData.multi_image)) {
          // 3. 第二层防护：检查 url_list 是否存在、是数组且第一个元素存在
          if (
            sub !== null &&
            typeof sub === "object" &&
            issetVal(sub.url_list) &&
            Array.isArray(sub.url_list) &&
            sub.url_list.length > 0
          ) {
            // 4. 第三层防护：检查第一个元素是否有 url 字段
            if (
              sub.url_list[0] !== null &&
              typeof sub.url_list[0] === "object" &&
              issetVal(sub.url_list[0].url)
            ) {
              imgurl.push(sub.url_list[0].url);
            }
          }
        }
      }
      const result = {
        code: 200,
        msg: "解析成功",
        data: {
          author: item?.author?.name ?? null,
          avatar: item?.author?.avatar?.download_list?.[0]?.url ?? null,
          title: item?.content ?? null,
          cover: item?.cover?.url_list?.[0]?.url ?? null,
          url: videoUrl,
          imgurl: imgurl,
        },
      };
      return result;
    } else {
      return { code: 404, msg: "解析失败，未找到所需数据" };
    }
  } catch (e) {
    return { code: 404, msg: "解析过程中出现错误: " + (e && e.message ? e.message : String(e)) };
  }
}

export async function parse(shareUrl, env) {
  const url = shareUrl === undefined || shareUrl === null ? "" : String(shareUrl);
  if (phpEmpty(url)) {
    return { code: 201, msg: "链接不能为空！" };
  }
  const info = await pipixia(url);
  return info;
}

export function jsonResponse(data) {
  return new Response(JSON.stringify(data), { status: 200, headers: CORS_HEADERS });
}

export async function onRequest(context) {
  const request = context.request;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  // PHP 仅读取 $_GET['url']
  const u = new URL(request.url);
  let input = u.searchParams.get("url") || "";
  input = String(input).trim();
  if (!input) {
    return jsonResponse({ code: 201, msg: "链接不能为空！" });
  }
  try {
    return jsonResponse(await parse(input, context.env));
  } catch (e) {
    return jsonResponse({
      code: 500,
      msg: "解析失败: " + (e && e.message ? e.message : "未知错误"),
      data: [],
    });
  }
}

// ---------- 兼容性辅助：边缘函数运行时不支持 AbortSignal.timeout() ----------
function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), Number(ms) || 0);
  return controller.signal;
}
