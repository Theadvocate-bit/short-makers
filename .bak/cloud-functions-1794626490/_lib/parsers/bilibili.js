/**
 * short-makers · Bilibili 解析器（Node.js 移植）
 *
 * 移植自原项目 api/bilibili/BilibiliParser.php + bilibili.php。
 * 逻辑：从 URL 提取 BV 号（b23.tv 短链先跟 302）→ 调 view 接口拿标题/分P/cid
 *       → 逐分P 调 playurl 接口拿视频直链（镜像域名改写）→ 输出统一 JSON。
 *
 * Cookie：BILIBILI_COOKIE 环境变量（不填解析不到 1080P 以上，基础解析仍可用）。
 * 只依赖边缘运行时标准 fetch，无第三方包。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.81 Safari/537.36';

/** 统一 JSON 输出（保持原项目的 code/msg/data 形状） */
function jsonOut(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/** 清洗 URL：解码路径、去掉末尾斜杠、去掉认证信息（移植 cleanUrlParameters） */
export function cleanUrlParameters(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^.*@/, '');
    const path = decodeURIComponent(u.pathname).replace(/\/+$/, '');
    const frag = u.hash ? '#' + decodeURIComponent(u.hash.slice(1)) : '';
    return `${u.protocol}//${host}${u.port ? ':' + u.port : ''}${path}${frag}`;
  } catch {
    return '';
  }
}

/** 提取 BV 号；b23.tv 短链先跟 302 再取路径（移植 extractBvid） */
async function extractBvid(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname;
  let bvid = '';

  if (host === 'b23.tv') {
    // 短链：手动跟 302 拿最终地址
    const res = await fetch(url, { method: 'GET', redirect: 'manual' });
    const location = res.headers.get('location');
    if (!location) return null;
    const target = new URL(location, url);
    bvid = decodeURIComponent(target.pathname).replace(/\/+$/, '');
  } else if (host === 'www.bilibili.com' || host === 'm.bilibili.com') {
    bvid = decodeURIComponent(u.pathname);
  } else {
    return null;
  }

  if (!bvid.includes('/video/')) return null;
  return bvid.replace('/video/', '');
}

/** 带 Cookie/UA 的 GET，返回 JSON。非 JSON（412/HTML）时抛带明确信息的错误 */
async function requestJson(url, cookie) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) {
    // B站风控：对数据中心 IP 返回 412 + HTML 页面（非 JSON）
    const blocked = res.status === 412 || trimmed.startsWith('<');
    const err = new Error(
      blocked
        ? `B站风控拦截(HTTP ${res.status})，需配置 BILIBILI_COOKIE 或更换出口 IP`
        : `上游返回非 JSON(HTTP ${res.status})`,
    );
    err.blocked = blocked;
    throw err;
  }
  return JSON.parse(trimmed);
}

/**
 * 解析 Bilibili 视频/合集
 * @param {string} url 视频链接
 * @param {object} env Makers 环境变量（含 BILIBILI_COOKIE）
 */
export async function parse(url, env = {}) {
  const cookie = env.BILIBILI_COOKIE || '';
  const cleaned = cleanUrlParameters(url);
  if (!cleaned) {
    return jsonOut({ code: 201, msg: '链接不能为空！' });
  }

  let bvid;
  try {
    bvid = await extractBvid(cleaned);
  } catch (err) {
    return jsonOut({ code: 0, msg: '解析失败！', detail: String(err?.message || err) });
  }
  if (!bvid) {
    return jsonOut({ code: -1, msg: '视频链接好像不太对！' });
  }

  // 拿标题/封面/分P/cid
  let view;
  try {
    view = await requestJson('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, cookie);
  } catch (err) {
    return jsonOut({ code: 0, msg: err?.message || '解析失败！' });
  }
  if ((view?.code ?? -1) !== 0) {
    return jsonOut({ code: 0, msg: '解析失败！' });
  }

  const pages = view.data?.pages || [];
  const videos = [];
  let lastVideoUrl = '';

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const playUrl =
      'https://api.bilibili.com/x/player/playurl?otype=json&fnver=0&fnval=3&player=3&qn=112&bvid=' +
      bvid +
      '&cid=' +
      page.cid +
      '&platform=html5&high_quality=1';

    try {
      const play = await requestJson(playUrl, cookie);
      const rawUrl = play?.data?.durl?.[0]?.url || '';
      // 提取真实视频地址（把 CDN 前缀改成镜像，移植原项目的 preg_replace）
      const videoUrl = rawUrl
        ? rawUrl.replace(/^https?:\/\/[^/]+\//, 'https://upos-sz-mirrorhw.bilivideo.com/')
        : '';
      if (videoUrl) lastVideoUrl = videoUrl;

      videos.push({
        title: page.part,
        duration: page.duration,
        durationFormat: formatDuration(page.duration - 1),
        url: videoUrl,
        index: i + 1,
      });
    } catch {
      videos.push({ title: page.part, error: '无法获取视频链接', index: i + 1 });
    }
  }

  const owner = view.data.owner || {};
  return jsonOut({
    code: 200,
    msg: '解析成功！',
    data: {
      title: view.data.title,
      cover: view.data.pic,
      description: view.data.desc,
      url: lastVideoUrl || null,
      user: { name: owner.name, avatar: owner.face },
      videos,
      totalVideos: videos.length,
    },
  });
}

/** 秒 -> H:i:s（移植 gmdate('H:i:s', duration-1)） */
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}
