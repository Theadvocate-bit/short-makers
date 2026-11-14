/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/1/18 下午4:53
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: 快手链接图片/视频信息提取工具
 * @Source: 由 api/kuaishou/ksjx.php + api/kuaishou/KuaishouSpider.php 合并移植（逻辑原样保留）
 * @Remark: 已由 PHP 版移植为 EdgeOne Makers 边缘函数版
 */

// 配置（对应 ksjx.php 中的 define('USER_AGENT', ...)）
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1 Edg/122.0.0.0";

// ---------- PHP 语义辅助函数 ----------

// PHP isset()：键存在且值不为 null
function phpIsset(v) {
  return v !== undefined && v !== null;
}

// PHP stripslashes()：仅去除 \0、\'、\"、\\ 前的反斜杠，其余转义序列原样保留
function phpStripslashes(str) {
  return str.replace(/\\(.)/g, (m, c) => {
    if (c === "0") return "\x00";
    if (c === "'" || c === '"' || c === "\\") return c;
    return m;
  });
}

// ---------- KuaishouSpider.php 移植 ----------

class KuaishouSpider {
  constructor(cookie, userAgent, timeout = 5000) {
    this.cookie = cookie;
    this.userAgent = userAgent;
    this.timeout = timeout;
  }

  /**
   * 主入口：解析URL
   */
  async analyze(url) {
    // 1. 获取重定向后的URL
    const redirectUrl = await this.getRedirectedUrl(url);
    if (!redirectUrl) {
      return { code: 400, msg: "无法获取有效链接" };
    }

    // 2. 获取页面内容
    const pageContent = await this.curlRequest(redirectUrl);
    if (pageContent === false) {
      return { code: 500, msg: "页面内容获取失败" };
    }

    // 3. 识别类型和ID
    const [contentType, contentId] = this.extractContentIdAndType(redirectUrl);
    if (!contentId) {
      return { code: 400, msg: "无法识别的链接类型" };
    }

    // 4. 尝试解析 (INIT_STATE 优先，其次 APOLLO_STATE)
    const result =
      (await this.extractFromInitState(pageContent)) ??
      (await this.extractFromApolloState(pageContent, contentId, contentType));

    return result ?? { code: 404, msg: "未找到有效媒体信息" };
  }

