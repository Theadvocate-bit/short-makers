/**
 * short-makers · 小红书解析器（Node.js ES Module 移植）
 *
 * 移植自原项目 api/xiaohongshu/XiaohongshuParser.php + xhsjx.php。
 * 逻辑：
 *   1. 归一化链接（xhs.com → xhslink.com），短链用 redirect:'manual' 跟随 302 拿真实地址；
 *   2. 从路径提取笔记 ID；
 *   3. 抓页面解析 window.__INITIAL_STATE__，失败则换备用移动 UA 重试，
 *      再失败则取 xsec_token 请求 discovery/item 接口兜底；
 *   4. 图文/视频/实况按字段结构输出，媒体直链用 env.PROXY_BASE + base64 包裹（防盗链）。
 * Cookie：XIAOHONGSHU_COOKIE 环境变量（可选，原 PHP 写死为空串；缺失则不带 Cookie 头）。
 * 只依赖边缘运行时标准 fetch，无第三方包；禁止动态 import。
 */

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0';
const BACKUP_MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36 EdgA/143.0.0.0';

const REQUEST_TIMEOUT_MS = 10000;

function jsonOut(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/** 空安全字符串转换 */
function strv(value) {
  if (typeof value === 'string') return value;
  return value === null || value === undefined ? '' : String(value);
}

/** 媒体直链防盗链代理：用 env.PROXY_BASE + base64 包裹（契约第 5 节） */
function makeProxied(env) {
  const base = (env && env.PROXY_BASE) || '';
  return function proxied(rawUrl) {
    const s = strv(rawUrl);
    if (s === '') return '';
    if (base === '') return s; // 未配置代理基地址时退回原直链
    let b64;
    try {
      b64 = btoa(unescape(encodeURIComponent(s)));
    } catch {
      b64 = btoa(encodeURI(s));
    }
    return base + b64;
  };
}

/** 提取笔记 ID（移植 extractId） */
function extractId(url) {
  const patterns = [
    /discovery\/item\/([a-zA-Z0-9]+)/,
    /explore\/([a-zA-Z0-9]+)/,
    /item\/([a-zA-Z0-9]+)/,
    /note\/([a-zA-Z0-9]+)/,
  ];
  for (const re of patterns) {
    const m = String(url).match(re);
    if (m) return m[1];
  }
  return null;
}

/** 获取重定向后的真实链接：优先命中含 ID 特征的地址（移植 getRealUrl） */
async function getRealUrl(url) {
  let current = url;
  let last = url;
  for (let i = 0; i < 5; i++) {
    let location;
    try {
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': DESKTOP_UA },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      location = res.headers.get('location');
    } catch {
      break;
    }
    if (!location) break;
    let absolute = location;
    try {
      absolute = new URL(location, current).href;
    } catch {
      absolute = location;
    }
    last = absolute;
    if (extractId(absolute)) return absolute;
    current = absolute;
  }
  return last;
}

/** 抓取页面 HTML（带浏览器头 + 可选 Cookie） */
async function request(url, cookie, userAgent = DESKTOP_UA) {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
      'User-Agent': userAgent,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return res.text();
}

/** 从 HTML 提取并解析 window.__INITIAL_STATE__ 里的笔记（移植 extractJson） */
function extractJson(html, id) {
  const m = html.match(
    /<script>\s*window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})<\/script>/i
  );
  if (!m) return null;

  let jsonStr = m[1].replace(/undefined/g, 'null');
  let json;
  try {
    json = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  // 路径1: note -> noteDetailMap -> id -> note
  let note = json?.note?.noteDetailMap?.[id]?.note ?? null;
  // 路径2: noteData -> data -> noteData
  if (!note) {
    note = json?.noteData?.data?.noteData ?? null;
  }
  return note ? formatNoteData(note) : null;
}

