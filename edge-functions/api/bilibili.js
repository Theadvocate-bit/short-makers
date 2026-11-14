/**
 * @Author: JH-Ahua
 * @CreateTime: 2025/12/29 下午6:52
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: bilibili解析（旧版 bilibili.php + 新版 BilibiliParser.php/index.php 双版本合并）
 * @Source: 由 api/bilibili/bilibili.php(旧版) + api/bilibili/BilibiliParser.php + api/bilibili/index.php(新版) 合并移植（逻辑原样保留）
 * @Remark: 已由 PHP 版移植为 EdgeOne Makers 边缘函数版
 * @Fix: view 接口（x/web-interface/view）在边缘节点出口 IP 上易被 412 风控，
 *       取数链路改为 pagelist→playurl（x/player/pagelist → x/player/playurl），无需任何 Cookie；
 *       标题/封面/作者改从视频页 __INITIAL_STATE__/meta 标签兜底提取，失败时优雅降级为 null
 * @Usage: 默认走新版（index.php/BilibiliParser 逻辑）；请求加 ?ver=old 时走旧版（bilibili.php 逻辑，含分P error 结构）
 */

// ---------- PHP 语义辅助函数 ----------

// PHP isset()：键存在且值不为 null
function phpIsset(v) {
  return v !== undefined && v !== null;
}