  /**
   * 解析 INIT_STATE
   */
  async extractFromInitState(pageContent) {
    // PHP: /window\.INIT_STATE\s*=\s*(.*?)<\/script>/s
    const matches = pageContent.match(/window\.INIT_STATE\s*=\s*([\s\S]*?)<\/script>/);
    if (!matches) {
      return null;
    }

    const jsonString = matches[1].trim().replace(/;+$/, "");

    let data;
    try {
      data = JSON.parse(jsonString);
    } catch (e) {
      // 解析失败时的容错处理（对应 PHP stripslashes + str_replace 兜底）
      let cleanedJsonString = phpStripslashes(jsonString);
      cleanedJsonString = cleanedJsonString
        .replaceAll('"{\\"err_msg\\":\\"launchApplication:fail\\"}"', '"err_msg","launchApplication:fail"')
        .replaceAll('"{\\"err_msg\\":\\"system:access_denied\\"}"', '"err_msg","system:access_denied"');
      try {
        data = JSON.parse(cleanedJsonString);
      } catch (e2) {
        return {
          code: 500,
          msg: "JSON解析错误: " + (e2 && e2.message ? e2.message : "Syntax error"),
        };
      }
    }

    // 过滤有效数据
    const filteredData = this.filterMediaData(data);
    if (Object.keys(filteredData).length === 0) {
      return null;
    }

    const firstItem = Object.values(filteredData)[0];
    const photo = phpIsset(firstItem.photo) ? firstItem.photo : {};

    // 提取公共音乐信息
    let musicInfo = {};
    const musicSource = phpIsset(photo.music) ? photo.music : phpIsset(photo.soundTrack) ? photo.soundTrack : [];
    if (musicSource && typeof musicSource === "object" && Object.keys(musicSource).length > 0) {
      musicInfo = {
        name: phpIsset(musicSource.name) ? musicSource.name : "",
        artist: phpIsset(musicSource.artist) ? musicSource.artist : "",
        cover:
          musicSource.imageUrls?.[0]?.url ?? musicSource.avatarUrls?.[0]?.url ?? "",
        url: musicSource.audioUrls?.[0]?.url ?? "",
      };
    }

    // 1. 尝试提取图片 (图集)
    const imageList = photo?.ext_params?.atlas?.list ?? [];
    if (imageList.length > 0) {
      return {
        code: 200,
        msg: "success",
        data: {
          type: "image",
          title: photo.caption ?? "",
          author: photo.userName ?? "",
          avatar: photo.headUrl ?? "",
          count: imageList.length,
          like: photo.likeCount ?? 0,
          time: photo.timestamp ?? 0,
          music: "http://txmov2.a.kwimgs.com" + (photo?.ext_params?.atlas?.music ?? ""),
          images: imageList.map((path) => "http://tx2.a.yximgs.com/" + path),
          api: 1,
        },
      };
    }

    // 2. 尝试提取单张图片
    if (
      (phpIsset(photo.photoType) && photo.photoType === "SINGLE_PICTURE") ||
      (phpIsset(photo.singlePicture) && photo.singlePicture === true)
    ) {
      const coverUrls = photo.coverUrls ?? [];
      let imageUrl = "";
      if (coverUrls.length > 0) {
        imageUrl = coverUrls[0]?.url ?? null;
      }

      if (imageUrl) {
        return {
          code: 200,
          msg: "解析成功",
          data: {
            type: "image",
            author: photo.userName ?? "",
            avatar: photo.headUrl ?? "",
            like: photo.likeCount ?? 0,
            time: photo.timestamp ?? 0,
            title: photo.caption ?? "",
            cover: imageUrl,
            url: imageUrl,
            images: [imageUrl],
            music: musicInfo,
          },
        };
      }
    }

    // 3. 尝试提取视频
    if (phpIsset(photo.mainMvUrls) || (phpIsset(photo.photoType) && photo.photoType === "VIDEO")) {
      let videoUrl = photo?.mainMvUrls?.[0]?.url ?? "";
      if (!videoUrl && phpIsset(photo?.manifest?.adaptationSet?.[0]?.representation?.[0]?.url)) {
        videoUrl = photo.manifest.adaptationSet[0].representation[0].url;
      }

      if (videoUrl) {
        return {
          code: 200,
          msg: "解析成功",
          data: {
            type: "video",
            author: photo.userName ?? "",
            avatar: photo.headUrl ?? "",
            like: photo.likeCount ?? 0,
            time: photo.timestamp ?? 0,
            title: photo.caption ?? "",
            cover: photo?.coverUrls?.[0]?.url ?? "",
            url: videoUrl,
            music: musicInfo,
          },
        };
      }
    }

    return null;
  }

