#!/usr/bin/env node
/**
 * short-makers 自测：直接调用云函数的 onRequest / 解析器，不需起服务器。
 *
 *   npm test
 *
 * 离线部分：平台识别、调度路由、未移植平台提示。
 * 联网部分：Bilibili 真实解析（需联网；无 Cookie 时基础解析仍应返回 200）。
 */
import { detectPlatform, IMPLEMENTED, PLATFORMS } from '../cloud-functions/_lib/platforms.js';
import { onRequest as parseFn } from '../cloud-functions/api/[[default]].js';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? '  ' + detail : ''}`);
}

console.log('\n  short-makers 自测\n');

/* ---------- 离线：平台识别 ---------- */
check('识别 bilibili（www）', detectPlatform('https://www.bilibili.com/video/BV1x') === 'bilibili');
check('识别 bilibili（b23 短链）', detectPlatform('https://b23.tv/abc') === 'bilibili');
check('识别 douyin', detectPlatform('https://www.douyin.com/video/123') === 'douyin');
check('识别 iesdouyin 分享链接', detectPlatform('https://v.iesdouyin.com/share/x') === 'douyin');
check('识别 kuaishou', detectPlatform('https://www.kuaishou.com/f/x') === 'kuaishou');
check('识别 xiaohongshu（xhs 域）', detectPlatform('https://www.xiaohongshu.com/x') === 'xiaohongshu');
check('识别 weibo', detectPlatform('https://weibo.com/x') === 'weibo');
check('识别 toutiao', detectPlatform('https://www.toutiao.com/x') === 'toutiao');
check('无法识别返回 null', detectPlatform('https://example.com/x') === null);
check('IMPLEMENTED 含 bilibili', IMPLEMENTED.has('bilibili'));
check('douyin 标记为待移植', !IMPLEMENTED.has('douyin'));
check('平台表非空', PLATFORMS.length >= 9);

/* ---------- 离线：调度路由 ---------- */
async function callParse(url) {
  const req = new Request(new URL('/api/parse?url=' + encodeURIComponent(url), 'http://localhost'));
  return parseFn({ request: req, params: {}, env: {} });
}

{
  const res = await callParse('');
  const j = await res.json();
  check('空 url -> 201 提示', res.status === 200 && j.code === 201);
}
{
  const res = await callParse('https://example.com/x');
  const j = await res.json();
  check('不支持平台 -> code -1 + supported 列表', j.code === -1 && Array.isArray(j.supported));
}
{
  // douyin 已识别但未移植 -> code -2 明确提示
  const res = await callParse('https://www.douyin.com/video/123');
  const j = await res.json();
  check('未移植平台 -> code -2 明确提示', j.code === -2 && j.platform === 'douyin');
}

/* ---------- 联网：Bilibili 真实解析 ---------- */
try {
  const res = await callParse('https://www.bilibili.com/video/BV1GJ411x7h7');
  const j = await res.json();
  if (j.code === 200) {
    check('Bilibili 真实解析返回 code 200', true, `标题: ${String(j.data.title).slice(0, 20)}`);
    check('Bilibili 返回 videos 数组', Array.isArray(j.data.videos) && j.data.videos.length > 0);
  } else if (typeof j.msg === 'string' && j.msg.includes('风控拦截')) {
    // 本测试服务器数据中心 IP 被 B站 412 拦截，属环境限制，不算代码失败。
    // 在 EdgeOne 边缘节点或配置 BILIBILI_COOKIE 后可正常解析。
    console.log('  ⚠ Bilibili 解析被 B站风控拦截(412)，跳过（环境限制，非代码问题）');
  } else {
    check('Bilibili 真实解析返回 code 200', false, `msg: ${j.msg}`);
  }
} catch (err) {
  check('Bilibili 真实解析', false, err.message);
}

console.log(`\n  ${passed}/${passed + failed} 通过\n`);
process.exit(failed ? 1 : 0);
