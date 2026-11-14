/**
 * short-makers · 微博视频解析器（Node.js ES Module 移植）
 *
 * 移植自原项目 api/weibo.php（微博视频去水印解析，非文章/图文）。
 * 逻辑：从链接提取视频 ID（video.weibo.com/show / weibo.com/tv / t.cn 短链）
 *       → POST https://weibo.com/tv/api/component?page=/tv/show/{id}
 *         body: data={"Component_Play_Playinfo":{"oid":id}}
 *       → 取 data.Component_Play_Playinfo 里的多清晰度 urls / 封面 / 头像 / 互动数据。
 * 防盗链：视频/封面/头像直链一律用 env.PROXY_BASE + base64 包裹（契约第 5 节）；
 *         原 PHP 写死的第三方代理前缀 https://svproxy.168299.xyz/?type=weibo&proxyurl= 已替换为 env.PROXY_BASE。
 * Cookie：WEIBO_COOKIE 环境变量（可选；原 PHP 写死空 cookie，缺失则不带 Cookie 头）。
 * 只依赖边缘运行时标准 fetch，无第三方包；禁止动态 import。
 */

const COMPONENT_API = 'https://weibo.com/tv/api/component';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';

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
    // 微博 CDN 直链为协议相对（//...），补全 https:
    const full = s.startsWith('//') ? 'https:' + s : s;
    // btoa 不接受非 ASCII，含非 ASCII 的 URL 先做 UTF-8 编码
    let b64;
    try {
      b64 = btoa(unescape(encodeURIComponent(full)));
    } catch {
      b64 = btoa(encodeURI(full));
    }
    return base + b64;
  };
}

/** 安全解析 URL（异常返回 null） */
function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** 单跳取 302 Location（redirect:'manual'，无重定向返回 null） */
async function fetchLocation(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': UA },
    });
    return res.headers.get('location');
  } catch {
    return null;
  }
}

/**
 * 从链接提取视频 ID（移植 extractVideoId）：
 *   - video.weibo.com/show?fid=xxx → fid
 *   - weibo.com/tv/show?fid=xxx 或 weibo.com/tv/(show|v)/xxx → fid 或路径段
 *   - t.cn 短链 → 跟随 302 后递归提取
 */
async function extractVideoId(url, depth = 0) {
  if (!url || depth > 5) return '';

  const u = parseUrl(url);
  if (!u) return '';
  const host = u.hostname.toLowerCase();

  if (host === 't.cn' || host.endsWith('.t.cn')) {
    const loc = await fetchLocation(url);
    if (!loc) return '';
    return extractVideoId(loc, depth + 1);
  }

  if (u.searchParams.get('fid')) return u.searchParams.get('fid');

  if (host === 'weibo.com' || host.endsWith('.weibo.com')) {
    // weibo.com/tv/(show|v)/<id>
    const m = url.match(/weibo\.com\/tv\/(?:show|v)\/([^?&/]+)/i);
    if (m) return m[1];
  }

  return '';
}

/**
 * 解析微博视频
 * @param {string} url 视频链接
 * @param {object} env Makers 环境变量（含 PROXY_BASE 与可选 WEIBO_COOKIE）
 */
export async function parse(url, env = {}) {
  const cookie = (env && env.WEIBO_COOKIE) || '';

  if (!url || typeof url !== 'string') {
    return jsonOut({ code: 201, msg: '链接不能为空！' });
  }

  const videoId = await extractVideoId(url);
  if (!videoId) {
    return jsonOut({ code: 404, msg: '无法从URL中提取视频ID: ' + url });
  }

  const pagePath = '/tv/show/' + videoId;
  const requestUrl = COMPONENT_API + '?page=' + encodeURIComponent(pagePath);
  const requestData = { Component_Play_Playinfo: { oid: videoId } };
  const body = 'data=' + encodeURIComponent(JSON.stringify(requestData));

  let responseData;
  try {
    const res = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Referer: 'https://weibo.com/',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body,
      redirect: 'follow',
    });
    if (!res.ok) {
      return jsonOut({ code: res.status, msg: 'API请求失败，HTTP状态码: ' + res.status });
    }
    responseData = await res.json();
  } catch (err) {
    return jsonOut({ code: 500, msg: 'API请求失败', detail: String(err?.message || err) });
  }

  const code = responseData && typeof responseData.code !== 'undefined' ? responseData.code : null;
  const playinfo = responseData?.data?.Component_Play_Playinfo;
  if (code !== 100000 || !playinfo) {
    let errorMsg = '解析失败,当前链接中的视频不存在。';
    if (code === null) errorMsg = '当前官方接口已失效！';
    else if (code !== 100000) errorMsg = '官方接口响应错误！';
    return jsonOut({ code: 404, msg: errorMsg });
  }

  const proxied = makeProxied(env);

  // 多清晰度 urls：{ '2K': '//..', '1080P': '//..' ... } → 备用列表 + 最优主地址
  const backupUrls = [];
  let best = { priority: -1, url: '', label: '', quality: '' };
  const urls = playinfo.urls && typeof playinfo.urls === 'object' ? playinfo.urls : {};
  for (const quality of Object.keys(urls)) {
    const rawUrl = urls[quality];
    if (!rawUrl) continue;
    const fullUrl = proxied(rawUrl); // proxied 内部补全 https: 并代理包裹

    let qualityKey = 'unknown';
    let priority = 0;
    if (quality.includes('2K')) { qualityKey = 'origin'; priority = 4; }
    else if (quality.includes('1080P')) { qualityKey = 'origin'; priority = 3; }
    else if (quality.includes('720P')) { qualityKey = 'origin'; priority = 2; }
    else if (quality.includes('480P')) { qualityKey = 'hd'; priority = 1; }
    else if (quality.includes('360P')) { qualityKey = 'sd'; priority = 0; }

    backupUrls.push({ label: quality, quality: qualityKey, url: fullUrl });
    if (priority > best.priority) {
      best = { priority, url: fullUrl, label: quality, quality: qualityKey };
    }
  }

  const durationRaw = playinfo.duration_time;
  const duration = typeof durationRaw === 'number' && Number.isFinite(durationRaw) ? Math.trunc(durationRaw) : 0;

  return jsonOut({
    code: 200,
    msg: '解析成功',
    data: {
      type: 'video',
      title: strv(playinfo.title),
      desc: strv(playinfo.title),
      author: {
        name: strv(playinfo.author),
        id: strv(playinfo.author_id),
        avatar: proxied(playinfo.avatar),
      },
      cover: proxied(playinfo.cover_image),
      url: best.url,
      quality: best.quality,
      duration,
      video_backup: backupUrls,
      extra: {
        play_count: playinfo.play_count ?? '',
        reposts_count: playinfo.reposts_count ?? '',
        comments_count: playinfo.comments_count ?? '',
        attitudes_count: playinfo.attitudes_count ?? '',
        ip_info: playinfo.ip_info_str ?? '',
        date: playinfo.date ?? '',
      },
    },
  });
}
