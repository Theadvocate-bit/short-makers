/**
 * short-makers · 抖音解析器（Node.js ES Module 移植）
 *
 * 移植自原项目 api/douyin/DouyinParser.php（免 Cookie 详情接口 + 原画直链）。
 * 逻辑：
 *   1. 从分享文本提取首个 http(s) 链接；
 *   2. 短链(v.douyin.com)/无 ID 链接用 redirect:'manual' 跟随 302 拿真实地址；
 *   3. 提取作品 aweme_id → 请求免 Cookie 详情接口 api.amemv.com/aweme/v1/aweme/detail/；
 *   4. 按 type(video/image/live) 选取媒体，原画 vid 走 302 解析；
 *   5. 视频/封面/头像/图集/音乐等有防盗链的直链一律用 env.PROXY_BASE + base64 包裹后返回。
 * Cookie：DOUYIN_COOKIE 环境变量（可选；详情接口本身免 Cookie，缺失则不带 Cookie 头）。
 * 只依赖边缘运行时标准 fetch，无第三方包；禁止动态 import。
 */

const DETAIL_ENDPOINT = 'https://api.amemv.com/aweme/v1/aweme/detail/';
const ORIGINAL_PLAY_ENDPOINT = 'https://aweme.snssdk.com/aweme/v1/play/';

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; 2210132C Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

const VID_RESOLVE_MAX_COUNT = 30;
const REQUEST_TIMEOUT_MS = 20000;

function jsonOut(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/** 统一输出（沿用原 PHP 的 code/msg/data 语义：非 200 且无 data 时 data 为 []） */
function output(code, msg, data) {
  const payload = data === undefined || data === null || (Array.isArray(data) && data.length === 0)
    ? (code === 200 ? {} : [])
    : data;
  return jsonOut({ code, msg, data: payload });
}

/** 空安全字符串转换 */
function strv(value) {
  if (typeof value === 'string') return value;
  return value === null || value === undefined ? '' : String(value);
}

/** http → https 统一，其余原样返回 */
function toHttps(url) {
  const s = strv(url);
  if (s === '') return '';
  return s.startsWith('http://') ? 'https://' + s.slice(7) : s;
}

/** 媒体直链防盗链代理：用 env.PROXY_BASE + base64 包裹（契约第 5 节） */
function makeProxied(env) {
  const base = (env && env.PROXY_BASE) || '';
  return function proxied(rawUrl) {
    const s = strv(rawUrl);
    if (s === '') return '';
    if (base === '') return s; // 未配置代理基地址时退回原直链
    // btoa 不接受非 ASCII，含非 ASCII 的 URL 先做 UTF-8 编码
    let b64;
    try {
      b64 = btoa(unescape(encodeURIComponent(s)));
    } catch {
      b64 = btoa(encodeURI(s));
    }
    return base + b64;
  };
}

/** 补齐视频直链 mime_type=video_mp4（抖音 CDN 约定参数，仅对 http(s) 视频地址生效） */
function ensureVideoMimeType(url) {
  const s = strv(url);
  if (s === '' || !/^http/i.test(s)) return s;

  const hashPos = s.indexOf('#');
  const base = hashPos === -1 ? s : s.slice(0, hashPos);
  const fragment = hashPos === -1 ? '' : s.slice(hashPos);

  const qPos = base.indexOf('?');
  if (qPos !== -1) {
    const query = base.slice(qPos + 1);
    if (query.split('&').some((kv) => kv.split('=')[0] === 'mime_type')) {
      return s;
    }
  }
  return base + (base.includes('?') ? '&' : '?') + 'mime_type=video_mp4' + fragment;
}

/** 从分享文本中提取首个 http(s) 链接，去掉行尾残留引号/标点 */
function extractShareUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
  if (!m) return null;
  return m[0].replace(/['"，。；,.;]+$/g, '');
}

/** 安全解析 URL（边缘运行时有 URL 全局；异常返回 null） */
function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * 提取作品 ID：先查常见查询参数(vid/id/modal_id/v/s/pid)，再取路径末段（去掉 .html）。
 * 与原 PHP extractAwemeId 一致。
 */
function extractAwemeId(url) {
  const u = parseUrl(url);
  if (!u) return null;
  if (!u.pathname && !u.search) return null;

  if (u.search) {
    for (const key of ['vid', 'id', 'modal_id', 'v', 's', 'pid']) {
      const val = u.searchParams.get(key);
      if (val) return val;
    }
  }

  const segments = u.pathname.split('/').filter(Boolean);
  if (!segments.length) return null;
  let last = segments[segments.length - 1];
  if (last.endsWith('.html')) last = last.slice(0, -5);
  return last !== '' ? last : null;
}

/** 判断是否抖音短链 / 非 www 主站域名（这类链接需要先跟随重定向） */
function needsRedirect(url) {
  const u = parseUrl(url);
  if (!u) return true;
  const host = u.hostname.toLowerCase();
  if (host === 'v.douyin.com') return true;
  if (!host.includes('douyin.com')) return true;
  return !extractAwemeId(url);
}

/** 单跳取 302 Location（redirect:'manual'，无重定向返回 null） */
async function fetchLocation(url) {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: { 'User-Agent': DESKTOP_UA },
  });
  return res.headers.get('location');
}

