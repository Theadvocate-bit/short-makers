/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/1/24 下午5:05
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: 抖音主页解析（原 dyzy，需登录 Cookie 调用 feed 接口）
 * @Remark: 已由 PHP 版移植为 EdgeOne Makers 边缘函数版（逻辑原样保留）
 * @Route: /api/douyin/home
 * @Env: DOUYIN_HOME_COOKIE - 抖音登录 Cookie（feed 接口请求头的 cookie 比较全）
 */
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CORS_HEADERS = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type",
};

function jsonResponse(data) {
    return new Response(JSON.stringify(data), {status: 200, headers: CORS_HEADERS});
}

function isset(obj, key) {
    return obj !== null && obj !== undefined && obj[key] !== undefined && obj[key] !== null;
}

// 安全取多级路径值（等价 PHP isset($a['b']['c'][0]) 链式判断）
function pick(obj) {
    let cur = obj;
    for (let i = 1; i < arguments.length; i++) {
        if (cur === null || cur === undefined || typeof cur !== "object") {
            return undefined;
        }
        cur = cur[arguments[i]];
        if (cur === undefined || cur === null) {
            return undefined;
        }
    }
    return cur;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== 纯 JS MD5（自实现，等价 PHP md5()） ====================

function md5Bytes(bytes) {
    const S = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K = new Array(64);
    for (let i = 0; i < 64; i++) {
        K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
    }
    const len = bytes.length;
    const totalLen = (((len + 8) >> 6) + 1) * 64;
    const buf = new Uint8Array(totalLen);
    buf.set(bytes);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    const bitLen = len * 8;
    dv.setUint32(totalLen - 8, bitLen >>> 0, true);
    dv.setUint32(totalLen - 4, Math.floor(bitLen / 4294967296), true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const M = new Array(16);
    for (let off = 0; off < totalLen; off += 64) {
        for (let j = 0; j < 16; j++) {
            M[j] = dv.getUint32(off + j * 4, true);
        }
        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i++) {
            let F, g;
            if (i < 16) {
                F = (B & C) | (~B & D);
                g = i;
            } else if (i < 32) {
                F = (D & B) | (~D & C);
                g = (5 * i + 1) % 16;
            } else if (i < 48) {
                F = B ^ C ^ D;
                g = (3 * i + 5) % 16;
            } else {
                F = C ^ (B | ~D);
                g = (7 * i) % 16;
            }
            F = (F + A + K[i] + M[g]) >>> 0;
            A = D;
            D = C;
            C = B;
            B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
        }
        a0 = (a0 + A) >>> 0;
        b0 = (b0 + B) >>> 0;
        c0 = (c0 + C) >>> 0;
        d0 = (d0 + D) >>> 0;
    }
    const out = new Uint8Array(16);
    const odv = new DataView(out.buffer);
    odv.setUint32(0, a0, true);
    odv.setUint32(4, b0, true);
    odv.setUint32(8, c0, true);
    odv.setUint32(12, d0, true);
    return out;
}

function bytesToHex(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
        s += bytes[i].toString(16).padStart(2, "0");
    }
    return s;
}

// 导出以便自测
export function md5Hex(str) {
    return bytesToHex(md5Bytes(new TextEncoder().encode(String(str))));
}

// ==================== 解析器主体 ====================