/** 处理图片链接，去除水印（移植 processImageUrl，逐条还原用 3http 拼接的多图） */
function processImageUrl(url) {
  const raw = strv(url);
  if (raw === '') return '';

  // 处理多个 URL 粘在一起的情况（用 "3http" 分隔）
  if (raw.includes('3http') && !raw.startsWith('http')) {
    const parts = raw.split(/(?=3http)/);
    let processed = '';
    for (let u of parts) {
      if (u.startsWith('http')) {
        u = u.replace(/^3http/, 'http');
      }
      processed += processImageUrl(u);
    }
    return processed;
  }

  // 1. /oss-sg/<dir>/<id>! 结构
  let m = raw.match(/\/oss-sg\/([a-zA-Z0-9_]+)\/([a-zA-Z0-9]+)!/);
  if (m && !/^[a-f0-9]{32}$/.test(m[1]) && !/^\d+$/.test(m[1])) {
    return (
      'https://sns-img-hw.xhscdn.com/oss-sg/' + m[1] + '/' + m[2] + '?imageView2/2/w/0/format/jpg'
    );
  }

  // 2. notes_pre_post / spectrum 等通用 <dir>/<id>! 匹配
  m = raw.match(/\/([a-zA-Z0-9_]+)\/([a-zA-Z0-9]+)!/);
  if (m && !/^[a-f0-9]{32}$/.test(m[1]) && !/^\d+$/.test(m[1])) {
    return 'https://sns-img-hw.xhscdn.com/' + m[1] + '/' + m[2] + '?imageView2/2/w/0/format/jpg';
  }

  // 不带 ! 的短链接兜底
  m = raw.match(/(notes_pre_post|spectrum|notes_uhdr)\/([a-zA-Z0-9]+)/);
  if (m) {
    return 'https://sns-img-hw.xhscdn.com/' + m[1] + '/' + m[2] + '?imageView2/2/w/0/format/jpg';
  }

  // 3. 其他带 ! 的图片链接（如实况图）
  m = raw.match(/\/([a-zA-Z0-9]+)!/);
  if (m) {
    return 'https://ci.xiaohongshu.com/' + m[1] + '?imageView2/2/w/0/format/jpg';
  }

  return raw;
}

/** 格式化笔记数据（移植 formatNoteData），媒体直链经 proxied 包裹 */
function formatNoteData(note, proxied) {
  let type = note.type ?? 'unknown';
  if (type === 'normal') type = 'image';

  // 提取封面 URL：视频优先从 imageList 取
  let coverUrl = '';
  const firstImage = note.imageList?.[0];
  if (firstImage) {
    coverUrl = firstImage.urlPre ?? firstImage.urlDefault ?? firstImage.url ?? '';
  }
  if (!coverUrl && type === 'video' && note.video?.image?.thumbnailFileid) {
    coverUrl = 'https://sns-img-hw.xhscdn.com/' + note.video.image.thumbnailFileid;
  }
  if (!coverUrl && note.cover?.url) {
    coverUrl = note.cover.url;
  }
  if (!coverUrl && note.cover?.fileId) {
    coverUrl = 'https://sns-img-hw.xhscdn.com/' + note.cover.fileId + '?imageView2/2/w/0/format/jpg';
  }

  const result = {
    type, // video / image / live
    title: note.title ?? '',
    desc: note.desc ?? '',
    author: {
      name: note.user?.nickname ?? note.user?.nickName ?? '',
      id: note.user?.userId ?? '',
      avatar: proxied(note.user?.avatar ?? ''),
    },
    cover: proxied(processImageUrl(coverUrl)),
    url: null,
    images: [],
    live_photo: [],
  };

  // 处理视频
  if (result.type === 'video') {
    let videoUrl = null;
    let videoBackup = null;
    const streams = [];

    // 优先收集 h265（通常无水印且画质更好），其次 h264
    const h265 = note.video?.media?.stream?.h265;
    if (Array.isArray(h265)) {
      for (const stream of h265) streams.push({ ...stream, _codec: 'h265' });
    }
    const h264 = note.video?.media?.stream?.h264;
    if (Array.isArray(h264)) {
      for (const stream of h264) streams.push({ ...stream, _codec: 'h264' });
    }

    if (streams.length) {
      // 优先 h265，其次按平均码率降序
      streams.sort((a, b) => {
        if (a._codec !== b._codec) {
          if (a._codec === 'h265') return -1;
          if (b._codec === 'h265') return 1;
        }
        const ba = Number(a.avgBitrate ?? a.videoBitrate ?? 0);
        const bb = Number(b.avgBitrate ?? b.videoBitrate ?? 0);
        return bb - ba;
      });
      videoUrl = streams[0].masterUrl ?? null;
      if (streams.length > 1) videoBackup = streams[1].masterUrl ?? null;
    }

    // 兜底：originVideoKey 拼接
    if (!videoUrl && note.video?.consumer?.originVideoKey) {
      videoUrl = 'http://sns-video-bd.xhscdn.com/' + note.video.consumer.originVideoKey;
    }

    result.url = videoUrl ? proxied(videoUrl) : null;
    result.video_backup = videoBackup ? proxied(videoBackup) : null;
  }

  // 处理图片和实况
  if (Array.isArray(note.imageList)) {
    for (const img of note.imageList) {
      const imageUrl = img.url ?? img.urlDefault ?? img.urlPre ?? null;
      if (imageUrl) {
        result.images.push(proxied(processImageUrl(imageUrl)));
      }

      // 实况图（Live Photo）：imageList item 里的 stream 字段
      let liveVideoUrl =
        img.stream?.h264?.[0]?.masterUrl ?? img.stream?.h265?.[0]?.masterUrl ?? null;
      if (liveVideoUrl) {
        result.live_photo.push({
          image: proxied(processImageUrl(imageUrl ?? '')),
          video: proxied(liveVideoUrl),
        });
      }
    }
    // 提取到实况视频则修正类型为实况
    if (result.live_photo.length) {
      result.type = 'live';
    }
  }

  return result;
}