  /**
   * 解析 APOLLO_STATE
   */
  async extractFromApolloState(pageContent, contentId, contentType) {
    // PHP: /window\.__APOLLO_STATE__\s*=\s*(.*?)<\/script>/s
    const matches = pageContent.match(/window\.__APOLLO_STATE__\s*=\s*([\s\S]*?)<\/script>/);
    if (!matches) {
      return null;
    }

    let cleanedData = matches[1].replace(/function\s*\([^)]*\)\s*{[^}]*}/g, ":");
    cleanedData = cleanedData.replace(/,\s*(?=}|])/g, "");
    cleanedData = cleanedData.replaceAll(";(:());", "");

    let apolloState;
    try {
      apolloState = JSON.parse(cleanedData);
    } catch (e) {
      return null;
    }

    const videoInfo = phpIsset(apolloState?.defaultClient) ? apolloState.defaultClient : null;
    if (!videoInfo) {
      return null;
    }

    const key = `VisionVideoDetailPhoto:${contentId}`;
    const videoData = phpIsset(videoInfo[key]) ? videoInfo[key] : null;
    if (!videoData) {
      return null;
    }

    let authorData = null;
    for (const k of Object.keys(videoInfo)) {
      if (k.startsWith("VisionVideoDetailAuthor:")) {
        authorData = videoInfo[k];
        break;
      }
    }

    let videoUrl = "";
    if (contentType === "long-video") {
      videoUrl =
        videoData?.manifestH265?.json?.adaptationSet?.[0]?.representation?.[0]?.backupUrl?.[0] ?? "";
    } else {
      videoUrl = videoData.photoUrl ?? "";
    }

    if (!videoUrl) {
      return null;
    }

    // 根据 contentType 确定资源类型
    let type = "video";
    if (contentType === "photo") {
      type = "image";
    }

    return {
      code: 200,
      msg: "解析成功",
      data: {
        type: type,
        author: authorData?.name ?? "",
        avatar: authorData?.headerUrl ?? "", // APOLLO STATE 可能字段不同，这里做个假设，或者暂时留空
        title: videoData.caption ?? "",
        cover: videoData.coverUrl ?? "",
        url: videoUrl,
        // APOLLO STATE 下其他字段可能需要进一步抓包确认，暂时保持基础信息
      },
    };
  }

  filterMediaData(data) {
    const filtered = {};
    if (!data || typeof data !== "object") {
      return filtered;
    }
    for (const key of Object.keys(data)) {
      const value = data[key];
      if (
        key.startsWith("tusjoh") &&
        value !== null &&
        typeof value === "object" &&
        (phpIsset(value.fid) || phpIsset(value.photo))
      ) {
        filtered[key] = value;
      }
    }
    return filtered;
  }

  // PHP: curl HEAD + FOLLOWLOCATION，取 CURLINFO_EFFECTIVE_URL
  async getRedirectedUrl(url) {
    try {
      const res = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        headers: { "User-Agent": this.userAgent },
        signal: timeoutSignal(this.timeout),
      });
      return res.url || null;
    } catch (e) {
      return null;
    }
  }

  // PHP: curl GET + FOLLOWLOCATION + AUTOREFERER
  async curlRequest(url) {
    const headers = {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Cache-Control": "no-cache",
      // 注：PHP 版还发送 "Connection: keep-alive"，该头为 fetch 禁用头，边缘环境自动省略
      Pragma: "no-cache",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      "sec-ch-ua": '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      Cookie: this.cookie,
    };

    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: timeoutSignal(this.timeout),
        headers: headers,
      });
      return await res.text();
    } catch (e) {
      return false;
    }
  }

  extractContentIdAndType(url) {
    const patterns = [
      ["short-video", /short-video\/([^?]+)/],
      ["long-video", /long-video\/([^?]+)/],
      ["photo", /photo\/([^?]+)/],
    ];
    for (const [type, pattern] of patterns) {
      const m = url.match(pattern);
      if (m) {
        return [type, m[1]];
      }
    }
    return ["", ""];
  }
}

// ---------- ksjx.php 入口逻辑移植 ----------

// parse 返回最终 JSON 对象（与原 PHP echo json_encode($result, JSON_OPTIONS) 结构一致）
export async function parse(shareUrl, env) {
  const url = shareUrl == null ? "" : String(shareUrl);

  if (!url) {
    return { code: 201, msg: "url为空" };
  }

  // 务必填cookie
  const spider = new KuaishouSpider("", USER_AGENT);
  const result = await spider.analyze(url);
  return result;
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
    // 与 PHP 版一致：{code:201, msg:'url为空'}
    return jsonResponse({ code: 201, msg: "url为空" });
  }
  try {
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