/** 相对地址转绝对 */
function absoluteUrl(current, location) {
  if (/^https?:\/\//i.test(location)) return location;
  try {
    return new URL(location, current).href;
  } catch {
    return location;
  }
}

/** 跟随重定向拿真实地址：最多 max 跳，命中含 aweme_id 的地址即返回（移植 resolveRedirect） */
async function resolveRedirect(url, max = 5) {
  let current = url;
  let last = url;
  for (let i = 0; i < max; i++) {
    let loc;
    try {
      loc = await fetchLocation(current);
    } catch {
      break;
    }
    if (!loc) break;
    loc = absoluteUrl(current, loc);
    last = loc;
    if (extractAwemeId(loc)) return loc;
    current = loc;
  }
  return last;
}

/** 传入视频 vid，拿 302 后的原画直链；任一环节失败则回退拼接的原画地址 */
async function resolveOriginalVideoUrl(vid, ratio = 'default') {
  if (!vid) return null;
  const fallbackUrl = ORIGINAL_PLAY_ENDPOINT + '?video_id=' + encodeURIComponent(String(vid)) + '&ratio=' + ratio + '&line=0';
  let current = fallbackUrl;
  let redirected = false;
  for (let i = 0; i < 3; i++) {
    let loc;
    try {
      loc = await fetchLocation(current);
    } catch {
      break;
    }
    if (!loc) break;
    current = absoluteUrl(current, loc);
    redirected = true;
  }
  return redirected ? current : fallbackUrl;
}

/** 批量转换 vid：去重 + 数量上限，并发请求（超出的 vid 由调用方回退拼接地址） */
async function resolveVidBatch(vidList) {
  const cache = {};
  const unique = [...new Set(vidList.filter(Boolean))].slice(0, VID_RESOLVE_MAX_COUNT);
  await Promise.all(unique.map(async (vid) => {
    cache[vid] = await resolveOriginalVideoUrl(vid);
  }));
  return cache;
}

/** 免 Cookie 详情接口：无签名、无游客 Cookie 依赖（移植 fetchDetail） */
async function fetchDetail(awemeId, cookie) {
  if (!/^[1-9][0-9]{15,19}$/.test(String(awemeId))) {
    return { ok: false, reason: '请输入作品 aweme_id，而不是合集 mix_id' };
  }

  const query = new URLSearchParams({
    aweme_id: String(awemeId),
    aid: '6383',
    device_platform: 'web',
    version_code: '190500',
    version_name: '19.5.0',
  });

  let raw;
  try {
    const res = await fetch(DETAIL_ENDPOINT + '?' + query.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': MOBILE_UA,
        Accept: 'application/json, text/plain, */*',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    raw = await res.text();
  } catch (err) {
    return { ok: false, reason: '详情请求失败', detail: String(err?.message || err) };
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: '详情接口返回非 JSON' };
  }
  if (!json || typeof json.status_code !== 'number' || !Number.isFinite(json.status_code)) {
    return { ok: false, reason: '详情接口缺少有效 status_code' };
  }
  if (json.status_code !== 0) {
    return { ok: false, reason: '详情接口 status_code=' + json.status_code };
  }

  const detail = json.aweme_detail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail) || Object.keys(detail).length === 0) {
    return { ok: false, reason: '详情接口未返回 aweme_detail（不能据此断言作品已删除）' };
  }
  if (strv(detail.aweme_id) !== String(awemeId)) {
    return { ok: false, reason: '详情接口返回的作品 ID 不匹配' };
  }
  return { ok: true, detail: json };
}

