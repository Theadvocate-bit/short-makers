/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/4/24 17:15
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: 豆包提取对话无水印图片
 * @Remark: 已由 PHP 版移植为 EdgeOne Makers 边缘函数版（逻辑原样保留）
 *          说明：源码无 AES/会话逻辑，仅用 base64 解码 video_model 内嵌直链；
 *          DOM 解析（DOMDocument）以正则 script 属性提取等价实现。
 */
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const CORS_HEADERS = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type",
}

// 等价 PHP respond()：{code, msg, ...extra} 平铺结构；code 同时作为 HTTP 状态码
function respond(code, msg, extra = {}) {
    return Object.assign({code: code, msg: msg}, extra);
}

function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {status: status || 200, headers: CORS_HEADERS});
}

// 等价 PHP decode_json_array()
function decodeJsonArray(json) {
    if (typeof json !== "string" || json === "") {
        return null;
    }
    try {
        return JSON.parse(json);
    } catch (e) {
        return null;
    }
}

// 等价 PHP base64_decode($encoded, true)：非法输入返回空串
function base64DecodeStrict(encoded) {
    try {
        return atob(encoded) || "";
    } catch (e) {
        return "";
    }
}

// 等价 PHP html_entity_decode(ENT_QUOTES | ENT_HTML5, 'UTF-8')（覆盖常用命名实体与数字实体）
function htmlEntityDecode(str) {
    if (!str) return str;
    const named = {amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®"};
    return String(str).replace(
        /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g,
        function (all, body) {
            if (body.charAt(0) === "#") {
                const code =
                    body.charAt(1) === "x" || body.charAt(1) === "X"
                        ? parseInt(body.slice(2), 16)
                        : parseInt(body.slice(1), 10);
                if (isNaN(code) || code < 0 || code > 0x10ffff) return all;
                try {
                    return String.fromCodePoint(code);
                } catch (e) {
                    return all;
                }
            }
            const mapped = named[body.toLowerCase()];
            return mapped !== undefined ? mapped : all;
        }
    );
}

// 从 HTML 提取全部 <script ...> 开标签的属性串（等价 DOMDocument getElementsByTagName('script')）
function extractScriptAttrStrings(html) {
    const attrsList = [];
    const re = /<script\b([^>]*)>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        attrsList.push(m[1]);
    }
    return attrsList;
}

// 从属性串中取单个属性值（等价 DOMElement::getAttribute，未命中返回空串）
function getAttr(attrsStr, name) {
    const re = new RegExp(
        '(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'<>]+))',
        "i"
    );
    const m = attrsStr.match(re);
    if (!m) return "";
    const val = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    return htmlEntityDecode(val);
}

// 安全获取数组路径值（等价 PHP arr_get / array_key_exists）
function arrGet(arr, path, dflt = null) {
    let cur = arr;
    for (const k of path) {
        if (cur === null || cur === undefined || typeof cur !== "object" || !(k in cur)) {
            return dflt;
        }
        cur = cur[k];
    }
    return cur;
}

// 等价 PHP sanitize_video_url()：剥离水印相关查询参数（lr / logo_type / download）
function sanitizeVideoUrl(url) {
    if (typeof url !== "string" || url === "") {
        return "";
    }
    let u;
    try {
        u = new URL(url);
    } catch (e) {
        return url;
    }
    if (!u.protocol || !u.hostname || !u.pathname) {
        return url;
    }
    const query = new URLSearchParams(u.search);
    // 常见水印相关参数，移除后可拿到更干净的直链
    query.delete("lr");
    query.delete("logo_type");
    query.delete("download");
    let sanitized = u.protocol + "//" + u.hostname + u.pathname;
    const qs = query.toString();
    if (qs) {
        sanitized += "?" + qs;
    }
    return sanitized;
}

// 等价 PHP is_watermarked_video_url()
function isWatermarkedVideoUrl(url) {
    if (typeof url !== "string" || url === "") {
        return false;
    }
    const lower = url.toLowerCase();
    const watermarkMarkers = [
        "video_gen_watermark",
        "watermark_dyn",
        "logo_type=video_gen_watermark",
    ];
    for (const marker of watermarkMarkers) {
        if (lower.indexOf(marker) !== -1) {
            return true;
        }
    }
    return false;
}

