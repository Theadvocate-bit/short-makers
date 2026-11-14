/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/4/30 17:27
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: 即梦ai视频去水印解析
 * @Remark: 已由 PHP 版移植为 EdgeOne Makers 边缘函数版（逻辑原样保留）
 */
const DEFAULT_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const API_URL = "https://jimeng.jianying.com/mweb/v1/get_item_info";

const CORS_HEADERS = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "cache-control": "no-cache, no-store, must-revalidate",
}

function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {status: status || 200, headers: CORS_HEADERS});
}

// 等价 PHP isset($a['k'])：键存在且值非 null
function issetv(v) {
    return v !== undefined && v !== null;
}

// 等价 PHP (int) 强制转换
function toInt(v) {
    if (typeof v === "boolean") return v ? 1 : 0;
    const n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
}

// 等价 PHP (float) 强制转换
function toFloat(v) {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
}

// 等价 PHP (bool) 强制转换（注意 PHP 中 (bool)'0' === false）
function toBool(v) {
    return v === "0" ? false : Boolean(v);
}

function output(code, msg, data = []) {
    return {code: code, msg: msg, data: data};
}

// 从文本中提取第一个 http(s) URL
function extractFirstUrl(text) {
    const m = text.match(/\bhttps?:\/\/[^\s'"<>]+/i);
    return m ? m[0] : null;
}

// 等价 PHP getLocation()：单次 30x 跳转读取 Location（不跟随）
async function getLocation(url) {
    try {
        const resp = await fetch(url, {
            method: "GET",
            redirect: "manual",
            headers: {
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
                "accept-language": "zh-CN,zh;q=0.9",
            },
            signal: timeoutSignal(15000),
        });
        const httpCode = resp.status;
        const location = resp.headers.get("location");
        const effectiveUrl = resp.url || "";
        if (httpCode === 301 || httpCode === 302) {
            if (location !== null && location !== "") {
                return location.trim() !== "" ? location : null;
            }
            if (effectiveUrl !== null && effectiveUrl !== "") {
                return effectiveUrl;
            }
        }
        return null;
    } catch (e) {
        return null;
    }
}

// 等价 PHP getItemId()：从 URL 提取 item_id / id 查询参数，或取路径最后一段纯数字
function getItemId(url) {
    let u;
    try {
        u = new URL(url);
    } catch (e) {
        return null;
    }

    const itemId = u.searchParams.get("item_id");
    if (itemId !== null && itemId !== "") {
        return String(itemId);
    }

    const id = u.searchParams.get("id");
    if (id !== null && id !== "") {
        return String(id);
    }

    const path = u.pathname.replace(/^\/+|\/+$/g, "");
    const parts = path.split("/").filter((p) => p !== "");
    if (parts.length > 0) {
        const last = parts[parts.length - 1];
        if (last !== "" && /^\d+$/.test(last)) {
            return last;
        }
    }

    return null;
}

// 等价 PHP extractItemIdFromUrl()：支持纯数字 ID、标准链接、/s/ 短链
async function extractItemIdFromUrl(text) {
    text = String(text === undefined || text === null ? "" : text).trim();
    if (text === "") {
        return null;
    }

    const url = extractFirstUrl(text);
    if (url === null) {
        if (/^\d{16,}$/.test(text)) {
            return text;
        }
        return null;
    }

    let itemId = getItemId(url);
    if (itemId === null || itemId === "") {
        if (url.indexOf("/s/") !== -1) {
            const resolved = await getLocation(url);
            if (resolved !== null) {
                itemId = getItemId(resolved);
            }
        }
    }

    return itemId;
}

// 请求即梦详情接口（等价 PHP fetchItemInfo）；state.hint 记录失败原因
async function fetchItemInfo(itemId, state) {
    try {
        const resp = await fetch(API_URL, {
            method: "POST",
            headers: {
                "user-agent": DEFAULT_UA,
                "content-type": "application/json",
            },
            body: JSON.stringify({published_item_id: itemId}),
            redirect: "follow",
            signal: timeoutSignal(30000),
        });

        if (resp.status >= 400) {
            state.hint = "HTTP " + resp.status;
            return null;
        }

        const text = await resp.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch (e) {
            json = null;
        }
        if (json === null || typeof json !== "object") {
            state.hint = "JSON解析失败";
            return null;
        }

        if (issetv(json.ret) && json.ret !== "0") {
            state.hint = issetv(json.errmsg) ? json.errmsg : "API错误";
            return null;
        }

        return json;
    } catch (e) {
        state.hint = "curl: " + (e && e.message ? e.message : "request failed");
        return null;
    }
}

// 构建输出数据（等价 PHP buildFormatData，字段与类型逐一对应）
function buildFormatData(detail) {
    const data = detail && typeof detail === "object" && issetv(detail.data) ? detail.data : {};
    const common = issetv(data.common_attr) && typeof data.common_attr === "object" ? data.common_attr : {};
    const author = issetv(data.author) && typeof data.author === "object" ? data.author : {};
    const video = issetv(data.video) && typeof data.video === "object" ? data.video : {};
    const statistic = issetv(data.statistic) && typeof data.statistic === "object" ? data.statistic : {};

    const title = issetv(common.description) ? String(common.description) : "";
    const itemId = issetv(common.published_item_id) ? String(common.published_item_id) : "";

    const authorOut = {
        name: issetv(author.name) ? String(author.name) : "",
        uid: issetv(author.uid) ? String(author.uid) : "",
        sec_uid: issetv(author.sec_uid) ? String(author.sec_uid) : "",
        avatar: issetv(author.avatar_url) ? String(author.avatar_url) : "",
        description: issetv(author.description) ? String(author.description) : "",
    };

    let coverUrl = "";
    const coverMap = issetv(common.cover_url_map) && typeof common.cover_url_map === "object" ? common.cover_url_map : null;
    if (coverMap !== null) {
        if (issetv(coverMap["1080"])) {
            coverUrl = String(coverMap["1080"]);
        } else if (issetv(coverMap["720"])) {
            coverUrl = String(coverMap["720"]);
        } else if (issetv(coverMap["original"])) {
            coverUrl = String(coverMap["original"]);
        } else {
            const first = Object.values(coverMap)[0]; // 等价 PHP reset($coverMap)
            if (first !== undefined) {
                coverUrl = String(first);
            }
        }
    }
    if (coverUrl === "" && issetv(common.cover_url)) {
        coverUrl = String(common.cover_url);
    }

    let videoUrl = "";
    let videoQuality = "";
    const videoBackup = [];
    let duration = 0;

    const originVideo = issetv(video.origin_video) && typeof video.origin_video === "object" ? video.origin_video : [];
    const transcoded = issetv(video.transcoded_video) && typeof video.transcoded_video === "object" ? video.transcoded_video : [];

    if (
        issetv(transcoded.origin) && typeof transcoded.origin === "object" &&
        issetv(transcoded.origin.video_url) && transcoded.origin.video_url !== ""
    ) {
        videoUrl = String(transcoded.origin.video_url);
        videoQuality = "origin";
    } else if (typeof originVideo === "object" && issetv(originVideo.video_url) && originVideo.video_url !== "") {
        videoUrl = String(originVideo.video_url);
        videoQuality = "origin";
    }

    if (typeof originVideo === "object" && issetv(originVideo.video_url) && originVideo.video_url !== "") {
        const originUrl = String(originVideo.video_url);
        if (originUrl !== videoUrl) {
            videoBackup.push({
                label: "origin_video",
                quality: "origin",
                url: originUrl,
                width: issetv(originVideo.width) ? toInt(originVideo.width) : 0,
                height: issetv(originVideo.height) ? toInt(originVideo.height) : 0,
                bit_rate: issetv(originVideo.br) ? toInt(originVideo.br) : 0,
                size: issetv(originVideo.size) ? toInt(originVideo.size) : 0,
                fps: issetv(originVideo.fps) ? toInt(originVideo.fps) : 0,
                definition: issetv(originVideo.definition) ? String(originVideo.definition) : "origin",
            });
        }
    }

    if (typeof transcoded === "object") {
        for (const quality of Object.keys(transcoded)) {
            const item = transcoded[quality];
            if (item === null || typeof item !== "object" || !issetv(item.video_url) || item.video_url === "") {
                continue;
            }
            const url = String(item.video_url);
            if (url === videoUrl) {
                continue;
            }
            videoBackup.push({
                label: quality,
                quality: quality,
                url: url,
                width: issetv(item.width) ? toInt(item.width) : 0,
                height: issetv(item.height) ? toInt(item.height) : 0,
                bit_rate: issetv(item.br) ? toInt(item.br) : issetv(item.bitrate) ? toInt(item.bitrate) : 0,
                size: issetv(item.size) ? toInt(item.size) : 0,
                fps: issetv(item.fps) ? toInt(item.fps) : 0,
                definition: issetv(item.definition) ? String(item.definition) : "",
            });
        }
    }

    if (issetv(video.duration_ms) && video.duration_ms > 0) {
        duration = toInt(video.duration_ms / 1000);
    } else if (issetv(video.duration) && video.duration > 0) {
        duration = toInt(video.duration);
    }

    const result = {
        type: "video",
        title: title,
        desc: title,
        author: authorOut,
        cover: coverUrl,
        url: videoUrl,
        quality: videoQuality,
        duration: duration,
        video_id: itemId,
        video_backup: videoBackup,
        images: [],
        extra: {
            item_id: itemId,
            create_time: issetv(common.create_time) ? toInt(common.create_time) : 0,
            update_time: issetv(common.update_time) ? toInt(common.update_time) : 0,
            status: issetv(common.status) ? toInt(common.status) : 0,
            aspect_ratio: issetv(common.aspect_ratio) ? toFloat(common.aspect_ratio) : 0,
            publish_source: issetv(common.publish_source) ? String(common.publish_source) : "",
            effect_type: issetv(common.effect_type) ? toInt(common.effect_type) : 0,
            video: {
                video_id: issetv(video.video_id) ? String(video.video_id) : "",
                duration_ms: issetv(video.duration_ms) ? toInt(video.duration_ms) : 0,
                transcode_status: issetv(video.transcode_status) ? toInt(video.transcode_status) : 0,
                has_audio: issetv(video.has_audio) ? toBool(video.has_audio) : true,
                is_mute: issetv(video.is_mute) ? toBool(video.is_mute) : false,
                watermark_type: issetv(video.watermark_type) ? toInt(video.watermark_type) : 0,
                width: issetv(originVideo.width) ? toInt(originVideo.width) : 0,
                height: issetv(originVideo.height) ? toInt(originVideo.height) : 0,
                fps: issetv(originVideo.fps) ? toInt(originVideo.fps) : 0,
                format: issetv(originVideo.format) ? String(originVideo.format) : "",
                definition: issetv(originVideo.definition) ? String(originVideo.definition) : "",
                md5: issetv(originVideo.md5) ? String(originVideo.md5) : "",
                size: issetv(originVideo.size) ? toInt(originVideo.size) : 0,
                bitrate: issetv(originVideo.br) ? toInt(originVideo.br) : 0,
            },
            statistics: {
                usage_num: issetv(statistic.usage_num) ? toInt(statistic.usage_num) : 0,
                favorite_num: issetv(statistic.favorite_num) ? toInt(statistic.favorite_num) : 0,
                play_num: issetv(statistic.play_num) ? toInt(statistic.play_num) : 0,
            },
            share_url: issetv(common.share_url) ? String(common.share_url) : "",
        },
    };

    return result;
}

// 按 item_id 解析（等价 PHP parseByItemId）
async function parseByItemId(itemId) {
    itemId = String(itemId === undefined || itemId === null ? "" : itemId).trim();
    if (itemId === "") {
        return output(400, "请提供有效的ID");
    }

    const state = {hint: ""};
    const detail = await fetchItemInfo(itemId, state);
    if (detail === null) {
        let msg = "请求失败";
        if (state.hint !== "") {
            msg += "（" + state.hint + "）";
        }
        return output(500, msg, state.hint !== "" ? {reason: state.hint} : []);
    }

    const payload = buildFormatData(detail);

    return output(200, "解析成功", payload);
}

// 聚合入口：shareUrl 可为分享链接/含链接文本/纯数字 ID（16 位以上）；
// opts.id 对应原版 GET id / POST body id 参数（优先级高于 shareUrl）
export async function parse(shareUrl, env, opts = {}) {
    let itemId = "";

    if (typeof opts.id === "string" && opts.id.trim() !== "") {
        itemId = opts.id;
    }

    if (itemId === "") {
        const extracted = await extractItemIdFromUrl(String(shareUrl || ""));
        if (extracted !== null && extracted !== "") {
            itemId = extracted;
        }
    }

    if (itemId === "") {
        return output(400, "链接格式错误，无法提取ID");
    }

    return parseByItemId(itemId);
}

export async function onRequest(context) {
    const request = context.request;
    if (request.method === "OPTIONS") {
        return new Response(null, {status: 204, headers: CORS_HEADERS});
    }

    // 入参优先级与 PHP 版一致：POST body（id / url / 纯文本）→ GET id → GET url
    let itemId = "";
    const u = new URL(request.url);

    if (request.method === "POST") {
        try {
            const rawBody = await request.text();
            if (rawBody) {
                let parsed = null;
                try {
                    parsed = JSON.parse(rawBody);
                } catch (e) {
                    parsed = null;
                }
                if (parsed !== null && typeof parsed === "object") {
                    if (typeof parsed.id === "string" && parsed.id !== "") {
                        itemId = parsed.id;
                    } else if (typeof parsed.url === "string") {
                        itemId = (await extractItemIdFromUrl(parsed.url)) || "";
                    }
                } else {
                    itemId = (await extractItemIdFromUrl(rawBody.trim())) || "";
                }
            }
        } catch (e) {
            // 忽略 body 读取失败
        }
    }

    if (itemId === "") {
        const gid = u.searchParams.get("id");
        if (gid !== null && gid !== "") {
            itemId = gid;
        } else {
            const gurl = u.searchParams.get("url");
            if (gurl !== null) {
                itemId = (await extractItemIdFromUrl(gurl)) || "";
            }
        }
    }

    if (itemId === "") {
        return jsonResponse({code: 400, msg: "请提供 id 参数", data: []}, 400);
    }

    try {
        const result = await parseByItemId(itemId);
        return jsonResponse(result, result.code >= 400 ? result.code : 200);
    } catch (e) {
        return jsonResponse({code: 500, msg: "解析失败: " + (e && e.message ? e.message : "未知错误"), data: []}, 500);
    }
}

// ---------- 兼容性辅助：边缘函数运行时不支持 AbortSignal.timeout() ----------
function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), Number(ms) || 0);
  return controller.signal;
}
