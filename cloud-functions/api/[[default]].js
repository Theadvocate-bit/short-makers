/**
 * short-makers · API 统一入口（EdgeOne Makers Edge Function）
 *
 * 路由：cloud-functions/api/[[default]].js  ->  /api/*
 *
 * 采用单个自包含 catch-all（复刻已验证的 hghub-makers 模式），按子路径分发，避免：
 *   1) bare 路径（如 /parse）不命中 [[default]] catch-all 的 Makers 路由行为；
 *   2) 多个模块各导出 onRequest 时的 esbuild 符号冲突（"onRequest has already been declared"）；
 *   3) [[default]].js 里的动态 import() 导致构建失败 Code 18。
 *
 * 端点：
 *   GET /api/parse?url=<视频链接>          -> 聚合解析（移植自 short_videos api/sv.php）
 *   GET /api/proxy?proxyurl=<媒体直链>&...  -> 媒体防盗链代理（移植自 cf_sv_proxy/worker.js）
 *   GET /api                              -> 端点列表
 *
 * 只依赖边缘运行时标准 API（fetch / crypto.subtle / atob / AbortController），无第三方包。
 */

import { detectPlatform, IMPLEMENTED, PLATFORMS } from '../_lib/platforms.js';
// 已移植的平台解析器在此静态注册（待移植平台见 Theadvocate-bit/short_videos）。
// 注意：全部静态 import，且各模块只导出 parse（避免 esbuild onRequest 符号冲突）。
import { parse as parseBilibili } from '../_lib/parsers/bilibili.js';
import { parse as parseToutiao } from '../_lib/parsers/toutiao.js';
import { parse as parseDouyin } from '../_lib/parsers/douyin.js';
import { parse as parseKuaishou } from '../_lib/parsers/kuaishou.js';
import { parse as parseXiaohongshu } from '../_lib/parsers/xiaohongshu.js';
import { parse as parseWeibo } from '../_lib/parsers/weibo.js';
import { parse as parsePipixia } from '../_lib/parsers/pipixia.js';
import { parse as parsePipigx } from '../_lib/parsers/pipigx.js';
import { parse as parseZuiyou } from '../_lib/parsers/zuiyou.js';
import { parse as parseWyy } from '../_lib/parsers/wyy.js';

const PARSERS = {
  bilibili: parseBilibili,
  toutiao: parseToutiao,
  douyin: parseDouyin,
  kuaishou: parseKuaishou,
  xiaohongshu: parseXiaohongshu,
  weibo: parseWeibo,
  pipixia: parsePipixia,
  pipigx: parsePipigx,
  zuiyou: parseZuiyou,
  wyy: parseWyy,
};

/* ============================ 解析（/api/parse） ============================ */

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
};

