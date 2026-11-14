/**
 * short-makers · 聚合解析调度器（共享模块，由 cloud-functions/api/[[default]].js 分发到 /api/parse）
 *
 * 移植自原项目 api/sv.php：一个入口自动识别平台，转发到对应单平台解析器，
 * 输出统一 JSON 格式（见 docs/视频解析统一JSON格式3.0.md）。
 *
 * 用法：GET /api/parse?url=<视频链接>
 *
 * 移植状态（诚实标注）：
 *   - bilibili   已移植可用（需 BILIBILI_COOKIE 环境变量）
 *   - douyin / kuaishou / xiaohongshu / weibo / toutiao / pipixia / pipigx /
 *     zuiyou      尚未移植（原 PHP 解析器在 Theadvocate-bit/short_videos），
 *                  识别出平台后会返回「该平台解析器尚未移植」的明确提示。
 *
 * 只依赖边缘运行时标准 fetch，无第三方包。
 */

import { detectPlatform, IMPLEMENTED, PLATFORMS } from '../_lib/platforms.js';
// 平台解析器静态引入（已移植的平台在此注册到 PARSERS 映射）。
import { parse as parseBilibili } from '../_lib/parsers/bilibili.js';

const PARSERS = {
  bilibili: parseBilibili,
};

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
};

function jsonOut(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

/** 查找对应平台的解析器（静态映射，已移植平台在文件顶部 import） */
function loadParser(platformKey) {
  return PARSERS[platformKey] || null;
}

/** EdgeOne Makers 入口 */
export async function onRequest(context) {
  const request = context.request;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...JSON_HEADERS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
  }
  if (request.method !== 'GET') {
    return jsonOut({ code: 405, msg: '仅支持 GET 请求' }, 405);
  }

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

  const parse = await loadParser(platform);
  if (!parse) {
    return jsonOut({ code: -2, msg: `平台「${platform}」解析器加载失败` }, 500);
  }

  try {
    return await parse(target, context.env || {});
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