// PHP rawurldecode()
function rawurldecode(s) {
  if (s == null) return "";
  try {
    return decodeURIComponent(String(s));
  } catch (e) {
    return String(s).replace(/%([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  }
}

// PHP parse_url() 的近似实现（scheme/user/pass/host/port/path/query/fragment）
// 无 scheme 且不以 // 开头时整体视为 path（与 PHP 行为一致，host 为空）
function phpParseUrl(url) {
  if (url == null) return null;
  url = String(url);
  const result = {};
  let rest = url;

  const schemeMatch = rest.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
  if (schemeMatch) {
    result.scheme = schemeMatch[1];
    rest = rest.slice(schemeMatch[0].length);
  }

  const fragIdx = rest.indexOf("#");
  if (fragIdx !== -1) {
    result.fragment = rest.slice(fragIdx + 1);
    rest = rest.slice(0, fragIdx);
  }
  const queryIdx = rest.indexOf("?");
  if (queryIdx !== -1) {
    result.query = rest.slice(queryIdx + 1);
    rest = rest.slice(0, queryIdx);
  }

  if (rest.startsWith("//")) {
    let authority = rest.slice(2);
    let path = "";
    const segMatch = authority.match(/^[^\/?#]*/);
    const hostPart = segMatch ? segMatch[0] : authority;
    path = authority.slice(hostPart.length);

    let hostport = hostPart;
    const atIdx = hostPart.lastIndexOf("@");
    if (atIdx !== -1) {
      const userinfo = hostPart.slice(0, atIdx);
      const colonIdx = userinfo.indexOf(":");
      if (colonIdx !== -1) {
        result.user = userinfo.slice(0, colonIdx);
        result.pass = userinfo.slice(colonIdx + 1);
      } else {
        result.user = userinfo;
      }
      hostport = hostPart.slice(atIdx + 1);
    }
    const hpMatch = hostport.match(/^(\[[^\]]*\]|[^:]+)(?::(\d+))?$/);
    if (hpMatch) {
      result.host = hpMatch[1];
      if (hpMatch[2] !== undefined) result.port = hpMatch[2];
    } else if (hostport !== "") {
      return null;
    }
    result.path = path;
  } else {
    result.path = rest;
  }
  return result;
}

// PHP gmdate('H:i:s', ts)：按 UTC 格式化时间戳（可超过 24 小时，也可处理负时间戳）
function gmdateHIS(totalSeconds) {
  let sec = Number(totalSeconds);
  if (Number.isNaN(sec)) sec = -1; // PHP 非法字符串参与算术按 0 处理
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds());
}

function headersListToObject(list) {
  const h = {};
  for (const line of list) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      h[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return h;
}

/**
 * PHP get_headers($url, true) 的移植：跟随 302 跳转收集各跳 Location（可能为数组）
 * 返回 Location 数组；无跳转或失败时返回空数组
 */
async function phpGetHeadersLocations(url) {
  const locations = [];
  let current = url;
  try {
    for (let i = 0; i < 10; i++) {
      const res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: timeoutSignal(30000),
      });
      const loc = res.headers.get("location");
      if (!loc) break;
      let abs;
      try {
        abs = new URL(loc, current).href;
      } catch (e) {
        abs = loc;
      }
      locations.push(abs);
      current = abs;
    }
  } catch (e) {
    // 抑制错误，返回已收集到的跳转
  }
  return locations;
}

/**
 * 对应两版共用的 cleanUrlParameters()：分解URL结构并重建（去掉query、解码路径、去末尾斜杠）
 */
function cleanUrlParameters(url) {
  // Step 1: 分解URL结构
  const parsed = phpParseUrl(url) || {};

  // Step 2: 构建基础组件（自动解码编码字符）
  const scheme = phpIsset(parsed.scheme) ? parsed.scheme + "://" : "";
  let host = phpIsset(parsed.host) ? parsed.host : "";
  const port = phpIsset(parsed.port) ? ":" + parsed.port : "";
  let path = phpIsset(parsed.path) ? rawurldecode(parsed.path) : "";
  const fragment = phpIsset(parsed.fragment) ? "#" + rawurldecode(parsed.fragment) : "";

  // Step 3: 处理国际化域名（Punycode转中文）
  // 注：边缘环境无 intl 扩展等价函数，对应 PHP function_exists('idn_to_utf8') 检查不通过时跳过

  // Step 4: 移除认证信息（如 user:pass@）
  host = host.replace(/^.*@/, "");

  // 去掉路径末尾的斜杠
  path = path.replace(/\/+$/, "");

  // Step 5: 拼接最终URL
  return scheme + host + port + path + fragment;
}

// ---------- 视频页 meta 提取（配合 pagelist→playurl 链路补齐标题/封面/作者） ----------

// HTML 实体解码（meta content 常见实体）
function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// 顺序无关地匹配 <meta> 标签中的 content（keys 为 property/itemprop/name 候选）
function metaContent(html, keys) {
  const tags = html.match(/<meta\s+[^>]*>/gi) || [];
  for (const tag of tags) {
    for (const key of keys) {
      const re = new RegExp("(?:property|itemprop|name)\\s*=\\s*[\"']" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\"']", "i");
      if (re.test(tag)) {
        const cm = tag.match(/content\s*=\s*["']([^"']*)["']/i);
        if (cm) return decodeHtmlEntities(cm[1]);
      }
    }
  }
  return null;
}

// 从页面 HTML 中提取 window.__INITIAL_STATE__（花括号平衡 + 字符串感知，避免非贪婪正则截断）
function extractInitialState(html) {
  const marker = "window.__INITIAL_STATE__=";
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return null;
  let i = markerIdx + marker.length;
  while (i < html.length && html[i] !== "{") {
    if (html[i] === ";" || html[i] === "<") return null;
    i++;
  }
  const objStart = i;
  let depth = 0, inStr = false, quote = "", esc = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) inStr = false;
    } else if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(objStart, i + 1));
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 视频页兜底元数据：抓取 https://www.bilibili.com/video/{bvid} 页面，
 * 优先 __INITIAL_STATE__.videoData，失败再用 og/itemprop meta 标签兜底。
 * 原 view 接口（x/web-interface/view）在边缘节点出口 IP 上存在 412 风控，
 * 标题/封面/作者改由此处提供；全部失败时返回 null（输出字段优雅降级为 null）。
 */
async function fetchVideoMetaFromPage(bvid) {
  const html = await getFinalHtmlContent("https://www.bilibili.com/video/" + bvid, 30, 10);
  if (!html) return null;

  // 1) __INITIAL_STATE__ 提取
  const state = extractInitialState(html);
  const vd = state && phpIsset(state.videoData) ? state.videoData : null;
  if (vd) {
    return {
      title: phpIsset(vd.title) ? vd.title : null,
      pic: phpIsset(vd.pic) ? vd.pic : null,
      desc: phpIsset(vd.desc) ? vd.desc : null,
      owner: {
        name: phpIsset(vd?.owner?.name) ? vd.owner.name : null,
        face: phpIsset(vd?.owner?.face) ? vd.owner.face : null,
      },
    };
  }

  // 2) meta 标签兜底
  const title =
    metaContent(html, ["og:title", "twitter:title", "name"]) ||
    (html.match(/<h1[^>]*title[^>]*>([^<]+)<\/h1>/i) ? html.match(/<h1[^>]*title[^>]*>([^<]+)<\/h1>/i)[1].trim() : null);
  const pic = metaContent(html, ["og:image", "twitter:image", "image"]);
  const desc = metaContent(html, ["og:description", "twitter:description", "description"]);
  const author = metaContent(html, ["author"]) || metaContent(html, ["og:site_name"]);
  if (title == null && pic == null) return null;
  return {
    title: title,
    pic: pic,
    desc: desc,
    owner: {
      name: author,
      face: null,
    },
  };
}

