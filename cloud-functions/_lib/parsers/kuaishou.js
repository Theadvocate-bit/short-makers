/**
 * short-makers · 快手解析器（Node.js ES Module 移植）
 *
 * 移植自原项目 api/kuaishou/KuaishouSpider.php + ksjx.php。
 * 逻辑：
 *   1. 分享短链用 redirect:'manual' 跟随 302 拿真实地址；
 *   2. 带 UA/Referer/Cookie 抓页面 HTML；
 *   3. 从路径提取内容类型(short-video/long-video/photo)与内容 ID；
 *   4. 优先解析 window.INIT_STATE，回退 window.__APOLLO_STATE__；
 *   5. 图集/单图/视频按字段结构输出，媒体直链用 env.PROXY_BASE + base64 包裹（防盗链）。
 * Cookie：KUAISHOU_COOKIE 环境变量（可选，原 PHP 写死为空串；缺失则不带 Cookie 头）。
 * 只依赖边缘运行时标准 fetch，无第三方包；禁止动态 import。
 */

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1 Edg/122.0.0.0';

const REQUEST_TIMEOUT_MS = 15000;

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

/**
 * 从链接提取内容类型与内容 ID（移植 extractContentIdAndType）。
 * 返回 [type, id]，未识别时 type/id 均为空串。
 */
function extractContentIdAndType(url) {
  const patterns = [
    ['short-video', /short-video\/([^?]+)/],
    ['long-video', /long-video\/([^?]+)/],
    ['photo', /photo\/([^?]+)/],
  ];
  for (const [type, re] of patterns) {
    const m = String(url).match(re);
    if (m) return [type, m[1] || ''];
  }
  return ['', ''];
}

/** 用 HEAD + redirect:'manual' 取 302 后的真实地址（移植 getRedirectedUrl） */
async function getRedirectedUrl(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const location = res.headers.get('location');
    if (location) {
      try {
        return new URL(location, url).href;
      } catch {
        return location;
      }
    }
  } catch {
    // 拿不到重定向就退回原始 URL
  }
  return url;
}

/** 抓取页面 HTML（带浏览器头 + 可选 Cookie，移植 curlRequest 的头集合） */
async function fetchPage(url, cookie) {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      Pragma: 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'sec-ch-ua': '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'User-Agent': UA,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return res.text();
}

/**
 * 从 INIT_STATE JSON 里筛出有效媒体节点（移植 filterMediaData）：
 * 顶层 key 以 tusjoh 开头，且带 fid 或 photo 字段。
 */
function filterMediaData(data) {
  const filtered = [];
  if (!data || typeof data !== 'object') return filtered;
  for (const key of Object.keys(data)) {
    const value = data[key];
    if (
      String(key).startsWith('tusjoh') &&
      value &&
      typeof value === 'object' &&
      (value.fid !== undefined || value.photo !== undefined)
    ) {
      filtered.push(value);
    }
  }
  return filtered;
}

/** 从 photo.music / photo.soundTrack 提取公共音乐信息 */
function buildMusicInfo(photo) {
  const source = photo.music ?? photo.soundTrack;
  if (!source || typeof source !== 'object') return {};
  const cover = source.imageUrls?.[0]?.url ?? source.avatarUrls?.[0]?.url ?? '';
  return {
    name: source.name ?? '',
    artist: source.artist ?? '',
    cover,
    url: source.audioUrls?.[0]?.url ?? '',
  };
}

