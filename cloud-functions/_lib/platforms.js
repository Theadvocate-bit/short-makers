/**
 * short-makers · 平台识别
 *
 * 移植自原项目 api/sv.php 的 $platforms 配置：按 URL 里的关键词识别平台。
 * 返回平台 key，供 /api/parse 调度到对应解析器。
 */

/** 平台关键词表（顺序即优先级）。新增平台在这里加一项 + 在 parsers/ 加实现。 */
export const PLATFORMS = [
  { key: 'douyin',      keywords: ['douyin', 'iesdouyin'] },
  { key: 'kuaishou',    keywords: ['kuaishou'] },
  { key: 'xiaohongshu', keywords: ['xhs', 'xiaohongshu'] },
  { key: 'bilibili',    keywords: ['bilibili', 'b23'] },
  { key: 'weibo',       keywords: ['weibo'] },
  { key: 'toutiao',     keywords: ['toutiao'] },
  { key: 'pipixia',     keywords: ['pipix'] },
  { key: 'pipigx',      keywords: ['ippzone', 'pipigx'] },
  { key: 'zuiyou',      keywords: ['izuiyou'] },
];

/** 已经移植到 Node.js 的平台（其余在 README 标注为待移植） */
export const IMPLEMENTED = new Set(['bilibili', 'toutiao']);

/**
 * 按 URL 识别平台 key。
 * @param {string} url 用户提交的视频链接
 * @returns {string|null} 平台 key，识别不出返回 null
 */
export function detectPlatform(url) {
  const lower = (url || '').toLowerCase();
  for (const cfg of PLATFORMS) {
    for (const kw of cfg.keywords) {
      if (lower.includes(kw)) return cfg.key;
    }
  }
  return null;
}