/**
 * 对应旧版 bilibili() 请求函数（PHP curl，不跟随重定向）
 */
async function biliRequest(url, header, user_agent, cookie) {
  const h = headersListToObject(header);
  h["User-Agent"] = user_agent;
  if (cookie) h["Cookie"] = cookie;
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: timeoutSignal(30000),
      headers: h,
    });
    return await res.text();
  } catch (e) {
    return null;
  }
}

/**
 * 获取网页代码，自动跟随重定向直到最终页面（旧版 getFinalHtmlContent）
 * @param {string} url 目标网页URL
 * @param {number} timeout 超时时间（秒），默认30秒
 * @param {number} maxRedirects 最大重定向次数，默认10次
 * @return {string|false} 成功返回HTML代码，失败返回false
 */
async function getFinalHtmlContent(url, timeout = 30, maxRedirects = 10) {
  // 验证URL格式（对应 filter_var FILTER_VALIDATE_URL）
  try {
    new URL(url);
  } catch (e) {
    return false;
  }

  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", // 模拟浏览器UA
      },
      signal: timeoutSignal(timeout * 1000),
    });
    return await res.text();
  } catch (e) {
    return false;
  }
}

/**
 * 从B站视频页面的meta标签中提取BV号（旧版 extractBilibiliBVId）
 * @return {string|null} 提取到的BV号，匹配失败返回null
 */
function extractBilibiliBVId(html) {
  // 空值检查（PHP 原版此处会 echo 提示文本，为保证 JSON 输出纯净而省略）
  if (!html) {
    return null;
  }

  // 正则表达式匹配规则：
  // 1. 匹配包含 itemprop="url" 的meta标签
  // 2. 捕获 content 属性中 https://www.bilibili.com/video/ 后的BV号
  // 3. BV号格式：以BV开头，后跟10位字母/数字组合（B站BV号固定12位：BV + 10位字符）
  const pattern =
    /<meta\s+[^>]*itemprop="url"\s+[^>]*content="https:\/\/www\.bilibili\.com\/video\/(BV[a-zA-Z0-9]{10})\/?"[^>]*>/i;

  // 执行正则匹配
  const matchResult = html.match(pattern);
  if (matchResult && matchResult[1]) {
    return matchResult[1]; // 返回提取到的BV号
  }
  return null;
}

// ---------- 旧版入口（api/bilibili/bilibili.php）移植 ----------