/** 从 video 信息提取 vid（优先 play_addr.uri，兼容 playAddr[0].uri 与 video.uri） */
function extractVidFromVideoInfo(videoInfo) {
  if (!videoInfo || typeof videoInfo !== 'object') return null;
  if (videoInfo.play_addr && typeof videoInfo.play_addr.uri !== 'undefined') {
    return String(videoInfo.play_addr.uri);
  }
  if (Array.isArray(videoInfo.playAddr) && videoInfo.playAddr[0] && typeof videoInfo.playAddr[0].uri !== 'undefined') {
    return String(videoInfo.playAddr[0].uri);
  }
  if (typeof videoInfo.uri === 'string' && videoInfo.uri !== '') return videoInfo.uri;
  return null;
}

/** v26-web 播放域名统一替换 */
function replacePlayHost(url) {
  return String(url).replace(/:\/\/([^/]+)/, '://v26-luna.douyinvod.com');
}

/** 从码率档位条目收集播放地址候选（playAddr[].src 与 play_addr.url_list 双风格兼容） */
function collectPlayUrlCandidates(rateItem) {
  const candidates = [];
  if (Array.isArray(rateItem.playAddr)) {
    for (const item of rateItem.playAddr) {
      if (item && typeof item.src === 'string' && item.src !== '') candidates.push(item.src);
    }
  }
  if (!candidates.length && Array.isArray(rateItem.play_addr?.url_list)) {
    for (const item of rateItem.play_addr.url_list) {
      if (typeof item === 'string' && item !== '') candidates.push(item);
    }
  }
  return candidates;
}

/** 提取最高画质视频：bitRateList/bit_rate 按 bitRate 降序，v3-web 优先，v26-web 换域名，其余进备用 */
function extractHighestQualityVideo(detail) {
  const video = detail.video && typeof detail.video === 'object' ? detail.video : {};
  let bitRateList = Array.isArray(video.bitRateList) && video.bitRateList.length
    ? video.bitRateList
    : (Array.isArray(video.bit_rate) && video.bit_rate.length ? video.bit_rate : null);

  let url = null;
  let gearName = '';
  const backup = [];

  if (bitRateList) {
    bitRateList = [...bitRateList].sort((a, b) => {
      const ba = a && typeof a === 'object' ? Number(a.bitRate ?? a.bit_rate ?? 0) : 0;
      const bb = b && typeof b === 'object' ? Number(b.bitRate ?? b.bit_rate ?? 0) : 0;
      return bb - ba;
    });

    for (const rateItem of bitRateList) {
      if (!rateItem || typeof rateItem !== 'object') continue;
      const candidates = collectPlayUrlCandidates(rateItem);
      if (!candidates.length) continue;

      let v3Link = null;
      let v26Link = null;
      for (const candidate of candidates) {
        if (candidate.includes('v3-web')) { v3Link = candidate; break; }
        if (v26Link === null && candidate.includes('v26-web')) v26Link = candidate;
      }

      const currentBestUrl = v3Link || (v26Link ? replacePlayHost(v26Link) : candidates[0]);

      if (!url) {
        url = currentBestUrl;
        gearName = strv(rateItem.gearName ?? rateItem.gear_name ?? '');
      }

      for (let candidate of candidates) {
        if (candidate.includes('v26-web')) candidate = replacePlayHost(candidate);
        if (candidate !== url && !backup.includes(candidate)) backup.push(candidate);
      }

      if (url && backup.length) break;
    }
  }

  // 码率列表缺失时的兜底：playApi → 原画拼接地址
  if (!url) {
    let uri = typeof video.uri === 'string' ? video.uri : '';
    if (uri === '' && video.play_addr && typeof video.play_addr.uri !== 'undefined') {
      uri = String(video.play_addr.uri);
    }

    let playApi = '';
    if (typeof video.playApi === 'string' && video.playApi !== '') {
      playApi = video.playApi;
    } else if (typeof video.play_addr?.url_list?.[0] === 'string') {
      playApi = video.play_addr.url_list[0];
    }

    if (playApi !== '') {
      url = playApi.replace(/playwm/g, 'play');
    } else if (uri !== '') {
      url = ORIGINAL_PLAY_ENDPOINT + '?video_id=' + encodeURIComponent(uri) + '&ratio=default&line=0';
    }

    const urlList = Array.isArray(video.play_addr?.url_list) ? video.play_addr.url_list : [];
    if (urlList.length > 1) {
      urlList.forEach((link, index) => {
        if (index === 0 || typeof link !== 'string' || link === '') return;
        const converted = link.replace(/playwm/g, 'play');
        if (converted && converted !== url && !backup.includes(converted)) backup.push(converted);
      });
    }
  }

  return { url, backup, gearName };
}

