/**
 * short-makers · 最右解析器（Node.js ES Module 移植）
 *
 * 移植自原项目 api/zuiyou.php（最右/小红船去水印解析）。
 * 逻辑：从链接（必要时跟随重定向）提取 pid 参数 → POST
 *       https://share.xiaochuankeji.cn/planck/share/post/detail_h5
 *       body: {"pid":<int>,"h_av":"5.2.13.011"} → 取 data.post 里的作者/内容/图片/视频。
 * 说明：原 PHP 也尝试提取 vid，但最终以响应 data.post.imgs[0].id 作为视频 key
 *       （vid 仅在响应缺失时回退提示），此处沿用该行为。
 * Cookie：ZUIYOU_COOKIE 环境变量（可选；原 PHP 未用 cookie，缺失则不带 Cookie 头）。
 * 防盗链：封面/头像/视频直链原样返回（无防盗链包裹需求）。
 * 只依赖边缘运行时标准 fetch，无第三方包；禁止动态 import。
 */

const DETAIL_API = 'https://share.xiaochuankeji.cn/planck/share/post/detail_h5';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

function jsonOut(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/** 从 URL 提取指定 query 参数（移植 getParamFromUrl） */
function getParamFromUrl(url, param) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!u.search) return null;
  return u.searchParams.get(param);
}

/** 单跳取 302 Location（redirect:'manual'，相对地址转绝对） */
async function fetchLocation(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': UA },
    });
    const loc = res.headers.get('location');
    if (!loc) return null;
    try {
      return new URL(loc, url).href;
    } catch {
      return loc;
    }
  } catch {
    return null;
  }
}

/** 从 URL 或其重定向地址中提取指定参数（移植 getParamFromUrlWithRedirect） */
async function getParamFromUrlWithRedirect(url, param) {
  const direct = getParamFromUrl(url, param);
  if (direct) return direct;

  const redirectUrl = await fetchLocation(url);
  if (redirectUrl && redirectUrl !== url) {
    const viaRedirect = getParamFromUrl(redirectUrl, param);
    if (viaRedirect) return viaRedirect;
  }
  return null;
}

/**
 * 解析最右/小红船帖子
 * @param {string} url 分享链接
 * @param {object} env Makers 环境变量（含可选 ZUIYOU_COOKIE）
 */
export async function parse(url, env = {}) {
  const cookie = (env && env.ZUIYOU_COOKIE) || '';

  if (!url || typeof url !== 'string') {
    return jsonOut({ code: 201, msg: '请输入url' });
  }

  // 校验 URL 格式
  let parsedUrl = null;
  try {
    parsedUrl = new URL(url);
  } catch {
    parsedUrl = null;
  }
  if (!parsedUrl || !/^https?:$/i.test(parsedUrl.protocol)) {
    return jsonOut({ code: 201, msg: '请输入有效的URL' });
  }

  const pid = await getParamFromUrlWithRedirect(url, 'pid');
  if (!pid) {
    return jsonOut({ code: 201, msg: '找不到有效的pid参数（包括重定向后）' });
  }

  let apiData;
  try {
    const res = await fetch(DETAIL_API, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify({ pid: parseInt(pid, 10), h_av: '5.2.13.011' }),
      redirect: 'follow',
    });
    apiData = await res.json();
  } catch (err) {
    return jsonOut({ code: 500, msg: 'API请求失败', detail: String(err?.message || err) });
  }

  const postData = apiData?.data?.post ?? {};
  const memberData = postData.member ?? {};
  const videosData = postData.videos ?? {};
  const imgsData = (Array.isArray(postData.imgs) ? postData.imgs[0] : null) ?? {};
  const vid = imgsData.id;

  if (!vid) {
    return jsonOut({ code: 201, msg: '找不到有效的vid参数（包括重定向后）' });
  }

  return jsonOut({
    code: 200,
    msg: '请求成功',
    data: {
      author: memberData.name ?? null,
      avatar: memberData.avatar_urls?.origin?.urls?.[0] ?? null,
      title: postData.content ?? null,
      cover: imgsData.urls?.['540_webp']?.urls?.[0] ?? null,
      url: videosData[vid]?.url ?? null,
    },
  });
}
