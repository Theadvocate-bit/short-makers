
// 边缘运行时不支持 AbortSignal.timeout，用受支持的 AbortController 实现超时
function abortSignalTimeout(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/4/24 17:17
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: 豆包ai视频无水印解析（非对话生成的视频）
 * 豆包视频无水印解析官方免费接口文档：https://api.bugpk.com/doc-dbvideos.html
 * 目前线上接口为旧版方案，最新原生无水印逻辑与抖音一致，依托 mtsoken、a_bogus算法和隐藏接口实现
 * 为规避接口失效、杜绝算法倒卖，核心底层源码暂不对外开放，现有公开接口可免费稳定使用
 * @Remark: 已由 PHP 版移植为 EdgeOne Makers 边缘函数版（逻辑原样保留）
 */
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
// 公开匿名 ttwid（与 PHP 版一致，硬编码于源码；如失效需更新）
const COOKIE =
    "i18next=zh-CN; ttwid=1%7CFGYNcsGXqieXVBP4QNemEXTZLZoArf0NEPXt1WhSmm8%7C1772615343%7Cc6580d4acaa52df7479b610305cc558176ba8dfcdd55bf8d9ce6fe86d3948009";
const API_URL =
    "https://www.doubao.com/creativity/share/get_video_share_info?version_code=20800&language=zh-CN&device_platform=web&aid=497858&real_aid=497858&pkg_type=release_version&device_id=&pc_version=3.8.3&region=&sys_region=&samantha_web=1&use-olympus-account=1&web_tab_id=4d5d17a6-6729-4c1e-9f55-09f093100f0a";

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

// 等价 PHP empty()：'' / 0 / '0' / null / undefined 均为空
function phpEmpty(v) {
    return v === undefined || v === null || v === "" || v === 0 || v === "0";
}

function output(code, msg, data = []) {
    return {code: code, msg: msg, data: data};
}

// 获取真实链接（等价 PHP curl FOLLOWLOCATION + CURLINFO_EFFECTIVE_URL，失败回退原链接）
async function getRealUrl(url) {
    try {
        const resp = await fetch(url, {
            method: "GET",
            redirect: "follow",
            headers: {"user-agent": USER_AGENT},
            signal: abortSignalTimeout(10000),
        });
        return resp.url || url;
    } catch (e) {
        return url;
    }
}

// 提取查询参数（等价 PHP parse_url + parse_str）
function extractParams(url) {
    const params = {};
    try {
        const u = new URL(url);
        u.searchParams.forEach((v, k) => {
            params[k] = v;
        });
    } catch (e) {
        // 解析失败返回空参数
    }
    return params;
}

function buildReferer(params) {
    return (
        "https://www.doubao.com/video-sharing?share_id=" +
        (params.share_id !== undefined ? params.share_id : "") +
        "&source_type=mobile&video_id=" +
        (params.video_id !== undefined ? params.video_id : "") +
        "&share_scene=video_viewer"
    );
}

// 请求豆包分享信息接口（等价 PHP requestApi）
async function requestApi(params) {
    const postData = {
        share_id: params.share_id !== undefined ? params.share_id : "",
        vid: params.video_id !== undefined ? params.video_id : "",
        creation_id: "",
    };

    const headers = {
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9",
        "agw-js-conv": "str",
        "cache-control": "no-cache",
        "content-type": "application/json",
        origin: "https://www.doubao.com",
        pragma: "no-cache",
        priority: "u=1, i",
        referer: buildReferer(params),
        "sec-ch-ua": '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent": USER_AGENT,
        cookie: COOKIE,
        // 注：原 PHP 中的 'x-tt-logid;' 为畸形头（无冒号值），标准 fetch Headers 不允许该头名，已省略
    };

    try {
        const resp = await fetch(API_URL, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(postData),
            redirect: "follow",
            signal: abortSignalTimeout(15000),
        });
        const text = await resp.text();
        try {
            return JSON.parse(text);
        } catch (e) {
            return null;
        }
    } catch (e) {
        return null;
    }
}

// 聚合入口：解析豆包 AI 视频，返回最终 JSON 对象（与 PHP 版输出结构一致）
export async function parse(shareUrl, env) {
    const url = String(shareUrl || "");

    if (phpEmpty(url)) {
        return output(400, "请输入豆包视频链接");
    }

    const realUrl = await getRealUrl(url);

    const params = extractParams(realUrl);

    if (phpEmpty(params.share_id) || phpEmpty(params.video_id)) {
        return output(400, "无法从链接中提取必要参数");
    }

    const result = await requestApi(params);

    if (result) {
        // 只有当API响应的code为0时才返回成功
        if (isset(result, "code") && result.code === 0) {
            // 避免嵌套重复标签，如果API响应包含data字段，直接使用其内容
            if (isset(result, "data")) {
                return output(200, "解析成功", result.data);
            } else {
                return output(200, "解析成功", result);
            }
        } else {
            return output(500, "解析失败: API返回错误", result);
        }
    }

    return output(500, "解析失败");
}

export async function onRequest(context) {
    const request = context.request;
    if (request.method === "OPTIONS") {
        return new Response(null, {status: 204, headers: CORS_HEADERS});
    }

    let input = "";
    if (request.method === "POST") {
        try {
            const ct = request.headers.get("content-type") || "";
            if (ct.includes("application/json")) {
                const body = await request.json();
                input = (body && body.url) || "";
            } else {
                const form = await request.formData();
                input = form.get("url") || "";
                if (!input) {
                    // 等价 PHP $_POST['url'] 缺失时读 php://input：raw body 可能是 JSON 字符串或纯链接
                    const raw = await request.clone().text().catch(() => "");
                    if (raw) {
                        try {
                            const j = JSON.parse(raw);
                            input = j && typeof j === "object" ? (j.url !== undefined ? j.url : "") : raw;
                        } catch (e) {
                            input = raw;
                        }
                    }
                }
            }
        } catch (e) {
            input = "";
        }
    } else {
        // 等价 PHP GET 处理：从原始 query 串中定位第一个 'url='，取其后全部内容整体解码，
        // 避免分享长链自身携带的 & 被查询串解析截断
        const u = new URL(request.url);
        const qs = u.search.startsWith("?") ? u.search.slice(1) : u.search;
        const pos = qs.indexOf("url=");
        if (pos !== -1) {
            const raw = qs.slice(pos + 4);
            try {
                input = decodeURIComponent(raw);
            } catch (e) {
                input = raw;
            }
        } else {
            input = u.searchParams.get("url") || "";
        }
    }
    input = String(input).trim();

    if (!input) {
        return jsonResponse({code: 400, msg: "请提供url参数", data: []});
    }

    try {
        return jsonResponse(await parse(input, context.env));
    } catch (e) {
        return jsonResponse({code: 500, msg: "解析失败: " + (e && e.message ? e.message : "未知错误"), data: []});
    }
}