/** 提取封面：originCover → cover → detail.cover → dynamicCover → 图集首图 */
function pickCover(detail) {
  const video = detail.video && typeof detail.video === 'object' ? detail.video : null;

  if (video) {
    for (const [field, listField] of [['originCover', 'urlList'], ['origin_cover', 'url_list']]) {
      const list = video[field]?.[listField];
      if (Array.isArray(list) && typeof list[0] === 'string' && list[0] !== '') return list[0];
    }
    if (typeof video.originCover === 'string' && video.originCover !== '') return video.originCover;
    const originCoverUrlList = video.originCoverUrlList;
    if (Array.isArray(originCoverUrlList) && typeof originCoverUrlList[0] === 'string' && originCoverUrlList[0] !== '') {
      return originCoverUrlList[0];
    }
    if (video.cover && typeof video.cover === 'object') {
      const line = video.cover.urlList?.[0] ?? video.cover.url_list?.[0] ?? '';
      if (typeof line === 'string' && line !== '') return line;
    }
    if (typeof video.cover === 'string' && video.cover !== '') return video.cover;
  }

  const detailCoverList = detail.cover?.url_list;
  if (Array.isArray(detailCoverList) && typeof detailCoverList[0] === 'string' && detailCoverList[0] !== '') {
    return detailCoverList[0];
  }

  if (video) {
    for (const [field, listField] of [['dynamicCover', 'urlList'], ['dynamic_cover', 'url_list']]) {
      const list = video[field]?.[listField];
      if (Array.isArray(list) && typeof list[0] === 'string' && list[0] !== '') return list[0];
    }
  }

  let images = Array.isArray(detail.images) ? detail.images : [];
  if (!images.length && Array.isArray(detail.image_list)) images = detail.image_list;
  const first = images[0];
  const firstList = first?.url_list;
  if (first && typeof first === 'object' && Array.isArray(firstList) && typeof firstList[0] === 'string' && firstList[0] !== '') {
    return firstList[0];
  }

  return null;
}

/** 图集单图取 URL：urlList[0] → url_list[0] → url_list 末位兜底 */
function pickImageListItemUrl(img) {
  if (!img || typeof img !== 'object') return null;
  const urlList = img.urlList;
  if (Array.isArray(urlList) && typeof urlList[0] === 'string' && urlList[0] !== '') return toHttps(urlList[0]);
  const snakeList = img.url_list;
  if (Array.isArray(snakeList)) {
    if (typeof snakeList[0] === 'string' && snakeList[0] !== '') return toHttps(snakeList[0]);
    const last = snakeList[snakeList.length - 1];
    if (typeof last === 'string' && last !== '') return toHttps(last);
  }
  return null;
}

/** 提取实况视频地址：playAddr[] → play_addr.url_list → playApi（优先 v3-web，v26-web 换域名兜底） */
function extractLivePhotoVideoUrl(videoInfo) {
  if (!videoInfo || typeof videoInfo !== 'object') return null;
  let liveVideoUrl = null;
  let v26Candidate = null;

  const scan = (candidates) => {
    for (const c of candidates) {
      if (typeof c !== 'string' || c === '') continue;
      if (c.includes('v3-web')) { liveVideoUrl = c; return; }
      if (v26Candidate === null && c.includes('v26-web')) v26Candidate = c;
    }
  };

  if (Array.isArray(videoInfo.playAddr)) {
    scan(videoInfo.playAddr.map((a) => (a && typeof a === 'object' ? a.src : null)).filter(Boolean));
  }
  if (!liveVideoUrl && Array.isArray(videoInfo.play_addr?.url_list)) {
    scan(videoInfo.play_addr.url_list);
  }

  const pickFallback = (list) => {
    for (const idx of [1, 0]) {
      const c = list?.[idx];
      if (typeof c === 'string' && c !== '') { liveVideoUrl = c; return; }
    }
  };

  if (!liveVideoUrl && v26Candidate) liveVideoUrl = replacePlayHost(v26Candidate);
  if (!liveVideoUrl && Array.isArray(videoInfo.playAddr)) pickFallback(videoInfo.playAddr.map((a) => a?.src));
  if (!liveVideoUrl && Array.isArray(videoInfo.play_addr?.url_list)) pickFallback(videoInfo.play_addr.url_list);

  if (!liveVideoUrl && typeof videoInfo.playApi === 'string' && videoInfo.playApi !== '') {
    liveVideoUrl = videoInfo.playApi;
  }
  return liveVideoUrl;
}