// 旧版：bilibili解析（含分P error 结构；仅单分P时按 PHP 原版 quirks 不输出 videos 字段）
export async function parseLegacy(shareUrl, env) {
  // 这里填写你的B站cookie(不填解析不到1080P以上) 格式为_uuid=XXXXX
  const cookie = "";
  const headers = ["Content-type: application/json;charset=UTF-8", "Referer: https://www.bilibili.com/"];
  const useragent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.81 Safari/537.36";

  let urls = shareUrl == null ? "" : String(shareUrl);
  if (!urls) {
    return { code: 201, msg: "链接不能为空！" };
  }

  urls = cleanUrlParameters(urls);
  let array = phpParseUrl(urls);
  if (!array || Object.keys(array).length === 0) {
    return { code: -1, msg: "视频链接不正确" };
  }

  let bvid;
  const host = phpIsset(array.host) ? array.host : null;
  if (host === "b23.tv") {
    // 对应 get_headers($urls, true)，处理可能返回数组的Location头
    const locations = await phpGetHeadersLocations(urls);
    let redirectUrl = null;
    if (locations.length > 0) {
      redirectUrl = locations[locations.length - 1];
    }
    const arr2 = redirectUrl != null ? phpParseUrl(redirectUrl) : null;
    bvid = arr2 && phpIsset(arr2.path) ? arr2.path.replace(/\/+$/, "") : "";
  } else if (host === "www.bilibili.com" || host === "m.bilibili.com") {
    bvid = phpIsset(array.path) ? array.path : "";
  } else {
    return { code: -1, msg: "视频链接好像不太对！" };
  }

  if (bvid == null || !bvid.includes("/video/")) {
    return { code: -1, msg: "好像不是视频链接" };
  }

  bvid = bvid.replaceAll("/video/", "");
  // 规范化：去掉末尾斜杠（pagelist/playurl 对 bvid 参数更严格）
  bvid = bvid.replace(/\/+$/, "");
  if (!bvid.startsWith("BV")) {
    const bilibilihtml = await getFinalHtmlContent(urls);
    bvid = extractBilibiliBVId(bilibilihtml);
  }
  if (bvid == null || bvid === "") {
    return { code: 404, msg: "获取id失败" };
  }

  // 获取解析需要的cid值（原 view 接口 x/web-interface/view 在边缘节点出口 IP 上存在 412 风控，
  // 改用 pagelist→playurl 链路，无需任何 Cookie）
  const json1 = await biliRequest(
    "https://api.bilibili.com/x/player/pagelist?bvid=" + bvid,
    headers,
    useragent,
    cookie
  );
  let array2 = null;
  try {
    array2 = JSON.parse(json1);
  } catch (e) {
    array2 = null;
  }

  if (array2 != null && String(array2.code) === "0") {
    // 标题/封面/作者/简介改从视频页兜底提取（view 接口已弃用）；提取失败时优雅降级为 null
    const meta = await fetchVideoMetaFromPage(bvid);
    const title = phpIsset(meta?.title)
      ? meta.title
      : (Array.isArray(array2?.data) && array2.data.length > 0 && phpIsset(array2.data[0]?.part) ? array2.data[0].part : null);
    const cover = phpIsset(meta?.pic) ? meta.pic : null;
    const desc = phpIsset(meta?.desc) ? meta.desc : null;
    const owner = phpIsset(meta?.owner) ? meta.owner : null;

    const videos = [];
    let realVideoUrl = null;
    let lastIndex = null;

    // 循环获取所有分P的视频信息（pagelist 的 data 即分P数组）
    const pages = Array.isArray(array2?.data) ? array2.data : null;
    if (Array.isArray(pages)) {
      for (let index = 0; index < pages.length; index++) {
        const page = pages[index] ?? {};
        // 请求视频直链API
        const apiUrl =
          "https://api.bilibili.com/x/player/playurl?otype=json&fnver=0&fnval=3&player=3&qn=112&bvid=" +
          bvid +
          "&cid=" +
          (phpIsset(page.cid) ? page.cid : "") +
          "&platform=html5&high_quality=1";
        const jsonResponse = await biliRequest(apiUrl, headers, useragent, cookie);

        // 解析API返回的JSON数据
        let videoInfo = null;
        try {
          videoInfo = JSON.parse(jsonResponse);
        } catch (e) {
          videoInfo = null;
        }

        // 检查API响应是否正常
        if (videoInfo != null && phpIsset(videoInfo?.data?.durl?.[0]?.url)) {
          const videoUrl = videoInfo.data.durl[0].url;

          // 提取真实视频地址（去除镜像前缀）
          realVideoUrl = String(videoUrl).replace(
            /^https?:\/\/[^\/]+\//,
            "https://upos-sz-mirrorhw.bilivideo.com/"
          );

          videos.push({
            title: phpIsset(page.part) ? page.part : null,
            duration: phpIsset(page.duration) ? page.duration : null,
            durationFormat: gmdateHIS((phpIsset(page.duration) ? page.duration : null) - 1),
            url: realVideoUrl,
            index: index + 1,
          });
        } else {
          // 记录获取失败的分P
          videos.push({
            title: phpIsset(page.part) ? page.part : null,
            error: "无法获取视频链接",
            index: index + 1,
          });
        }
        lastIndex = index;
      }
    }

    let JSONOut;
    if (lastIndex !== null && lastIndex > 0) {
      // 构建最终返回的JSON数据
      JSONOut = {
        code: 200,
        msg: "解析成功！",
        data: {
          title: title,
          cover: cover,
          description: desc,
          url: realVideoUrl ?? null,
          user: {
            name: owner?.name ?? null,
            avatar: owner?.face ?? null,
          },
          videos: videos,
          totalVideos: videos.length,
        },
      };
    } else {
      JSONOut = {
        code: 200,
        msg: "解析成功！",
        data: {
          title: title,
          cover: cover,
          description: desc,
          url: realVideoUrl ?? null,
          user: {
            name: owner?.name ?? null,
            avatar: owner?.face ?? null,
          },
        },
      };
    }
    return JSONOut;
  } else {
    return { code: 0, msg: "解析失败！" };
  }
}

