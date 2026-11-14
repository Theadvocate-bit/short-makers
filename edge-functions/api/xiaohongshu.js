
// 边缘运行时不支持 AbortSignal.timeout，用受支持的 AbortController 实现超时
function abortSignalTimeout(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/1/19 下午8:58
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: 小红书解析统一接口（整合图文、视频、实况解析）
 * @Source: 由 api/xiaohongshu/xhsjx.php + api/xiaohongshu/XiaohongshuParser.php 合并移植（逻辑原样保留）
 * @Remark: 已由 PHP 版移植为 EdgeOne Makers 边缘函数版
 */

// ---------- PHP 语义辅助函数 ----------

// PHP isset()：键存在且值不为 null
function phpIsset(v) {
  return v !== undefined && v !== null;
}

// PHP is_numeric()（针对字符串）
function phpIsNumeric(v) {
  if (typeof v === "number") return true;
  if (typeof v !== "string") return false;
  return /^\s*[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v);
}

// PHP urldecode()：+ 转空格，%XX 解码；非法序列原样保留
function phpUrlDecode(s) {
  if (s == null) return "";
  s = String(s).replace(/\+/g, " ");
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s.replace(/%([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  }
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

// ---------- XiaohongshuParser.php 移植 ----------

class XiaohongshuParser {
  constructor() {
    this.userAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0";
    this.headers = [
      "User-Agent: " + this.userAgent,
      "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    ];
    this.cookie = "";
  }

  /**
   * 统一输出函数（PHP 返回 json_encode 字符串，JS 版直接返回最终 JSON 对象）
   */
  output(code, msg, data = []) {
    return { code: code, msg: msg, data: data };
  }

  /**
   * 设置Cookie
   */
  setCookie(cookie) {
    this.cookie = cookie;
  }

  headersListToObject(list) {
    const h = {};
    for (const line of list) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        h[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    if (this.cookie) {
      h["Cookie"] = this.cookie;
    }
    return h;
  }

  /**
   * 发送HTTP请求（PHP: curl + FOLLOWLOCATION + gzip 自动解压）
   */
  async request(url, customHeaders = [], returnHeader = false) {
    const headerList = [...this.headers, ...customHeaders];
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: abortSignalTimeout(10000),
        headers: this.headersListToObject(headerList),
      });
      if (returnHeader) {
        // PHP: CURLOPT_HEADER + CURLOPT_NOBODY，仅返回头信息字符串
        let headerText = "";
        res.headers.forEach((v, k) => {
          headerText += k + ": " + v + "\r\n";
        });
        return headerText;
      }
      return await res.text();
    } catch (e) {
      return false;
    }
  }

  /**
   * 获取重定向后的真实链接
   * 方案一对应 PHP get_headers（跟随 302 收集各跳 Location），方案二对应 cURL 兜底
   */
  async getRealUrl(url) {
    // 方案一：优先收集跳转 Location（某些 cURL 无法处理的 302 场景）
    const locations = [];
    let current = url;
    try {
      for (let i = 0; i < 10; i++) {
        const res = await fetch(current, {
          method: "GET",
          redirect: "manual",
          headers: { "User-Agent": this.userAgent },
          signal: abortSignalTimeout(10000),
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
      // 抑制错误（对应 PHP @get_headers 域名无法解析时不报错）
    }

    if (locations.length > 0) {
      // 优先寻找包含 item/note/explore 等 ID 特征的链接
      for (const loc of locations) {
        if (this.extractId(loc)) {
          return loc;
        }
      }
      // 如果没找到特征链接，返回第一个
      return locations[0];
    }

    // 方案二：如果 get_headers 失败，尝试 cURL 作为备选（取最终有效 URL）
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": this.userAgent },
        signal: abortSignalTimeout(10000),
      });
      return res.url || url;
    } catch (e) {
      return url;
    }
  }

  /**
   * 提取ID
   */
  extractId(url) {
    const patterns = [
      /discovery\/item\/([a-zA-Z0-9]+)/,
      /explore\/([a-zA-Z0-9]+)/,
      /item\/([a-zA-Z0-9]+)/,
      /note\/([a-zA-Z0-9]+)/,
    ];
    for (const pattern of patterns) {
      const m = url.match(pattern);
      if (m) {
        return m[1];
      }
    }
    return null;
  }

  /**
   * 主解析方法
   */
  async parse(url) {
    if (!url) {
      return this.output(400, "请输入小红书链接");
    }

    // 预处理：将 xhs.com 替换为 xhslink.com
    // 某些情况下分享链接可能是 xhs.com，直接访问可能无法正确跳转，需转换为 xhslink.com
    url = url.replaceAll("xhs.com", "xhslink.com");

    // 处理链接逻辑：参考 xhsjx.php
    const parsed = phpParseUrl(url);
    const domain = parsed ? (phpIsset(parsed.host) ? parsed.host : null) : null;
    let id;
    if (domain === "www.xiaohongshu.com") {
      id = this.extractId(url);
    } else {
      // 如果不是主域名，则认为是短链接或需要重定向的链接
      url = await this.getRealUrl(url);
      id = this.extractId(url);
    }

    if (!id) {
      // 尝试从 query 参数中再次查找 (某些情况下 URL 结构可能不同)
      // 比如 ?business_id=xxx
      return this.output(400, "链接格式错误，无法提取ID。处理后的链接: " + url);
    }

    // 第一次请求，尝试获取页面内容或token
    const response = await this.request(url);
    if (!response) {
      return this.output(500, "请求失败");
    }

    // 尝试直接匹配JSON
    let data = this.extractJson(response, id);
    // 如果 data 为空，尝试使用备用 UA 重试
    if (!data) {
      const backupUserAgent =
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36 EdgA/143.0.0.0";

      // 备份原有 headers
      const originalHeaders = this.headers;

      // 构造新 headers (替换 UA)
      const newHeaders = [];
      let uaReplaced = false;
      for (const header of originalHeaders) {
        if (header.toLowerCase().startsWith("user-agent:")) {
          newHeaders.push("User-Agent: " + backupUserAgent);
          uaReplaced = true;
        } else {
          newHeaders.push(header);
        }
      }
      if (!uaReplaced) {
        newHeaders.push("User-Agent: " + backupUserAgent);
      }

      this.headers = newHeaders;

      // 重新请求
      const retryResponse = await this.request(url);
      if (retryResponse) {
        data = this.extractJson(retryResponse, id);
      }
      // 恢复 headers
      this.headers = originalHeaders;
    }
    // 如果直接匹配失败，尝试xhslive.php中的高级策略（获取token后请求API）
    if (!data) {
      let token = "";
      let m = response.match(/token=(.*?)&/);
      if (m) {
        token = m[1];
      } else {
        m = response.match(/"xsec_token":\s*"([^"]+)"/);
        if (m) {
          token = m[1];
        }
      }

      if (token) {
        const apiUrl = `https://www.xiaohongshu.com/discovery/item/${id}?app_platform=android&ignoreEngage=true&app_version=8.69.5&share_from_user_hidden=true&xsec_source=app_share&type=video&xsec_token=${token}`;
        const apiResponse = await this.request(apiUrl);
        if (apiResponse) {
          data = this.extractJson(apiResponse, id);
        }
      }
    }
    if (data) {
      return this.output(200, "解析成功", data);
    }

    return this.output(404, "解析失败，未找到有效内容");
  }

  /**
   * 从HTML中提取并解析JSON
   */
  extractJson(html, id) {
    // PHP: /<script>\s*window.__INITIAL_STATE__\s*=\s*({[\s\S]*?})<\/script>/is
    const matches = html.match(
      /<script>\s*window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})<\/script>/is
    );
    if (matches) {
      let jsonStr = matches[1];
      jsonStr = jsonStr.replaceAll("undefined", "null");
      let json;
      try {
        json = JSON.parse(jsonStr);
      } catch (e) {
        return null;
      }
      if (!json) return null;
      // 尝试获取笔记详情
      // 路径1: note -> noteDetailMap -> id -> note
      let note = json?.note?.noteDetailMap?.[id]?.note ?? null;

      // 路径2: noteData -> data -> noteData
      if (!note) {
        note = json?.noteData?.data?.noteData ?? null;
      }
      if (note) {
        return this.formatNoteData(note);
      }
    }
    return null;
  }

  /**
   * 处理图片链接，去除水印
   */
  processImageUrl(url) {
    if (!url) {
      return "";
    }

    // 处理多个URL粘在一起的情况（用 "3http" 分隔）
    if (/3http/.test(url) && !/^http/.test(url)) {
      const urls = url.split(/(?=3http)/);
      const processed = [];
      for (let u of urls) {
        if (/^http/.test(u)) {
          u = u.replace(/^3http/, "http");
        }
        processed.push(this.processImageUrl(u));
      }
      return processed.join("");
    }

    // 1. 优先处理 /oss-sg/notes_pre_post/ 或 /oss-sg/spectrum/ 等带oss-sg路径的结构
    let m = url.match(/\/oss-sg\/([a-zA-Z0-9_]+)\/([a-zA-Z0-9]+)!/);
    if (m) {
      const dir = m[1];
      if (!/^[a-f0-9]{32}$/.test(dir) && !phpIsNumeric(dir)) {
        return (
          "https://sns-img-hw.xhscdn.com/oss-sg/" + dir + "/" + m[2] + "?imageView2/2/w/0/format/jpg"
        );
      }
    }

    // 2. 处理 notes_pre_post 和 spectrum 等通用匹配
    m = url.match(/\/([a-zA-Z0-9_]+)\/([a-zA-Z0-9]+)!/);
    if (m) {
      const dir = m[1];
      if (!/^[a-f0-9]{32}$/.test(dir) && !phpIsNumeric(dir)) {
        return "https://sns-img-hw.xhscdn.com/" + dir + "/" + m[2] + "?imageView2/2/w/0/format/jpg";
      }
    }

    // 针对不带 ! 的短链接 (如 http://sns-img-bd.xhscdn.com/notes_pre_post/xxx)
    m = url.match(/(notes_pre_post|spectrum|notes_uhdr)\/([a-zA-Z0-9]+)/);
    if (m) {
      return "https://sns-img-hw.xhscdn.com/" + m[1] + "/" + m[2] + "?imageView2/2/w/0/format/jpg";
    }

    // 3. 处理其他带 ! 的图片链接 (如实况图)
    m = url.match(/\/([a-zA-Z0-9]+)!/);
    if (m) {
      return "https://ci.xiaohongshu.com/" + m[1] + "?imageView2/2/w/0/format/jpg";
    }

    return url;
  }

  /**
   * 格式化笔记数据
   */
  formatNoteData(note) {
    let type = note.type ?? "unknown";
    // 标准化类型: normal -> image
    if (type === "normal") {
      type = "image";
    }

    // 提取封面URL
    let coverUrl = "";

    // 对于视频类型，优先从 imageList 获取（视频的封面在 imageList 中）
    if (note.imageList && note.imageList.length > 0) {
      const firstImage = note.imageList[0];
      // 优先使用 urlPre 或 urlDefault（视频类型 url 字段通常为空）
      coverUrl = firstImage?.urlPre ?? firstImage?.urlDefault ?? firstImage?.url ?? "";
    }

    // 如果仍未获取到，尝试从 video.image.thumbnailFileid 获取
    if (!coverUrl && type == "video" && note?.video?.image?.thumbnailFileid) {
      const thumbnailFileid = note.video.image.thumbnailFileid;
      coverUrl = "https://sns-img-hw.xhscdn.com/" + thumbnailFileid;
    }

    // 如果仍未获取到，尝试从 cover 字段获取
    if (!coverUrl && note?.cover?.url) {
      coverUrl = note.cover.url;
    }

    // 如果有 cover.fileId，手动拼接
    if (!coverUrl && note?.cover?.fileId) {
      coverUrl = "https://sns-img-hw.xhscdn.com/" + note.cover.fileId + "?imageView2/2/w/0/format/jpg";
    }

    const result = {
      type: type, // video, image, live
      title: note.title ?? "",
      desc: note.desc ?? "",
      author: {
        name: note?.user?.nickname ?? note?.user?.nickName ?? "",
        id: note?.user?.userId ?? "",
        avatar: note?.user?.avatar ?? "",
      },
      cover: this.processImageUrl(coverUrl),
      url: null,
      images: [],
      live_photo: [], // 实况图
    };

    // 处理视频
    if (result.type == "video") {
      let videoUrl = null;
      let videoBackup = null;

      // 提取所有可用的视频流
      const streams = [];

      // 优先收集 h265 (通常无水印且画质更好)
      if (Array.isArray(note?.video?.media?.stream?.h265)) {
        for (const stream of note.video.media.stream.h265) {
          streams.push({ ...stream, _codec: "h265" });
        }
      }

      // 其次收集 h264
      if (Array.isArray(note?.video?.media?.stream?.h264)) {
        for (const stream of note.video.media.stream.h264) {
          streams.push({ ...stream, _codec: "h264" });
        }
      }

      // 如果有可用流，按画质排序
      if (streams.length > 0) {
        // 按平均码率降序排序，但优先保留 h265
        streams.sort((a, b) => {
          // 1. 优先 h265
          const codecA = a._codec ?? "";
          const codecB = b._codec ?? "";
          if (codecA !== codecB) {
            if (codecA === "h265") return -1;
            if (codecB === "h265") return 1;
          }

          // 2. 其次按码率
          const bitrateA = a.avgBitrate ?? a.videoBitrate ?? 0;
          const bitrateB = b.avgBitrate ?? b.videoBitrate ?? 0;
          return bitrateB - bitrateA;
        });

        // 取最高画质为主链接
        videoUrl = streams[0]?.masterUrl ?? null;

        // 取第二高画质为备用链接 (如果存在)
        if (streams.length > 1) {
          videoBackup = streams[1]?.masterUrl ?? null;
        }
      }

      // 兜底逻辑：如果上面的流都没获取到
      if (!videoUrl && note?.video?.consumer?.originVideoKey) {
        videoUrl = "http://sns-video-bd.xhscdn.com/" + note.video.consumer.originVideoKey;
      }

      result.url = videoUrl;
      result.video_backup = videoBackup; // 新增备用链接字段
    }

    // 处理图片和实况
    if (note.imageList && note.imageList.length > 0) {
      for (const img of note.imageList) {
        let imageUrl = null;
        if (img?.url) {
          imageUrl = img.url;
        } else if (img?.urlDefault) {
          imageUrl = img.urlDefault;
        } else if (img?.urlPre) {
          imageUrl = img.urlPre;
        }

        if (imageUrl) {
          result.images.push(this.processImageUrl(imageUrl));
        }

        // 实况图 (Live Photo)
        // 实况图通常在 imageList 的 item 中有 stream 字段 (h264等)
        // 或者有 livePhoto: true 标志
        let liveVideoUrl = null;
        if (img?.stream?.h264?.[0]?.masterUrl) {
          liveVideoUrl = img.stream.h264[0].masterUrl;
        } else if (img?.stream?.h265?.[0]?.masterUrl) {
          liveVideoUrl = img.stream.h265[0].masterUrl;
        }

        if (liveVideoUrl) {
          result.live_photo.push({
            image: this.processImageUrl(imageUrl ?? ""),
            video: liveVideoUrl,
          });
        }
      }

      // 如果提取到了实况视频，修正类型为实况
      if (result.live_photo.length > 0) {
        result.type = "live";
      }
    }

    return result;
  }
}

