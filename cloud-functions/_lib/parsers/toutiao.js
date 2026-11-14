/**
 * short-makers · 今日头条解析器（Node.js 移植）
 *
 * 移植自原项目 api/toutiao.php。
 * 逻辑：从分享链接（跟随 302）提取视频 ID → 抓 https://www.toutiao.com/video/{id}
 *       页面 → 提取 <script id="RENDER_DATA"> 里的 JSON → urldecode → 取视频字段。
 * Cookie：TOUTIAO_COOKIE 环境变量（可选，部分场景需要）。
 * 只依赖边缘运行时标准 fetch，无第三方包。
 */

const UA =
  'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.69 Safari/537.36';

function jsonOut(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/** 从链接提取视频 ID：分享短链先跟 302，再正则取数字 ID（移植 extractId） */
async function extractId(url) {
  let loc = url;
  try {
    // 跟随重定向拿最终地址（toutiao 分享链接常 302 到 /video/{id}）
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': UA },
    });
    const location = res.headers.get('location');
    if (location) loc = location;
  } catch {
    // 拿不到重定向就用原始 URL
  }

  const match = String(loc).match(/video\/(\d+)|(\d{5,})/);
  if (match) return match[1] || match[2];
  return null;
}

/** 抓页面 HTML */
async function fetchPage(url, cookie) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.toutiao.com/',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    redirect: 'follow',
  });
  return res.text();
}

/**
 * 解析今日头条视频
 * @param {string} url 视频链接
 * @param {object} env Makers 环境变量（含可选 TOUTIAO_COOKIE）
 */
export async function parse(url, env = {}) {
  const cookie = env.TOUTIAO_COOKIE || '';
  if (!url) {
    return jsonOut({ code: 201, msg: 'url为空' });
  }

  const id = await extractId(url);
  if (!id) {
    return jsonOut({ code: 400, msg: '无法解析视频 ID' });
  }

  let html;
  try {
    html = await fetchPage('https://www.toutiao.com/video/' + id, cookie);
  } catch (err) {
    return jsonOut({ code: 0, msg: '请求头条页面失败', detail: String(err?.message || err) });
  }

  // 提取 RENDER_DATA 里的 JSON（URL 编码），再 urldecode
  const startStr = '<script id="RENDER_DATA" type="application/json">';
  const endStr = '</script>';
  const posStart = html.indexOf(startStr);
  if (posStart === -1) {
    return jsonOut({ code: 404, msg: '无法找到数据' });
  }
  let jsonStr = html.slice(posStart + startStr.length);
  const posEnd = jsonStr.indexOf(endStr);
  if (posEnd === -1) {
    return jsonOut({ code: 404, msg: '无法正确提取JSON数据，未找到结束标签' });
  }
  jsonStr = jsonStr.slice(0, posEnd);
  jsonStr = decodeURIComponent(jsonStr);

  let videoInfo;
  try {
    videoInfo = JSON.parse(jsonStr);
  } catch (err) {
    return jsonOut({ code: 404, msg: 'JSON解析失败：' + String(err?.message || err) });
  }

  const data = videoInfo.data;
  if (!data || !data.itemId) {
    return jsonOut({ code: 404, msg: '当前分享链接已失效！', data: [] });
  }

  const cell = data.initialVideo || {};
  const userInfo = cell.itemCell?.userInfo || {};
  const videoList = cell.videoPlayInfo?.video_list || {};
  // 原项目优先取 video_list[2].main_url，回退 [1]
  const videoUrl = videoList[2]?.main_url || videoList[1]?.main_url || '';

  return jsonOut({
    code: 200,
    msg: '解析成功',
    data: {
      itemId: data.itemId,
      videoType: data.videoType,
      author: userInfo.name,
      userID: userInfo.userID,
      avatar: userInfo.avatarURL,
      description: userInfo.description,
      title: cell.title,
      cover: cell.coverUrl,
      url: videoUrl,
      music: cell.itemCell?.videoAbility?.music,
    },
  });
}
