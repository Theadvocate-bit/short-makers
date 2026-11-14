/**
 * short-makers · 皮皮搞笑(pipigx)解析器（Node.js ES Module 移植）
 *
 * 移植自原项目 api/pipigx.php（皮皮搞笑去水印解析）。
 * 逻辑：从分享链接 query 提取 pid + mid → POST https://h5.pipigx.com/ppapi/share/fetch_content
 *       body: {"pid":<int>,"mid":<int>,"type":"post"} → 取 data.post.content / videos[0]。
 * 字段：title=content；cover=https://file.ippzone.com/img/frame/id/<thumb>；video=videos[0].url。
 * Cookie：PIPIGX_COOKIE 环境变量（可选；原 PHP 未用 cookie，缺失则不带 Cookie 头）。
 * 防盗链：封面/视频直链原样返回（无防盗链包裹需求）。
 * 只依赖边缘运行时标准 fetch，无第三方包；禁止动态 import。
 */

const FETCH_CONTENT_API = 'https://h5.pipigx.com/ppapi/share/fetch_content';
const COVER_PREFIX = 'https://file.ippzone.com/img/frame/id/';

function jsonOut(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * 从 URL 中提取 pid 和 mid 参数（移植 extractParamsFromUrl）
 * @returns {{pid:string, mid:string}|null}
 */
function extractParamsFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!u.search) return null;
  const pid = u.searchParams.get('pid');
  const mid = u.searchParams.get('mid');
  if (pid === null || mid === null || pid === '' || mid === '') return null;
  return { pid, mid };
}

/**
 * 解析皮皮搞笑视频
 * @param {string} url 分享链接（需含 pid 与 mid 参数）
 * @param {object} env Makers 环境变量（含可选 PIPIGX_COOKIE）
 */
export async function parse(url, env = {}) {
  const cookie = (env && env.PIPIGX_COOKIE) || '';

  if (!url || typeof url !== 'string') {
    return jsonOut({ code: 400, msg: '未提供 url 参数' });
  }

  const params = extractParamsFromUrl(url);
  if (!params) {
    return jsonOut({ code: 400, msg: '提取参数出错' });
  }

  const payload = { pid: parseInt(params.pid, 10), mid: parseInt(params.mid, 10), type: 'post' };

  let httpRes;
  try {
    httpRes = await fetch(FETCH_CONTENT_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return jsonOut({ code: 500, msg: '请求发生错误: ' + String(err?.message || err) });
  }

  const httpCode = httpRes.status;
  if (httpCode >= 400) {
    return jsonOut({ code: httpCode, msg: 'HTTP 错误发生: HTTP 状态码 ' + httpCode });
  }

  let decoded;
  try {
    decoded = await httpRes.json();
  } catch (err) {
    return jsonOut({ code: 500, msg: '响应内容不是有效的 JSON 数据: ' + String(err?.message || err) });
  }

  const post = decoded?.data?.post;
  if (!post) {
    return jsonOut({ code: 500, msg: '响应中缺少 data.post 字段' });
  }

  // 收集 videos 数组里的对象条目
  const videoData = [];
  if (Array.isArray(post.videos)) {
    for (const video of post.videos) {
      if (video && typeof video === 'object') videoData.push(video);
    }
  }

  const thumb = videoData[0]?.thumb ?? '';
  const videoUrl = videoData[0]?.url;

  return jsonOut({
    code: 200,
    msg: '解析成功',
    data: {
      title: post.content,
      cover: COVER_PREFIX + thumb,
      video: videoUrl,
    },
  });
}