/** 发布时间归一化：秒级直用，毫秒级(>=1e12)除一次 1000，非法/超范围归 0 */
function normalizeCreateTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  let ts = value;
  ts = ts >= 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
  if (ts < 1e9 || ts > 4102444800) return 0;
  return ts;
}

/** 固定东八区(UTC+8)格式化为 YYYY-MM-DD HH:mm:ss，未知返回空串 */
function formatPublishTime(createTime) {
  if (!createTime) return '';
  const d = new Date(createTime * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate())
    + ' ' + p(t.getUTCHours()) + ':' + p(t.getUTCMinutes()) + ':' + p(t.getUTCSeconds());
}

/** 1024 进制 B/KB/MB/GB/TB，最多两位小数且不保留尾部 0 */
function formatSizeLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return Math.round(value) + 'B';
  const label = value.toFixed(2).replace(/\.?0+$/, '');
  return label + units[unit];
}

/** 有界探测主视频真实字节大小：单次 HEAD，拿不到一律 0（边缘环境常被 CDN 拒绝，属预期） */
async function probeVideoSize(url) {
  if (!url) return 0;
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': DESKTOP_UA },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return 0;
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('video') && !contentType.includes('octet-stream')) return 0;
    const length = Number(res.headers.get('content-length') || 0);
    return length > 0 ? length : 0;
  } catch {
    return 0;
  }
}