/**
 * 解析小红书图文/视频/实况
 * @param {string} url 用户提交的分享链接
 * @param {object} env Makers 环境变量（含可选 PROXY_BASE / XIAOHONGSHU_COOKIE）
 */
export async function parse(url, env = {}) {
  const cookie = (env && env.XIAOHONGSHU_COOKIE) || '';
  const proxied = makeProxied(env);

  if (!url) {
    return jsonOut({ code: 400, msg: '请输入小红书链接', data: [] });
  }

  // 某些分享链接是 xhs.com，直接访问可能无法正确跳转，需转换为 xhslink.com
  url = String(url).replace(/xhs\.com/g, 'xhslink.com');

  let domain = '';
  try {
    domain = new URL(url).hostname;
  } catch {
    domain = '';
  }

  let target = url;
  let id;
  if (domain === 'www.xiaohongshu.com') {
    id = extractId(url);
  } else {
    // 短链或需重定向的链接，先跟随 302 拿真实地址
    target = await getRealUrl(url);
    id = extractId(target);
  }

  if (!id) {
    return jsonOut({
      code: 400,
      msg: '链接格式错误，无法提取ID。处理后的链接: ' + target,
      data: [],
    });
  }

  // 第一次请求
  let response;
  try {
    response = await request(target, cookie);
  } catch (err) {
    return jsonOut({ code: 500, msg: '请求失败', data: [], detail: String(err?.message || err) });
  }

  let data = extractJson(response, id);

  // 失败则用备用移动 UA 重试
  if (!data) {
    try {
      const retryResponse = await request(target, cookie, BACKUP_MOBILE_UA);
      if (retryResponse) data = extractJson(retryResponse, id);
    } catch {
      // 重试失败忽略，走 token 兜底
    }
  }

  // 再失败则取 xsec_token 请求 discovery/item 接口兜底
  if (!data) {
    let token = '';
    const tokenMatch = response.match(/token=(.*?)&/);
    if (tokenMatch) {
      token = tokenMatch[1];
    } else {
      const xsecMatch = response.match(/"xsec_token":\s*"([^"]+)"/);
      if (xsecMatch) token = xsecMatch[1];
    }

    if (token) {
      const apiUrl =
        'https://www.xiaohongshu.com/discovery/item/' +
        id +
        '?app_platform=android&ignoreEngage=true&app_version=8.69.5&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=' +
        token;
      try {
        const apiResponse = await request(apiUrl, cookie);
        if (apiResponse) data = extractJson(apiResponse, id);
      } catch {
        // 兜底请求失败忽略
      }
    }
  }

  if (data) {
    return jsonOut({ code: 200, msg: '解析成功', data });
  }

  return jsonOut({ code: 404, msg: '解析失败，未找到有效内容', data: [] });
}
