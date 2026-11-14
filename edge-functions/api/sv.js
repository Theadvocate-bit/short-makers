/**
 * @Author: JH-Ahua
 * @CreateTime: 2025/8/6 上午12:56
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: 短视频聚合解析（EdgeOne Makers 边缘函数版）：一个入口自动识别平台，模块内直接调用对应单平台解析器
 * @Remark: 已由 PHP 版移植为 EdgeOne Makers 边缘函数版。原 PHP 版通过 HTTP 自转发到单平台接口，
 *          边缘函数版改为直接 import 各解析器的 parse()，省去一次回环请求，延迟更低。
 */

import { parse as douyinParse } from './douyin.js';
import { parse as kuaishouParse } from './kuaishou.js';
import { parse as xiaohongshuParse } from './xiaohongshu.js';
import { parse as bilibiliParse } from './bilibili.js';
import { parse as weiboParse } from './weibo.js';
import { parse as toutiaoParse } from './toutiao.js';
import { parse as ppxiaParse } from './ppxia.js';
import { parse as pipigxParse } from './pipigx.js';
import { parse as zuiyouParse } from './zuiyou.js';

// ==================== 配置区域 ====================
// 平台关键词与对应解析器（顺序与 PHP 版 sv.php 保持一致，先匹配先命中）
const platforms = [
    { keywords: ['douyin', 'iesdouyin'], parse: douyinParse },
    { keywords: ['kuaishou'], parse: kuaishouParse },
    { keywords: ['xhs', 'xiaohongshu'], parse: xiaohongshuParse },
    { keywords: ['bilibili', 'b23'], parse: bilibiliParse },
    { keywords: ['weibo'], parse: weiboParse },
    { keywords: ['toutiao'], parse: toutiaoParse },
    { keywords: ['pipix'], parse: ppxiaParse },
    { keywords: ['ippzone', 'pipigx'], parse: pipigxParse },
    { keywords: ['izuiyou'], parse: zuiyouParse },
];
// ==================================================

const CORS_HEADERS = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'Content-Type',
};

function jsonResponse(data) {
    return new Response(JSON.stringify(data), { status: 200, headers: CORS_HEADERS });
}

/** 从输入中提取首个 http(s) 链接（支持整段分享文本） */
function extractShareUrl(text) {
    const matches = String(text).match(/https?:\/\/[^\s"'<>]+/i);
    if (matches) {
        return matches[0].replace(/['"，。；,.;]+$/, '');
    }
    return null;
}

/** 根据关键词匹配平台解析器 */
function matchPlatform(text) {
    const lower = String(text).toLowerCase();
    for (const config of platforms) {
        for (const keyword of config.keywords) {
            if (lower.indexOf(keyword) !== -1) {
                return config;
            }
        }
    }
    return null;
}

/**
 * 聚合解析：自动识别平台并调用对应解析器
 * @param {string} url 用户输入的分享文本或链接
 * @param {object} env EdgeOne 环境变量
 */
export async function parse(url, env) {
    if (!url || (typeof extractShareUrl(url) !== 'string')) {
        return { code: 400, msg: '请输入有效的链接', data: [] };
    }
    const shareUrl = extractShareUrl(url);
    const platform = matchPlatform(url);
    if (!platform) {
        return { code: 201, msg: '不支持您输入的链接平台', data: [] };
    }
    try {
        return await platform.parse(shareUrl, env);
    } catch (e) {
        return { code: 500, msg: '请求接口失败: ' + (e && e.message ? e.message : '未知错误'), data: [] };
    }
}

export async function onRequest(context) {
    const request = context.request;
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    // 获取请求参数（GET/POST 均支持，兼容未编码的分享文本）
    let url = '';
    const u = new URL(request.url);
    // 与 PHP 版一致：从原始 query 串定位 url=，取其后全部内容（保留分享链接自带的 & 等字符）
    const qs = u.search || '';
    const urlParamPos = qs.indexOf('url=');
    if (urlParamPos !== -1) {
        url = decodeURIComponent(qs.slice(urlParamPos + 4)).trim();
    }
    if (!url && request.method === 'POST') {
        try {
            const ct = request.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
                const body = await request.json();
                url = String((body && body.url) || '').trim();
            } else {
                const form = await request.formData();
                url = String(form.get('url') || '').trim();
            }
        } catch (e) {
            url = '';
        }
    }

    return jsonResponse(await parse(url, context.env));
}