/** 格式化 aweme_detail 为统一响应契约（对齐原 PHP formatData） */
async function formatData(detail, fallbackVideoId, env) {
  const proxied = makeProxied(env);

  const title = strv(detail.desc ?? '');
  const authorNode = detail.author && typeof detail.author === 'object' ? detail.author : {};
  const avatarList = Array.isArray(authorNode.avatar_thumb?.url_list) ? authorNode.avatar_thumb.url_list : [];

  const musicNode = detail.music && typeof detail.music === 'object' ? detail.music : {};
  const musicPlayList = Array.isArray(musicNode.play_url?.url_list) ? musicNode.play_url.url_list : [];
  const coverThumb = Array.isArray(musicNode.cover_thumb) ? musicNode.cover_thumb
    : (Array.isArray(musicNode.cover_thumb_medium) ? musicNode.cover_thumb_medium : []);
  const musicCoverList = Array.isArray(coverThumb?.url_list) ? coverThumb.url_list : [];
  const musicPlayUrl = musicPlayList[0] ?? '';
  const musicCoverUrl = musicCoverList[0] ?? '';

  // 契约要求秒：抖音原始 duration 为毫秒，>=1000 视为毫秒归一为秒
  let duration = typeof detail.video?.duration === 'number' ? detail.video.duration : null;
  if (duration !== null && duration >= 1000) duration = Math.round((duration / 1000) * 100) / 100;

  const createTime = normalizeCreateTime(Number(detail.create_time ?? detail.createTime ?? 0));

  const result = {
    type: 'unknown',
    title,
    desc: title,
    author: {
      name: strv(authorNode.nickname ?? ''),
      id: strv(authorNode.uid ?? authorNode.unique_id ?? authorNode.short_id ?? ''),
      avatar: proxied(toHttps(strv(avatarList[0] ?? ''))),
    },
    cover: '',
    url: null,
    quality: '',
    duration,
    size: 0,
    size_label: '',
    create_time: createTime,
    publish_time: formatPublishTime(createTime),
    video_backup: [],
    images: [],
    live_photo: [],
    music: {
      title: strv(musicNode.title ?? musicNode.music_name ?? ''),
      author: strv(musicNode.author ?? musicNode.owner_nickname ?? ''),
      url: proxied(toHttps(strv(musicPlayUrl))),
      cover: proxied(toHttps(strv(musicCoverUrl))),
    },
    extra: {},
  };

  let images = Array.isArray(detail.images) ? detail.images : [];
  if (!images.length && Array.isArray(detail.image_list)) images = detail.image_list;

  if (images.length) {
    result.type = 'image';
    const liveCandidates = [];

    for (const img of images) {
      if (!img || typeof img !== 'object') continue;
      const imgUrl = pickImageListItemUrl(img);
      if (imgUrl) result.images.push(proxied(imgUrl));

      const videoInfo = img.video && typeof img.video === 'object' ? img.video : {};
      let liveVideoUrl = extractLivePhotoVideoUrl(videoInfo);
      if (liveVideoUrl) liveVideoUrl = toHttps(String(liveVideoUrl).replace(/playwm/g, 'play'));
      if (imgUrl && liveVideoUrl) {
        liveCandidates.push({ image: imgUrl, fallbackUrl: liveVideoUrl, vid: extractVidFromVideoInfo(videoInfo) });
      }
    }

    // 多视频 vid 全部转 302 后的原画直链，拿不到的回退原地址
    const vidMap = await resolveVidBatch(liveCandidates.map((c) => c.vid));
    for (const item of liveCandidates) {
      const resolved = item.vid !== null && Object.prototype.hasOwnProperty.call(vidMap, item.vid) ? vidMap[item.vid] : null;
      result.live_photo.push({
        image: proxied(item.image),
        video: proxied(ensureVideoMimeType(resolved || item.fallbackUrl)),
      });
    }

    if (result.live_photo.length) result.type = 'live';
  } else {
    result.type = 'video';
    const videoInfo = extractHighestQualityVideo(detail);

    const playUri = extractVidFromVideoInfo(detail.video && typeof detail.video === 'object' ? detail.video : {});
    let main = videoInfo.url;
    if (main) main = toHttps(String(main).replace(/playwm/g, 'play'));

    // 原画优先：拿 vid 302 后的原画直链作为主地址；失败则回退原来的 main
    const resolvedOriginal = await resolveOriginalVideoUrl(playUri);
    if (resolvedOriginal) {
      if (main && main !== resolvedOriginal) videoInfo.backup.unshift(main);
      main = resolvedOriginal;
      result.quality = 'original';
    } else if (videoInfo.gearName !== '') {
      result.quality = videoInfo.gearName;
    }

    // 补齐 mime_type=video_mp4；主地址先归一，保证去重比较口径一致
    main = ensureVideoMimeType(main);

    const backups = [];
    for (const candidate of videoInfo.backup) {
      const converted = ensureVideoMimeType(toHttps(String(candidate).replace(/playwm/g, 'play')));
      if (converted && converted !== main && !backups.includes(converted)) backups.push(converted);
    }

    result.url = main ? proxied(main) : null;
    if (main) {
      result.size = await probeVideoSize(main);
      result.size_label = formatSizeLabel(result.size);
    }
    result.video_backup = backups.map(proxied);
    result.video_id = playUri || fallbackVideoId;
  }

  const cover = pickCover(detail);
  result.cover = cover ? proxied(toHttps(strv(cover))) : '';

  return output(200, '解析成功', result);
}

/**
 * 解析抖音视频/图集/实况
 * @param {string} url 用户提交的分享链接或文本
 * @param {object} env Makers 环境变量（含可选 PROXY_BASE / DOUYIN_COOKIE）
 */
export async function parse(url, env = {}) {
  const cookie = (env && env.DOUYIN_COOKIE) || '';

  if (!url || typeof url !== 'string') {
    return output(400, '请输入抖音链接');
  }

  const shareUrl = extractShareUrl(url);
  if (!shareUrl) {
    return output(400, '未在文本中识别到有效链接');
  }

  // 短链或无 ID 的链接先跟随重定向拿真实地址
  let target = shareUrl;
  if (needsRedirect(target)) {
    target = await resolveRedirect(target);
  }

  const awemeId = extractAwemeId(target);
  if (!awemeId) {
    return output(400, '链接格式错误，无法提取作品 ID');
  }

  const response = await fetchDetail(awemeId, cookie);
  if (!response.ok) {
    return output(500, response.reason);
  }

  return formatData(response.detail.aweme_detail, awemeId, env);
}
