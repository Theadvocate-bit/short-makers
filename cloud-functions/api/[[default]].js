/**
 * short-makers · API 统一分发入口（EdgeOne Makers Edge Function）
 *
 * 路由：cloud-functions/api/[[default]].js  ->  /api/*
 *
 * 采用 catch-all 统一分发（复刻已验证的 hghub-makers 模式），避免 bare 路径
 * （如 /parse）不命中 [[default]] catch-all 的 Makers 路由行为。所有端点统一挂在 /api/* 下：
 *
 *   GET /api/parse?url=<视频链接>          -> _lib/parse-handler.js（聚合解析）
 *   GET /api/proxy?proxyurl=<媒体直链>&...  -> _lib/proxy-handler.js（媒体防盗链代理）
 *   GET /api                              -> 端点列表
 *
 * 各 handler 只依赖边缘运行时标准 API，无第三方包。这里用动态 import() 按需加载
 * handler 模块（构建器会把它们打进产物；本文件在 api/[[default]].js，其动态 import
 * 已验证可正常构建，与早期 [[default]].js 单文件里的动态 import 失败场景不同）。
 */

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
};

function jsonOut(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

/** GET /api 端点列表 */
function endpointList() {
  return jsonOut({
    name: 'short-makers',
    endpoints: {
      parse: '/api/parse?url=<视频链接>',
      proxy: '/api/proxy?proxyurl=<媒体直链>&type=douyin|weibo&download=true|false&mediatype=video|image',
    },
    platforms: '见 /api/parse 对不识别链接的返回；已移植 bilibili，其余返回 code:-2 待移植提示',
  });
}

/** EdgeOne Makers 入口 */
export async function onRequest(context) {
  const request = context.request;

  // CORS 预检统一处理
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...JSON_HEADERS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' },
    });
  }
  if (request.method !== 'GET') {
    return jsonOut({ code: 405, msg: '仅支持 GET 请求' }, 405);
  }

  const url = new URL(request.url);
  const { pathname } = url;

  // 精确去掉开头的 /api，得到子路径
  let sub = pathname;
  if (sub === '/api') {
    return endpointList();
  }
  if (sub.startsWith('/api/')) {
    sub = sub.slice('/api'.length); // '/parse' / '/proxy'
  }

  try {
    if (sub === '/parse' || sub.startsWith('/parse/')) {
      const { onRequest: parseHandler } = await import('../_lib/parse-handler.js');
      return await parseHandler(context);
    }
    if (sub === '/proxy' || sub.startsWith('/proxy/')) {
      const { onRequest: proxyHandler } = await import('../_lib/proxy-handler.js');
      return await proxyHandler(context);
    }
  } catch (err) {
    return jsonOut({ code: 500, msg: 'handler 加载失败', detail: String(err?.message || err) }, 500);
  }

  return jsonOut(
    {
      code: 404,
      msg: `未知端点：${pathname}`,
      endpoints: ['/api/parse', '/api/proxy', '/api'],
    },
    404,
  );
}