function jsonOut(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

/** GET /api 端点列表 */
function endpointList() {
  return jsonOut({
    name: 'short-makers',
    endpoints: {
      parse: '/api/parse?url=<视频链接>',
      proxy: '/api/proxy?proxyurl=<媒体直链>&type=douyin|weibo&download=true|false&mediatype=video|image',
    },
    note: '已移植平台 bilibili；其余平台识别后返回 code:-2 待移植提示',
  });
}

/** 聚合解析：识别平台 -> 转发到对应解析器 */
async function handleParse(context) {
  const request = context.request;
  const url = new URL(request.url);
  const target = (url.searchParams.get('url') || '').trim();

  if (!target) {
    return jsonOut({ code: 201, msg: '链接不能为空！' });
  }

  // 平台识别（移植 sv.php 的关键词匹配）
  const platform = detectPlatform(target);
  if (!platform) {
    return jsonOut({
      code: -1,
      msg: '不支持的平台或无法识别的链接',
      supported: PLATFORMS.map((p) => p.key),
    });
  }

  // 未移植的平台：明确告知，不假装解析
  if (!IMPLEMENTED.has(platform)) {
    return jsonOut({
      code: -2,
      msg: `平台「${platform}」的解析器尚未移植到 EdgeOne Makers`,
      platform,
      todo: '该平台 PHP 解析器见 Theadvocate-bit/short_videos，需移植到 cloud-functions/_lib/parsers/',
    });
  }

  const parser = PARSERS[platform];
  if (!parser) {
    return jsonOut({ code: -2, msg: `平台「${platform}」解析器加载失败` }, 500);
  }

  // 解析器可用的环境：BILIBILI_COOKIE 等平台 cookie + 本部署的防盗链代理基地址
  // （douyin/weibo 等解析出的媒体直链需经 /api/proxy 过防盗链，解析器据此拼代理 URL）
  const env = {
    ...(context.env || {}),
    PROXY_BASE: `${url.protocol}//${url.host}/api/proxy?proxyurl=`,
  };

  try {
    return await parser(target, env);
  } catch (err) {
    const timeout = err?.name === 'AbortError' || err?.name === 'TimeoutError';
    return jsonOut(
      {
        code: 0,
        msg: timeout ? '上游超时' : '解析出错',
        detail: String(err?.message || err),
      },
      timeout ? 504 : 500,
    );
  }
}

/* ============================ 代理（/api/proxy） ============================ */

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

/** 媒体拉取与 HEAD 探测的超时（毫秒，每跳独立计时） */
const REQUEST_TIMEOUT = 30000;
const PROBE_TIMEOUT = 15000;
/** 302 手动跟随的最大跳数 */
const MAX_REDIRECTS = 10;

/**
 * 可选目标域白名单（后缀匹配）。留空数组 = 不限制（保持开放代理行为）。
 * 公开部署建议填写，防止被当作任意资源代理滥用，例如：
 * ['douyinvod.com', 'douyinpic.com', 'snssdk.com', 'weibo.com', 'sinaimg.cn']
 */
const ALLOWED_HOST_SUFFIXES = [];

/** 平台预设：防盗链 Referer 与下载文件名前缀 */
const PLATFORM_PRESETS = {
  douyin: { referer: 'https://douyin.com/', label: 'douyin' },
  weibo: { referer: 'https://weibo.com/', label: 'weibo' },
};

/** 媒体预设：Accept、默认 Content-Type、下载附加头、缓存策略 */
const MEDIA_PRESETS = {
  video: {
    accept: 'video/mp4,video/x-m4v,video/*;q=0.9,*/*;q=0.8',
    fallbackType: 'application/octet-stream',
    cache: null,
    downloadExtra: {
      'Content-Transfer-Encoding': 'binary',
      Expires: '0',
      'Cache-Control': 'must-revalidate',
      Pragma: 'public',
    },
  },
  image: {
    accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    fallbackType: 'image/jpeg',
    cache: 'public, max-age=86400',
    downloadExtra: {},
  },
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function proxyJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * 解码 proxyurl 参数：明文 http(s) 直接用；否则按 Base64 解码（空格还原为 +）。
 */
function decodeProxyUrl(raw) {
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  const normalized = raw.replace(/\s/g, '+');
  try {
    const bytes = Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** SHA-256 截断摘要，用于生成下载文件名 */
async function hashFilename(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 16);
}

/** 白名单校验：空配置放行；否则按后缀匹配目标域名 */
function isHostAllowed(targetUrl) {
  if (!ALLOWED_HOST_SUFFIXES.length) {
    return true;
  }
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    return ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith('.' + suffix));
  } catch {
    return false;
  }
}

/** 单次带超时的 fetch */
async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 统一媒体代理核心：校验 URL -> 手动跟随 302（每跳保持 Referer）-> 流式转发
 * @returns {Promise<{status:number, data:ReadableStream|object, headers?:object}>}
 */
async function proxyMedia(targetUrl, platformKey, mediaKey, download) {
  const platform = PLATFORM_PRESETS[platformKey];
  const media = MEDIA_PRESETS[mediaKey];

  try {
    new URL(targetUrl);
  } catch {
    return { status: 400, data: { code: 400, msg: '无效的媒体URL' } };
  }
  if (!isHostAllowed(targetUrl)) {
    return { status: 403, data: { code: 403, msg: '目标域名不在白名单内' } };
  }

  const requestHeaders = {
    'User-Agent': DESKTOP_UA,
    Accept: media.accept,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Connection: 'keep-alive',
    Referer: platform.referer,
  };

  try {
    let current = targetUrl;
    let response = await fetchWithTimeout(
      current,
      { method: 'GET', headers: requestHeaders, redirect: 'manual' },
      REQUEST_TIMEOUT,
    );

    // 手动跟随 302：跨跳重写 Referer 与 UA（follow 模式跨域会丢失 Referer，防盗链必须手动跟）
    let redirects = 0;
    while (response.status >= 300 && response.status < 400 && redirects < MAX_REDIRECTS) {
      const location = response.headers.get('location');
      if (!location) {
        break;
      }
      await response.body?.cancel().catch(() => {});
      current = new URL(location, current).href;
      response = await fetchWithTimeout(
        current,
        { method: 'GET', headers: requestHeaders, redirect: 'manual' },
        REQUEST_TIMEOUT,
      );
      redirects++;
    }

    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      let msg = `请求失败，HTTP状态码: ${response.status}`;
      if (response.status === 403) {
        msg += '（可能需要更新Cookie或Referer头信息）';
      }
      return { status: response.status, data: { code: response.status, msg } };
    }

    const contentType = response.headers.get('content-type') || media.fallbackType;
    const ext = mediaKey === 'image' ? (contentType.split('/')[1] || 'jpg').split(';')[0] : 'mp4';

    const responseHeaders = {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'X-Proxy': `${platform.label}-${mediaKey}-proxy`,
      ...(media.cache ? { 'Cache-Control': media.cache } : {}),
    };

    if (download !== 'false') {
      const filename = `${platform.label}_${mediaKey}_${await hashFilename(targetUrl)}.${ext}`;
      responseHeaders['Content-Disposition'] = `attachment; filename="${filename}"`;
      Object.assign(responseHeaders, media.downloadExtra);
    }

    // 流式转发上游 body，不落盘、不受内存限制
    return { status: 200, data: response.body, headers: responseHeaders };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? '请求超时' : err?.message || '未知错误';
    return { status: 500, data: { code: 500, msg: '请求失败', error: reason } };
  }
}

