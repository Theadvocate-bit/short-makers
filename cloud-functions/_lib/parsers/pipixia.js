/**
 * short-makers · 皮皮虾解析器（Node.js ES Module 移植）
 *
 * 移植自原项目 api/ppxia.php（皮皮虾去水印解析）。
 * 逻辑：分享短链跟随重定向拿真实地址 → 正则提取 item/<id> → 请求
 *       https://h5.pipix.com/bds/cell/cell_h5_comment/?...&cell_id=<id>
 *       → 取 data.cell_comments[1].comment_info.item 里的视频/图集/作者/封面。
 * Cookie：PIPIXIA_COOKIE 环境变量（可选；原 PHP 未用 cookie，缺失则不带 Cookie 头）。
 * 防盗链：皮皮虾 CDN 直链原样返回（无防盗链包裹需求）。
 * 只依赖边缘运行时标准 fetch，无第三方包；禁止动态 import。
 */

const COMMENT_API = 'https://h5.pipix.com/bds/cell/cell_h5_comment/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

function jsonOut(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/** 空安全字符串转换 */
function strv(value) {
  if (typeof value === 'string') return value;
  return value === null || value === undefined ? '' : String(value);
}

/** 跟随重定向拿最终地址（redirect:'manual' 逐跳取 location，最多 max 跳） */
async function resolveRedirect(url, max = 10) {
  let current = url;
  for (let i = 0; i < max; i++) {
    let loc;
    try {
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': UA },
      });
      loc = res.headers.get('location');
    } catch {
      break;
    }
    if (!loc) break;
    // 相对地址转绝对
    try {
      loc = new URL(loc, current).href;
    } catch {
      /* 保持原值 */
    }
    current = loc;
  }
  return current;
}

/**
 * 解析皮皮虾视频/图集
 * @param {string} url 分享链接
 * @param {object} env Makers 环境变量（含可选 PIPIXIA_COOKIE）
 */
export async function parse(url, env = {}) {
  const cookie = (env && env.PIPIXIA_COOKIE) || '';

  if (!url || typeof url !== 'string') {
    return jsonOut({ code: 201, msg: '链接不能为空！' });
  }

  // 跟随重定向拿最终地址，再提取 item/<id>
  const finalUrl = await resolveRedirect(url);
  const idMatch = String(finalUrl).match(/item\/([^?&/]+)/);
  if (!idMatch) {
    return jsonOut({ code: 404, msg: '无法从 URL 中提取视频 ID' });
  }
  const cellId = idMatch[1];

  const apiUrl = COMMENT_API + '?count=5&aid=1319&app_name=super&cell_id=' + encodeURIComponent(cellId);

  let arr;
  try {
    const res = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      redirect: 'follow',
    });
    arr = await res.json();
  } catch (err) {
    return jsonOut({ code: 404, msg: '解析过程中出现错误: ' + String(err?.message || err) });
  }

  const item = arr?.data?.cell_comments?.[1]?.comment_info?.item;
  if (!item || typeof item !== 'object') {
    return jsonOut({ code: 404, msg: '解析失败，未找到所需数据' });
  }

  const videoUrl = item.video?.video_high?.url_list?.[0]?.url ?? null;

  // 图集：note.multi_image[].url_list[0].url
  const imgurl = [];
  const imageData = item.note;
  if (imageData && Array.isArray(imageData.multi_image)) {
    for (const img of imageData.multi_image) {
      const u = img?.url_list?.[0]?.url;
      if (u) imgurl.push(u);
    }
  }

  return jsonOut({
    code: 200,
    msg: '解析成功',
    data: {
      author: item.author?.name ?? null,
      avatar: item.author?.avatar?.download_list?.[0]?.url ?? null,
      title: item.content ?? null,
      cover: item.cover?.url_list?.[0]?.url ?? null,
      url: videoUrl,
      imgurl,
    },
  });
}