// ---------- xhsjx.php 入口逻辑移植 ----------

// parse 返回最终 JSON 对象（与原 PHP echo $parser->parse($url) 的 JSON 结构一致）
export async function parse(shareUrl, env) {
  const parser = new XiaohongshuParser();
  // 配置Cookie
  parser.setCookie("");
  return await parser.parse(shareUrl ?? null);
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

  // 对应 PHP 入口的自定义取参逻辑：
  // GET 时从 REQUEST_URI 中截取第一个 "url=" 之后的部分并 urldecode（含后续参数，与 PHP 行为一致）
  let url = null;
  if (request.method === "GET") {
    const fullUrl = request.url;
    const urlParamPos = fullUrl.indexOf("url=");
    if (urlParamPos !== -1) {
      url = phpUrlDecode(fullUrl.slice(urlParamPos + 4));
    }
  } else {
    // POST: $_POST['url']
    try {
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const body = await request.json();
        url = (body && body.url) || null;
      } else {
        const form = await request.formData();
        url = form.get("url") || null;
      }
    } catch (e) {
      url = null;
    }
  }

  if (!url && new URL(request.url).searchParams.has("url")) {
    url = new URL(request.url).searchParams.get("url");
  }

  try {
    return jsonResponse(await parse(url ?? null, context.env));
  } catch (e) {
    return jsonResponse({ code: 500, msg: "解析失败: " + (e && e.message ? e.message : "未知错误"), data: [] });
  }
}