// ---------- 新版解析类（api/bilibili/BilibiliParser.php）移植 ----------

class BilibiliParser {
  constructor(cookie) {
    // Cookie must be provided by the caller
    this.cookie = cookie;
    this.userAgent =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.81 Safari/537.36";
  }

  /**
   * Main entry point to parse a URL
   * @param {string} url
   * @return {object} JSON response（PHP 版返回 json_encode 字符串，JS 版返回最终 JSON 对象）
   */
  async parse(url) {
    if (!url) {
      return { code: 201, msg: "链接不能为空！" };
    }

    url = cleanUrlParameters(url);
    const bvid = await this.extractBvid(url);

    if (!bvid) {
      return { code: -1, msg: "视频链接好像不太对！" };
    }

    // （对应原 PHP 中此处的空校验块，为空操作，保持一致）

    // Fetch pages via pagelist API（原 view 接口 x/web-interface/view 在边缘节点出口 IP 上存在 412 风控，
    // 改用 pagelist→playurl 链路，无需任何 Cookie）
    const pagelistApiUrl = "https://api.bilibili.com/x/player/pagelist?bvid=" + bvid;
    const jsonPagelist = await this.request(pagelistApiUrl);
    let pagelistData = null;
    try {
      pagelistData = JSON.parse(jsonPagelist);
    } catch (e) {
      pagelistData = null;
    }

    if (pagelistData != null && String(phpIsset(pagelistData.code) ? pagelistData.code : -1) === "0") {
      // 标题/封面/作者/简介改从视频页兜底提取（view 接口已弃用）；提取失败时优雅降级为 null
      const meta = await fetchVideoMetaFromPage(bvid);
      const pages = Array.isArray(pagelistData?.data) ? pagelistData.data : [];
      const bilijson = [];

      let index = 0;
      for (const page of pages) {
        const p = page ?? {};
        const cid = phpIsset(p.cid) ? p.cid : null;
        const playApiUrl =
          "https://api.bilibili.com/x/player/playurl?otype=json&fnver=0&fnval=3&player=3&qn=112&bvid=" +
          bvid +
          "&cid=" +
          (cid ?? "") +
          "&platform=html5&high_quality=1";

        const jsonPlay = await this.request(playApiUrl);
        let playData = null;
        try {
          playData = JSON.parse(jsonPlay);
        } catch (e) {
          playData = null;
        }

        let videoUrl = "";
        if (playData != null && phpIsset(playData?.data?.durl?.[0]?.url)) {
          const rawUrl = playData.data.durl[0].url;
          videoUrl = String(rawUrl).replace(
            /^https?:\/\/[^\/]+\//,
            "https://upos-sz-mirrorhw.bilivideo.com/"
          );
        }

        bilijson.push({
          title: phpIsset(p.part) ? p.part : null,
          duration: phpIsset(p.duration) ? p.duration : null,
          durationFormat: gmdateHIS((phpIsset(p.duration) ? p.duration : null) - 1),
          accept: playData?.data?.accept_description ?? [],
          url: videoUrl,
          index: index + 1,
        });
        index++;
      }

      const responseData = {
        code: 200,
        msg: "解析成功！",
        data: {
          title: phpIsset(meta?.title)
            ? meta.title
            : (pages.length > 0 && phpIsset(pages[0]?.part) ? pages[0].part : null),
          cover: phpIsset(meta?.pic) ? meta.pic : null,
          auther: phpIsset(meta?.owner?.name) ? meta.owner.name : null,
          avatar: phpIsset(meta?.owner?.face) ? meta.owner.face : null,
          description: phpIsset(meta?.desc) ? meta.desc : null,
          url: bilijson[0]?.url ?? "",
          user: {
            name: phpIsset(meta?.owner?.name) ? meta.owner.name : null,
            user_img: phpIsset(meta?.owner?.face) ? meta.owner.face : null,
          },
          videos: bilijson,
          totalVideos: bilijson.length,
        },
      };

      return responseData;
    } else {
      return { code: 0, msg: "解析失败！" };
    }
  }

