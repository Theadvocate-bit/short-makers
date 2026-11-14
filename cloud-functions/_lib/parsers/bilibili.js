/**
 * short-makers · Bilibili 解析器（Node.js 移植）
 *
 * 移植自原项目 api/bilibili/BilibiliParser.php + bilibili.php。
 *
 * 双路径（关键）：
 *   - 有 BILIBILI_COOKIE：走原版链路 view(全信息:标题/封面/作者/简介) → playurl。
 *   - 无 cookie 或 view 被 412 风控：回退到免 cookie 链路
 *       pagelist(拿 cid+分P标题) → playurl(platform=html5, 拿视频直链)。
 *     实测 view 接口对数据中心 IP + 无 cookie 返回 412，但 pagelist/playurl 不封，
 *     故免 cookie 可用（代价：拿不到封面/作者/简介，仅有标题+视频直链）。
 *
 * 视频直链做镜像域名改写（移植原项目 preg_replace 到 upos-sz-mirrorhw.bilivideo.com）。
 * Cookie：BILIBILI_COOKIE 环境变量（可选；不填走免 cookie 链路，基础解析仍可用）。
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
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    // B站风控：对数据中心 IP 返回 412 + HTML 页面（非 JSON）
    const blocked = res.status === 412 || trimmed.startsWith('<');
    const err = new Error(
      blocked
        ? `B站风控拦截(HTTP ${res.status})`
        : `上游返回非 JSON(HTTP ${res.status})`,
    );
    err.blocked = blocked;
    throw err;
  }
  return JSON.parse(trimmed);
}

/** 视频直链镜像域名改写（移植 preg_replace） */
function rewriteMirror(rawUrl) {
  return rawUrl
    ? rawUrl.replace(/^https?:\/\/[^/]+\//, 'https://upos-sz-mirrorhw.bilivideo.com/')
    : '';
}

/** 秒 -> H:i:s（移植 gmdate('H:i:s', duration-1)） */
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

/** playurl 接口 URL（platform=html5 免 cookie 可用） */
function playUrlOf(bvid, cid) {
  return (
    'https://api.bilibili.com/x/player/playurl?otype=json&fnver=0&fnval=3&player=3&qn=112&bvid=' +
    bvid +
    '&cid=' +
    cid +
    '&platform=html5&high_quality=1'
  );
}

/**
 * 免 cookie 链路：pagelist(拿 cid+分P标题) → 逐分P playurl(拿直链)。
 * 拿不到封面/作者/简介（那些只在被封的 view 接口里），输出仍保持统一 JSON 形状。
 */
async function parseNoCookie(bvid) {
  let pagelist;
  try {
    pagelist = await requestJson(
      'https://api.bilibili.com/x/player/pagelist?bvid=' + bvid,
      '',
    );
  } catch (err) {
    return jsonOut({ code: 0, msg: '解析失败！', detail: String(err?.message || err) });
  }
  if ((pagelist?.code ?? -1) !== 0 || !Array.isArray(pagelist.data)) {
    return jsonOut({ code: 0, msg: '解析失败！' });
  }

  const pages = pagelist.data;
  const videos = [];
  let lastVideoUrl = '';

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    try {
      const play = await requestJson(playUrlOf(bvid, page.cid), '');
      const rawUrl = play?.data?.durl?.[0]?.url || '';
      const videoUrl = rewriteMirror(rawUrl);
      if (videoUrl) lastVideoUrl = videoUrl;
      videos.push({
        title: page.part,
        duration: page.duration,
        durationFormat: formatDuration((page.duration || 1) - 1),
        url: videoUrl,
        index: i + 1,
      });
    } catch {
      videos.push({ title: page.part, error: '无法获取视频链接', index: i + 1 });
    }
  }

  return jsonOut({
    code: 200,
    msg: '解析成功！',
    data: {
      title: pages[0]?.part || '',
      cover: null,
      description: null,
      url: lastVideoUrl || null,
      user: { name: null, avatar: null },
      videos,
      totalVideos: videos.length,
      mode: 'no-cookie',
    },
  });
}

/**
 * 解析 Bilibili 视频/合集
 * @param {string} url 视频链接
 * @param {object} env Makers 环境变量（含可选 BILIBILI_COOKIE）
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

  // 有 cookie：走原版 view 链路（全信息）。view 被 412 或无 cookie 时回退免 cookie 链路。
  if (cookie) {
    try {
      const view = await requestJson(
        'https://api.bilibili.com/x/web-interface/view?bvid=' + bvid,
        cookie,
      );
      if ((view?.code ?? -1) === 0) {
        const pages = view.data?.pages || [];
        const videos = [];
        let lastVideoUrl = '';

        for (let i = 0; i < pages.length; i++) {
          const page = pages[i];
          try {
            const play = await requestJson(playUrlOf(bvid, page.cid), cookie);
            const videoUrl = rewriteMirror(play?.data?.durl?.[0]?.url || '');
            if (videoUrl) lastVideoUrl = videoUrl;
            videos.push({
              title: page.part,
              duration: page.duration,
              durationFormat: formatDuration((page.duration || 1) - 1),
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
            mode: 'cookie',
          },
        });
      }
      // view 返回非 0（非风控的业务错误），继续尝试免 cookie 链路兜底
    } catch (err) {
      // view 被风控(412)等：回退免 cookie 链路
      if (!err.blocked) {
        // 非风控的其它错误也兜底试一次免 cookie；仍失败则由 parseNoCookie 返回错误
      }
    }
  }

  // 无 cookie 或 view 不可用：免 cookie 链路
  return parseNoCookie(bvid);
}