/** 解析 INIT_STATE（移植 extractFromInitState），命中返回结果对象，未命中返回 null */
function extractFromInitState(pageContent, proxied) {
  const m = pageContent.match(/window\.INIT_STATE\s*=\s*([\s\S]*?)<\/script>/);
  if (!m) return null;

  let jsonString = m[1].trim().replace(/;+$/, '');
  let data;
  try {
    data = JSON.parse(jsonString);
  } catch {
    // 与原 PHP 一致：先 stripslashes，再替换两类内嵌错误 JSON 后重试
    const cleaned = jsonString
      .replace(/\\(["'\\])/g, '$1')
      .replace(/"\{"err_msg":"launchApplication:fail"\}"/g, '"err_msg","launchApplication:fail"')
      .replace(/"\{"err_msg":"system:access_denied"\}"/g, '"err_msg","system:access_denied"');
    try {
      data = JSON.parse(cleaned);
    } catch (err) {
      return { code: 500, msg: 'JSON解析错误: ' + String(err?.message || err) };
    }
  }

  const filtered = filterMediaData(data);
  if (!filtered.length) return null;

  const photo = filtered[0].photo ?? {};
  const musicInfo = buildMusicInfo(photo);

  // 1. 图集
  const imageList = photo.ext_params?.atlas?.list ?? [];
  if (imageList.length) {
    return {
      code: 200,
      msg: 'success',
      data: {
        type: 'image',
        title: photo.caption ?? '',
        author: photo.userName ?? '',
        avatar: proxied(photo.headUrl ?? ''),
        count: imageList.length,
        like: photo.likeCount ?? 0,
        time: photo.timestamp ?? 0,
        music: 'http://txmov2.a.kwimgs.com' + (photo.ext_params?.atlas?.music ?? ''),
        images: imageList.map((path) => proxied('http://tx2.a.yximgs.com/' + path)),
        api: 1,
      },
    };
  }

  // 2. 单张图片
  const isSingle =
    photo.photoType === 'SINGLE_PICTURE' || photo.singlePicture === true;
  if (isSingle) {
    const imageUrl = photo.coverUrls?.[0]?.url ?? '';
    if (imageUrl) {
      return {
        code: 200,
        msg: '解析成功',
        data: {
          type: 'image',
          author: photo.userName ?? '',
          avatar: proxied(photo.headUrl ?? ''),
          like: photo.likeCount ?? 0,
          time: photo.timestamp ?? 0,
          title: photo.caption ?? '',
          cover: proxied(imageUrl),
          url: proxied(imageUrl),
          images: [proxied(imageUrl)],
          music: musicInfo,
        },
      };
    }
  }

  // 3. 视频
  if (photo.mainMvUrls || photo.photoType === 'VIDEO') {
    let videoUrl = photo.mainMvUrls?.[0]?.url ?? '';
    if (!videoUrl) {
      videoUrl =
        photo.manifest?.adaptationSet?.[0]?.representation?.[0]?.url ?? '';
    }
    if (videoUrl) {
      return {
        code: 200,
        msg: '解析成功',
        data: {
          type: 'video',
          author: photo.userName ?? '',
          avatar: proxied(photo.headUrl ?? ''),
          like: photo.likeCount ?? 0,
          time: photo.timestamp ?? 0,
          title: photo.caption ?? '',
          cover: proxied(photo.coverUrls?.[0]?.url ?? ''),
          url: proxied(videoUrl),
          music: musicInfo,
        },
      };
    }
  }

  return null;
}

/** 解析 __APOLLO_STATE__（移植 extractFromApolloState），命中返回结果对象，未命中返回 null */
function extractFromApolloState(pageContent, contentId, contentType, proxied) {
  const m = pageContent.match(/window\.__APOLLO_STATE__\s*=\s*([\s\S]*?)<\/script>/);
  if (!m) return null;

  let cleaned = m[1].replace(/function\s*\([^)]*\)\s*{[^}]*}/g, ':');
  cleaned = cleaned.replace(/,\s*(?=}|])/g, '');
  cleaned = cleaned.replace(/;\(:\(\)\);/g, '');

  let apolloState;
  try {
    apolloState = JSON.parse(cleaned);
  } catch {
    return null;
  }

  const videoInfo = apolloState.defaultClient;
  if (!videoInfo || typeof videoInfo !== 'object') return null;

  const videoData = videoInfo['VisionVideoDetailPhoto:' + contentId];
  if (!videoData || typeof videoData !== 'object') return null;

  let authorData = null;
  for (const key of Object.keys(videoInfo)) {
    if (String(key).startsWith('VisionVideoDetailAuthor:')) {
      authorData = videoInfo[key];
      break;
    }
  }

  let videoUrl = '';
  if (contentType === 'long-video') {
    videoUrl =
      videoData.manifestH265?.json?.adaptationSet?.[0]?.representation?.[0]
        ?.backupUrl?.[0] ?? '';
  } else {
    videoUrl = videoData.photoUrl ?? '';
  }
  if (!videoUrl) return null;

  const type = contentType === 'photo' ? 'image' : 'video';

  return {
    code: 200,
    msg: '解析成功',
    data: {
      type,
      author: authorData?.name ?? '',
      avatar: proxied(authorData?.headerUrl ?? ''), // APOLLO_STATE 字段可能不同，按假设映射 headerUrl
      title: videoData.caption ?? '',
      cover: proxied(videoData.coverUrl ?? ''),
      url: proxied(videoUrl),
    },
  };
}

/**
 * 解析快手视频/图集/单图
 * @param {string} url 用户提交的分享链接
 * @param {object} env Makers 环境变量（含可选 PROXY_BASE / KUAISHOU_COOKIE）
 */
export async function parse(url, env = {}) {
  const cookie = (env && env.KUAISHOU_COOKIE) || '';
  const proxied = makeProxied(env);

  if (!url) {
    return jsonOut({ code: 201, msg: 'url为空' });
  }

  const redirectUrl = await getRedirectedUrl(url);
  if (!redirectUrl) {
    return jsonOut({ code: 400, msg: '无法获取有效链接' });
  }

  let pageContent;
  try {
    pageContent = await fetchPage(redirectUrl, cookie);
  } catch (err) {
    return jsonOut({ code: 500, msg: '页面内容获取失败', detail: String(err?.message || err) });
  }

  const [contentType, contentId] = extractContentIdAndType(redirectUrl);
  if (!contentId) {
    return jsonOut({ code: 400, msg: '无法识别的链接类型' });
  }

  const result =
    extractFromInitState(pageContent, proxied) ??
    extractFromApolloState(pageContent, contentId, contentType, proxied);

  if (!result) {
    return jsonOut({ code: 404, msg: '未找到有效媒体信息' });
  }
  return jsonOut(result);
}