  async extractBvid(url) {
    const array = phpParseUrl(url);
    if (!array || Object.keys(array).length === 0) return null;

    const host = phpIsset(array.host) ? array.host : "";
    const path = phpIsset(array.path) ? array.path : "";
    let bvid = "";

    if (host === "b23.tv") {
      // 对应 get_headers($url, true)，处理可能返回数组的Location头
      const locations = await phpGetHeadersLocations(url);
      const location = locations.length > 0 ? locations : "";
      const redirectUrl = Array.isArray(location) ? location[location.length - 1] : location;
      if (redirectUrl) {
        const arr2 = phpParseUrl(redirectUrl);
        bvid = (arr2 && phpIsset(arr2.path) ? arr2.path : "").replace(/\/+$/, "");
      }
    } else if (host === "www.bilibili.com" || host === "m.bilibili.com") {
      bvid = path;
    } else {
      // Invalid host
      return null;
    }

    // Check if it's a video link logic from original
    if (!bvid.includes("/video/")) {
      // If the path doesn't contain /video/, maybe it's not a valid video path for this parser
      // But let's handle the extraction first
      return null;
    }

    bvid = bvid.replaceAll("/video/", "");
    // 规范化：去掉末尾斜杠（pagelist/playurl 对 bvid 参数更严格）
    return bvid.replace(/\/+$/, "");
  }

  async request(url) {
    const header = {
      "Content-type": "application/json;charset=UTF-8",
      "Referer": "https://www.bilibili.com/",
    };
    if (this.cookie) header["Cookie"] = this.cookie;
    try {
      const res = await fetch(url, {
        redirect: "manual",
        signal: timeoutSignal(30000),
        headers: { ...header, "User-Agent": this.userAgent },
      });
      return await res.text();
    } catch (e) {
      return null;
    }
  }
}

// ---------- 新版入口（api/bilibili/index.php）移植：默认导出的 parse ----------

// cookie必填（不填解析不到1080P以上）→ 现已无需 Cookie：pagelist→playurl 链路免 Cookie 可用
export async function parse(shareUrl, env) {
  const cookie = "";
  // Initialize parser and output result
  const parser = new BilibiliParser(cookie);
  return await parser.parse(shareUrl == null ? "" : String(shareUrl));
}

const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type",
};

export function jsonResponse(data) {
  return new Response(JSON.stringify(data), { status: 200, headers: CORS_HEADERS });
}

export async function onRequest(context) {
  const request = context.request;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  let input = "";
  const u = new URL(request.url);
  input = u.searchParams.get("url") || "";
  if (!input && request.method === "POST") {
    try {
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const body = await request.json();
        input = (body && body.url) || "";
      } else {
        const form = await request.formData();
        input = form.get("url") || "";
      }
    } catch (e) {
      input = "";
    }
  }
  input = String(input).trim();
  if (!input) {
    // 与 PHP 两版入口一致：{code:201, msg:'链接不能为空！'}
    return jsonResponse({ code: 201, msg: "链接不能为空！" });
  }
  try {
    // ver=old / version=old 时走旧版 bilibili.php 逻辑，默认走新版 index.php 逻辑
    const version = (u.searchParams.get("ver") || u.searchParams.get("version") || "").toLowerCase();
    if (version === "old" || version === "legacy") {
      return jsonResponse(await parseLegacy(input, context.env));
    }
    return jsonResponse(await parse(input, context.env));
  } catch (e) {
    return jsonResponse({ code: 500, msg: "解析失败: " + (e && e.message ? e.message : "未知错误"), data: [] });
  }
}

// ---------- 兼容性辅助：边缘函数运行时不支持 AbortSignal.timeout() ----------
function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), Number(ms) || 0);
  return controller.signal;
}