// 等价 PHP extract_video_urls()：download_url 兜底 + video_model(base64) 内嵌直链
function extractVideoUrls(video) {
    const urls = [];

    // 1) 先收集外层 download_url（作为兜底）
    const downloadUrl = arrGet(video, ["download_url"], "");
    if (downloadUrl !== "") {
        const sanitized = sanitizeVideoUrl(downloadUrl);
        if (!isWatermarkedVideoUrl(sanitized)) {
            urls.push(sanitized);
        }
    }

    // 2) video_model 里可能有更完整的直链（main_url/backup_url_1 是 base64）
    const videoModelRaw = arrGet(video, ["video_model"], "");
    const videoModel = decodeJsonArray(videoModelRaw);
    if (videoModel !== null && typeof videoModel === "object") {
        const videoList = arrGet(videoModel, ["video_list"], []);
        if (videoList !== null && typeof videoList === "object") {
            const list = Array.isArray(videoList) ? videoList : Object.values(videoList);
            for (const variant of list) {
                if (variant === null || typeof variant !== "object") {
                    continue;
                }
                for (const k of ["main_url", "backup_url_1"]) {
                    const encoded = variant[k] !== undefined && variant[k] !== null ? variant[k] : "";
                    if (typeof encoded !== "string" || encoded === "") {
                        continue;
                    }
                    const decoded = base64DecodeStrict(encoded);
                    if (decoded === "") {
                        continue;
                    }
                    const sanitized = sanitizeVideoUrl(decoded);
                    if (!isWatermarkedVideoUrl(sanitized)) {
                        urls.push(sanitized);
                    }
                }
            }
        }
    }

    // 去重
    const unique = [];
    const seen = Object.create(null);
    for (const u of urls) {
        if (u === "" || seen[u]) {
            continue;
        }
        seen[u] = true;
        unique.push(u);
    }
    return unique;
}

// 从任意层级递归提取 creations（等价 PHP collect_creations，JSON 数组与对象均遍历）
function collectCreations(node, out) {
    if (node === null || typeof node !== "object") {
        return;
    }

    const cbCreations = arrGet(node, ["creation_block", "creations"], null);
    if (cbCreations !== null && typeof cbCreations === "object") {
        const list = Array.isArray(cbCreations) ? cbCreations : Object.values(cbCreations);
        for (const c of list) {
            if (c !== null && typeof c === "object") {
                out.push(c);
            }
        }
    }

    const creations = arrGet(node, ["creations"], null);
    if (creations !== null && typeof creations === "object") {
        const list2 = Array.isArray(creations) ? creations : Object.values(creations);
        for (const c of list2) {
            if (c !== null && typeof c === "object") {
                out.push(c);
            }
        }
    }

    for (const v of Object.values(node)) {
        if (v !== null && typeof v === "object") {
            collectCreations(v, out);
        }
    }
}

// 解析 message 的 content / content_v2 字符串 JSON，并提取 creation
// （等价 PHP collect_creations_from_message）
function collectCreationsFromMessage(message, out) {
    if (message === null || typeof message !== "object") {
        return;
    }

    // 直接在 message 本体找
    collectCreations(message, out);

    // content: 通常是一个 JSON 字符串（数组）
    if (message.content && typeof message.content === "string") {
        const decoded = decodeJsonArray(message.content);
        if (decoded !== null) {
            collectCreations(decoded, out);
        }
    }

    // content_block 下每个 block 的 content / content_v2 也可能是字符串 JSON
    if (message.content_block && typeof message.content_block === "object") {
        const blocks = Array.isArray(message.content_block)
            ? message.content_block
            : Object.values(message.content_block);
        for (const block of blocks) {
            if (block === null || typeof block !== "object") {
                continue;
            }
            collectCreations(block, out);

            if (block.content && typeof block.content === "string") {
                const decoded = decodeJsonArray(block.content);
                if (decoded !== null) {
                    collectCreations(decoded, out);
                }
            }
            if (block.content_v2 && typeof block.content_v2 === "string") {
                const decoded = decodeJsonArray(block.content_v2);
                if (decoded !== null) {
                    collectCreations(decoded, out);
                }
            }
        }
    }
}