/**
 * HEAD 探测上游 Content-Type，自动区分视频/图片；探测失败默认按视频处理
 */
async function getMediaType(url, platformKey) {
  const headers = {
    'User-Agent': DESKTOP_UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Connection: 'keep-alive',
    Referer: PLATFORM_PRESETS[platformKey].referer,
  };
  try {
    const response = await fetchWithTimeout(url, { method: 'HEAD', headers, redirect: 'follow' }, PROBE_TIMEOUT);
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.startsWith('image/') || contentType.includes('image') || contentType.includes('picture')) {
      return 'image';
    }
    return 'video';
  } catch (err) {
    console.error('获取媒体类型失败:', err?.message);
    return 'video';
  }
}

/** 媒体防盗链代理入口 */
async function handleProxy(context) {
  const request = context.request;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'GET') {
    return proxyJson({ code: 405, msg: '仅支持 GET 请求' }, 405);
  }

  const urlObj = new URL(request.url);
  const proxyurl = (urlObj.searchParams.get('proxyurl') || '').trim();
  if (!proxyurl) {
    return proxyJson({ code: 400, msg: 'proxyurl参数不能为空' }, 400);
  }

  // type=douyin|weibo（默认 douyin），download=true|false（默认 true 触发下载）
  const platformKey = urlObj.searchParams.get('type') === 'weibo' ? 'weibo' : 'douyin';
  const download = urlObj.searchParams.get('download') || 'true';

  const decodedUrl = decodeProxyUrl(proxyurl);
  if (!decodedUrl) {
    return proxyJson({ code: 400, msg: 'URL解码失败', original_url: proxyurl }, 400);
  }

  // mediatype 未指定时自动探测上游媒体类型
  let mediaKey = urlObj.searchParams.get('mediatype');
  if (mediaKey !== 'image' && mediaKey !== 'video') {
    mediaKey = await getMediaType(decodedUrl, platformKey);
  }

  const result = await proxyMedia(decodedUrl, platformKey, mediaKey, download);

  // 代理过程失败：返回 JSON 错误
  if (result.data && typeof result.data === 'object' && result.data.code) {
    return proxyJson(result.data, result.status);
  }

  // 成功：流式转发媒体内容
  return new Response(result.data, {
    status: result.status,
    headers: { ...CORS_HEADERS, ...result.headers },
  });
}

/* ============================ 统一入口 ============================ */

/** EdgeOne Makers 入口：按子路径分发到 parse / proxy */
export async function onRequest(context) {
  const request = context.request;

  // CORS 预检统一处理
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...JSON_HEADERS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' },
    });
  }
  if (request.method !== 'GET') {
    return jsonOut({ code: 405, msg: '仅支持 GET 请求' }, 405);
  }

  const { pathname } = new URL(request.url);
  if (pathname === '/api') {
    return endpointList();
  }

  // 去掉开头 /api，得到子路径（'/parse' / '/proxy'）
  const sub = pathname.startsWith('/api/') ? pathname.slice('/api'.length) : pathname;

  if (sub === '/parse' || sub.startsWith('/parse/')) {
    return handleParse(context);
  }
  if (sub === '/proxy' || sub.startsWith('/proxy/')) {
    return handleProxy(context);
  }

  return jsonOut(
    {
      code: 404,
      msg: `未知端点：${pathname}`,
      endpoints: ['/api/parse', '/api/proxy', '/api'],
    },
    404,
  );
}