// 时间戳 → 'Y-m-d H:i:s'（等价 PHP date()，按运行时本地时区）
function formatDate(ts) {
    const d = new Date(Number(ts) * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return (
        d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
        " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
    );
}

// 生成 Web ID（等价 PHP 'verify_' . substr(md5(uniqid(mt_rand(), true)), 0, 16)）
function generateWebId() {
    const rnd = new Uint8Array(8);
    crypto.getRandomValues(rnd);
    let randHex = "";
    for (let i = 0; i < rnd.length; i++) {
        randHex += rnd[i].toString(16).padStart(2, "0");
    }
    return "verify_" + md5Hex(Date.now() + randHex + Math.random().toString()).slice(0, 16);
}

// 获取重定向 URL（等价 PHP curl FOLLOWLOCATION + CURLINFO_EFFECTIVE_URL）
async function getRedirectUrl(url) {
    try {
        const resp = await fetch(url, {
            method: "GET",
            redirect: "follow",
            headers: {"user-agent": USER_AGENT},
            signal: timeoutSignal(10000),
        });
        return resp.url || url;
    } catch (e) {
        return url;
    }
}

// 从分享链接提取 sec_uid
async function extractSecUid(shareLink) {
    // 处理抖音短链接
    const m = shareLink.match(/https?:\/\/v\.douyin\.com\/[a-zA-Z0-9]+\/?/);
    if (m) {
        const redirectUrl = await getRedirectUrl(m[0]);
        const um = redirectUrl.match(/user\/([^?\/]+)/);
        if (um) {
            return um[1];
        }
    }
    // 直接解析用户URL
    const um2 = shareLink.match(/user\/([^?\/]+)/);
    if (um2) {
        return um2[1];
    }
    return null;
}

// 构建请求头（accept-encoding 由 fetch 运行时自动处理，不再手动指定）
function buildHeaders(secUid, cookie) {
    return {
        authority: "www.douyin.com",
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "cache-control": "no-cache",
        pragma: "no-cache",
        referer: "https://www.douyin.com/user/" + secUid,
        "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent": USER_AGENT,
        cookie: cookie,
    };
}

// 构建 API 请求 URL（等价 PHP http_build_query）
function buildApiUrl(secUid, maxCursor, count) {
    const params = {
        device_platform: "webapp",
        aid: "6383",
        channel: "channel_pc_web",
        sec_user_id: secUid,
        max_cursor: maxCursor,
        count: count,
        publish_video_strategy_type: "2",
        pc_client_type: "1",
        version_code: "170400",
        version_name: "17.4.0",
        cookie_enabled: "true",
        screen_width: "1920",
        screen_height: "1080",
        browser_language: "zh-CN",
        browser_platform: "Win32",
        browser_name: "Chrome",
        browser_version: "120.0.0.0",
        browser_online: "true",
        engine_name: "Blink",
        engine_version: "120.0.0.0",
        os_name: "Windows",
        os_version: "10",
        cpu_core_num: "16",
        device_memory: "8",
        platform: "PC",
        downlink: "10",
        effective_type: "4g",
        round_trip_time: "50",
        webid: generateWebId(),
    };
    return "https://www.douyin.com/aweme/v1/web/aweme/post/?" + new URLSearchParams(params).toString();
}

// 发送 HTTP 请求（等价 PHP makeRequest）
async function makeRequest(url, headers) {
    try {
        const resp = await fetch(url, {
            method: "GET",
            headers: headers,
            redirect: "follow",
            signal: timeoutSignal(30000),
        });
        const data = await resp.text();
        return {success: true, http_code: resp.status, data: data};
    } catch (e) {
        return {success: false, error: e && e.message ? e.message : "request failed"};
    }
}

// 查找视频 URL
function findVideoUrl(aweme) {
    const playAddr = pick(aweme, "video", "play_addr", "url_list", 0);
    if (playAddr !== undefined) {
        return playAddr;
    }
    if (Array.isArray(pick(aweme, "video", "bit_rate"))) {
        for (const bitRate of aweme.video.bit_rate) {
            const u = pick(bitRate, "play_addr", "url_list", 0);
            if (u !== undefined) {
                return u;
            }
        }
    }
    return "";
}

// 补齐视频直链的 mime_type=video_mp4（抖音 CDN 约定参数）
function ensureVideoMimeType(url) {
    url = typeof url === "string" ? url : url === null ? "" : String(url);
    if (url === "" || !/^http/i.test(url)) {
        return url;
    }
    // fragment 不参与查询串判断，追加时要放在 fragment 之前
    const hashPos = url.indexOf("#");
    const base = hashPos === -1 ? url : url.slice(0, hashPos);
    const fragment = hashPos === -1 ? "" : url.slice(hashPos);
    const qPos = base.indexOf("?");
    if (qPos !== -1 && new URLSearchParams(base.slice(qPos + 1)).has("mime_type")) {
        return url;
    }
    return base + (base.indexOf("?") !== -1 ? "&" : "?") + "mime_type=video_mp4" + fragment;
}

// 解析作品数据
function parseAwemeItem(aweme, index) {
    const item = {
        index: index + 1,
        aweme_id: aweme.aweme_id !== undefined && aweme.aweme_id !== null ? aweme.aweme_id : "",
        desc: aweme.desc !== undefined && aweme.desc !== null ? aweme.desc : "",
        create_time: isset(aweme, "create_time") ? formatDate(aweme.create_time) : "",
        share_url: "https://www.douyin.com/video/" + (aweme.aweme_id !== undefined && aweme.aweme_id !== null ? aweme.aweme_id : ""),
    };

    // 作者信息
    if (isset(aweme, "author")) {
        item.author = aweme.author.nickname !== undefined && aweme.author.nickname !== null ? aweme.author.nickname : "";
        item.author_uid = aweme.author.uid !== undefined && aweme.author.uid !== null ? aweme.author.uid : "";
        item.author_sec_uid = aweme.author.sec_uid !== undefined && aweme.author.sec_uid !== null ? aweme.author.sec_uid : "";
    }

    // 类型判断
    const isImage = isset(aweme, "images") && Array.isArray(aweme.images) && aweme.images.length > 0;
    item.type = isImage ? "image" : "video";

    if (isImage) {
        // 图片处理
        item.images = [];
        for (const image of aweme.images) {
            const u = pick(image, "url_list", 0);
            if (u !== undefined) {
                item.images.push(u);
            }
        }
        item.cover = item.images.length > 0 ? item.images[0] : "";
    } else {
        // 视频处理
        const cover = pick(aweme, "video", "cover", "url_list", 0);
        if (cover !== undefined) {
            item.cover = cover;
        }
        item.url = ensureVideoMimeType(findVideoUrl(aweme));
        if (isset(aweme, "video") && isset(aweme.video, "duration")) {
            item.duration = aweme.video.duration / 1000;
        }
    }

    // 音乐信息
    if (isset(aweme, "music")) {
        item.music_title = aweme.music.title !== undefined && aweme.music.title !== null ? aweme.music.title : "";
        item.music_author = aweme.music.author !== undefined && aweme.music.author !== null ? aweme.music.author : "";
        const musicUrl = pick(aweme, "music", "play_url", "url_list", 0);
        if (musicUrl !== undefined) {
            item.music_url = musicUrl;
        }
    }

    // 统计数据
    if (isset(aweme, "statistics")) {
        const stats = aweme.statistics;
        item.statistics = {
            digg_count: stats.digg_count !== undefined && stats.digg_count !== null ? stats.digg_count : 0,
            comment_count: stats.comment_count !== undefined && stats.comment_count !== null ? stats.comment_count : 0,
            share_count: stats.share_count !== undefined && stats.share_count !== null ? stats.share_count : 0,
            collect_count: stats.collect_count !== undefined && stats.collect_count !== null ? stats.collect_count : 0,
            play_count: stats.play_count !== undefined && stats.play_count !== null ? stats.play_count : 0,
        };
    }

    // 标签信息
    if (isset(aweme, "text_extra") && Array.isArray(aweme.text_extra)) {
        item.hashtags = [];
        for (const tag of aweme.text_extra) {
            if (isset(tag, "hashtag_name")) {
                item.hashtags.push(tag.hashtag_name);
            }
        }
    }

    return item;
}

// 获取用户视频列表
async function fetchUserVideos(cookie, secUid, count) {
    const headers = buildHeaders(secUid, cookie);

    const allItems = [];
    let maxCursor = 0;
    let hasMore = true;
    let page = 0;
    let maxPages = Math.ceil(count / 18);

    // 限制最大页数以防止超时，可根据需要调整
    if (maxPages > 50) maxPages = 50;

    while (hasMore && allItems.length < count && page < maxPages) {
        page++;
        const pageCount = Math.min(18, count - allItems.length);
        const url = buildApiUrl(secUid, maxCursor, pageCount);

        const result = await makeRequest(url, headers);

        if (!result.success || result.http_code !== 200) {
            return {code: 500, msg: "请求失败: " + (result.error !== undefined ? result.error : "HTTP " + result.http_code)};
        }

        let data = null;
        try {
            data = JSON.parse(result.data);
        } catch (e) {
            data = null;
        }
        if (!data || !isset(data, "aweme_list") || !Array.isArray(data.aweme_list)) {
            // 如果第一次就失败，直接返回错误
            if (allItems.length === 0) {
                return {code: 500, msg: "数据解析失败"};
            }
            break; // 如果已经获取了一部分，就返回已获取的
        }

        if (isset(data, "status_code") && data.status_code !== 0) {
            if (allItems.length === 0) {
                return {code: 500, msg: "API错误: " + (isset(data, "status_msg") ? data.status_msg : "Unknown")};
            }
            break;
        }

        const items = data.aweme_list;
        for (const it of items) {
            allItems.push(it);
        }

        hasMore = isset(data, "has_more") && data.has_more == 1;
        if (hasMore && isset(data, "max_cursor")) {
            maxCursor = data.max_cursor;
            await sleep(500); // 避免请求过快（等价 PHP usleep(500000)）
        } else {
            break;
        }
    }

    const parsedItems = [];
    // 只返回请求的数量
    const sliced = allItems.slice(0, count);
    for (let index = 0; index < sliced.length; index++) {
        parsedItems.push(parseAwemeItem(sliced[index], index));
    }

    return {
        code: 200,
        msg: "success",
        data: parsedItems,
        pagination: {
            total: allItems.length,
            has_more: hasMore,
        },
    };
}

// 获取数据主入口
async function getData(cookie, url, id, count) {
    let secUid = "";

    if (url) {
        secUid = await extractSecUid(url);
    } else if (id) {
        secUid = id;
    }

    if (!secUid) {
        return {code: 400, msg: "请提供有效的链接(url)或ID(id)"};
    }

    return fetchUserVideos(cookie, secUid, count);
}

// 聚合入口：解析抖音主页作品列表，返回最终 JSON 对象（与 PHP 版输出结构一致）
// opts.id  - 用户 ID（sec_uid），对应原版 GET id 参数
// opts.count - 获取数量，默认 18，对应原版 GET count 参数
export async function parse(shareUrl, env, opts = {}) {
    // Cookie 不能硬编码，从环境变量读取
    const cookie = env && env.DOUYIN_HOME_COOKIE ? String(env.DOUYIN_HOME_COOKIE) : "";
    if (!cookie) {
        return {code: 500, msg: "未配置抖音 Cookie，请设置环境变量 DOUYIN_HOME_COOKIE", data: []};
    }

    let count = 18;
    if (opts.count !== undefined && opts.count !== null && opts.count !== "") {
        const n = parseInt(opts.count, 10);
        if (!isNaN(n) && n >= 0) {
            count = n;
        }
    }

    return getData(cookie, String(shareUrl || ""), opts.id !== undefined && opts.id !== null ? String(opts.id) : "", count);
}

export async function onRequest(context) {
    const request = context.request;
    if (request.method === "OPTIONS") {
        return new Response(null, {status: 204, headers: CORS_HEADERS});
    }

    let input = "";
    const u = new URL(request.url);
    input = u.searchParams.get("url") || "";
    const id = u.searchParams.get("id") || "";
    const count = u.searchParams.get("count") || "";
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

    try {
        // 原版：无 url/id 时由解析器返回 {code:400,...}（HTTP 200），不在此拦截
        const result = await parse(input, context.env, {id: id, count: count});
        return jsonResponse(result);
    } catch (e) {
        // 与 PHP 版 catch 结构一致：{code:500, msg:'error', error:...}
        return new Response(
            JSON.stringify({code: 500, msg: "error", error: e && e.message ? e.message : "未知错误"}),
            {status: 500, headers: CORS_HEADERS}
        );
    }
}

// ---------- 兼容性辅助：边缘函数运行时不支持 AbortSignal.timeout() ----------
function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), Number(ms) || 0);
  return controller.signal;
}