// 聚合入口：解析豆包对话分享页，返回最终 JSON 对象（与 PHP 版输出结构一致）
export async function parse(shareUrl, env) {
    const url = String(shareUrl || "").trim();
    if (!url) {
        return respond(400, "缺少url参数");
    }

    let html = "";
    try {
        const resp = await fetch(url, {
            method: "GET",
            redirect: "follow",
            headers: {"user-agent": USER_AGENT},
            signal: timeoutSignal(10000),
        });
        html = await resp.text();
    } catch (e) {
        return respond(500, "抓取失败: " + (e && e.message ? e.message : "unknown"));
    }
    if (!html) {
        return respond(500, "网页内容为空，抓取失败");
    }

    // 使用正则解析 script 标签属性，避免依赖 DOM（边缘环境无 DOMDocument）
    const scriptAttrStrings = extractScriptAttrStrings(html);
    let rawFnArgs = "";
    for (const attrs of scriptAttrStrings) {
        const candidate = getAttr(attrs, "data-fn-args");
        if (candidate === "") {
            continue;
        }
        // 优先匹配路由脚本
        if (getAttr(attrs, "data-fn-name") === "r" && getAttr(attrs, "data-script-src") === "modern-run-router-data-fn") {
            rawFnArgs = candidate;
            break;
        }
        // 兜底：先记住第一个 data-fn-args
        if (rawFnArgs === "") {
            rawFnArgs = candidate;
        }
    }

    if (rawFnArgs === "") {
        return respond(404, "未找到 script[data-fn-args] 属性");
    }

    // data-fn-args 在 HTML 中通常是 &quot; 实体编码，这里先还原。
    const decodedFnArgs = htmlEntityDecode(rawFnArgs);

    // data-fn-args 本身是一个 JSON 字符串（数组），例如：["thread_(token)/page","shareInfo",{...}]
    const parsedFnArgs = decodeJsonArray(decodedFnArgs);

    if (parsedFnArgs === null) {
        return respond(422, "data-fn-args 不是合法 JSON", {
            data_fn_args_raw: rawFnArgs,
            data_fn_args_decoded: decodedFnArgs,
        });
    }

    const payload =
        parsedFnArgs[2] !== undefined && parsedFnArgs[2] !== null && typeof parsedFnArgs[2] === "object"
            ? parsedFnArgs[2]
            : {};
    const data = arrGet(payload, ["data"], {});
    const messageList = arrGet(data, ["message_snapshot", "message_list"], []);

    const allCreations = [];
    if (messageList !== null && typeof messageList === "object") {
        const list = Array.isArray(messageList) ? messageList : Object.values(messageList);
        for (const msg of list) {
            collectCreationsFromMessage(msg, allCreations);
        }
    }

    // 提取无水印图片（image_ori_raw.url）和视频（video.download_url）
    const images = [];
    const videos = [];
    const seenImage = Object.create(null);
    const seenVideo = Object.create(null);
    for (const c of allCreations) {
        // 图片
        if (c.image !== undefined && c.image !== null && typeof c.image === "object") {
            const img = c.image;
            const rawUrl = arrGet(img, ["image_ori_raw", "url"], "");
            if (rawUrl !== "" && !seenImage[rawUrl]) {
                seenImage[rawUrl] = true;
                images.push(rawUrl);
            }
        }

        // 视频
        if (c.video !== undefined && c.video !== null && typeof c.video === "object") {
            const videoUrls = extractVideoUrls(c.video);
            for (const videoUrl of videoUrls) {
                if (!seenVideo[videoUrl]) {
                    seenVideo[videoUrl] = true;
                    videos.push(videoUrl);
                }
            }
        }
    }

    return respond(
        200,
        images.length > 0 || videos.length > 0
            ? "ok"
            : "当前分享数据仅包含水印资源，未发现可用无水印直链",
        {images: images, videos: videos}
    );
}

export async function onRequest(context) {
    const request = context.request;
    if (request.method === "OPTIONS") {
        return new Response(null, {status: 204, headers: CORS_HEADERS});
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
        return jsonResponse(respond(400, "缺少url参数"), 400);
    }
    try {
        const result = await parse(input, context.env);
        // code 语义与 PHP 版一致：>=400 的 code 同时作为 HTTP 状态码
        return jsonResponse(result, result.code >= 400 ? result.code : 200);
    } catch (e) {
        return jsonResponse(respond(500, "解析失败: " + (e && e.message ? e.message : "未知错误")), 500);
    }
}

// ---------- 兼容性辅助：边缘函数运行时不支持 AbortSignal.timeout() ----------
function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), Number(ms) || 0);
  return controller.signal;
}
