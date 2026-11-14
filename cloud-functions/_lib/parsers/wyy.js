/**
 * short-makers · 网易云音乐解析器（Node.js ES Module 移植）
 *
 * 移植自原项目 api/wyy.py（网易云音乐 eapi 解析：歌曲直链/歌词/封面）。
 * 逻辑：
 *   1. 从 url（或 ids）提取歌曲 id：163cn.tv 短链跟随 302；music.163.com 取 id= 参数；
 *   2. eapi 加密请求 https://interface3.music.163.com/eapi/song/enhance/player/url/v1
 *      （md5 摘要 + AES-128-ECB(PKCS7) 加密 params，纯 JS 实现，不依赖 node:crypto）；
 *   3. 取 data[0].id 请求 api/v3/song/detail 拿歌名/封面/歌手/专辑；
 *   4. 请求 api/song/lyric 拿歌词/tlyric；
 *   5. 组装 { status, name, pic, ar_name, al_name, level, size, url, lyric, tlyric }。
 * Cookie：WYY_COOKIE 环境变量（可选；默认 "MUSIC_U=;os=pc;appver=8.9.75;"）。
 * level/type 取自 url query（level 默认 standard，type 默认 json）。
 * 只依赖边缘运行时标准 fetch，无第三方包；禁止动态 import。
 */

const EAPI_URL = 'https://interface3.music.163.com/eapi/song/enhance/player/url/v1';
const EAPI_PATH = '/api/song/enhance/player/url/v1';
const DETAIL_URL = 'https://interface3.music.163.com/api/v3/song/detail';
const LYRIC_URL = 'https://interface3.music.163.com/api/song/lyric';
const AES_KEY_ASCII = 'e82ckenh8dichen8';
const DEFAULT_COOKIE = 'MUSIC_U=;os=pc;appver=8.9.75;';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/2.10.2.200154';

function jsonOut(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/* ============================== MD5（纯 JS，输入字节 → hex） ============================== */

/** md5(bytes: Uint8Array) -> 32 位小写 hex（移植 HashHexDigest 依赖的 md5） */
function md5Hex(bytes) {
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  }

  const origLen = bytes.length;
  const bitLen = origLen * 8;
  // padding: 0x80 + zeros until len%64==56, then 8-byte little-endian length
  const paddedLen = ((origLen + 8) >> 6) * 64 + 64;
  const msg = new Uint8Array(paddedLen);
  msg.set(bytes);
  msg[origLen] = 0x80;
  // 写入 64 位小端长度（JS 用两个 32 位即可，长度不会超 2^53）
  const lo = bitLen >>> 0;
  const hi = Math.floor(bitLen / 4294967296) >>> 0;
  const dv = new DataView(msg.buffer);
  dv.setUint32(paddedLen - 8, lo, true);
  dv.setUint32(paddedLen - 4, hi, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  const M = new Int32Array(16);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);

    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }

      F = (F + A + K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }

  const out = new ArrayBuffer(16);
  const odv = new DataView(out);
  odv.setInt32(0, a0, true); odv.setInt32(4, b0, true);
  odv.setInt32(8, c0, true); odv.setInt32(12, d0, true);
  return [...new Uint8Array(out)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ============================== AES-128-ECB（纯 JS） ============================== */

/** 运行时生成 AES S-box（GF(2^8) 求逆 + 仿射变换），避免手抄表出错 */
function buildSbox() {
  const sbox = new Uint8Array(256);
  const exp = new Uint8Array(256);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    // x *= 3（GF(2^8) 生成元），模 0x11b
    x ^= (x << 1) ^ (x & 0x80 ? 0x1b : 0);
    x &= 0xff;
  }
  exp[255] = exp[0]; log[0] = 0;
  for (let i = 0; i < 256; i++) {
    const inv = i === 0 ? 0 : exp[255 - log[i]];
    const s = inv ^ rotl(inv, 1) ^ rotl(inv, 2) ^ rotl(inv, 3) ^ rotl(inv, 4) ^ 0x63;
    sbox[i] = s & 0xff;
  }
  return sbox;
}

function rotl(v, n) {
  return ((v << n) | (v >>> (8 - n))) & 0xff;
}

const SBOX = buildSbox();

/** AES-128 密钥扩展（key 16 字节 → 176 字节轮密钥） */
function keyExpansion(key) {
  const Rcon = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
  const w = new Uint8Array(176);
  w.set(key.subarray(0, 16), 0);
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
    if (i % 16 === 0) {
      const tmp = t0;
      t0 = SBOX[t1] ^ Rcon[i / 16 - 1];
      t1 = SBOX[t2];
      t2 = SBOX[t3];
      t3 = SBOX[tmp];
    }
    w[i] = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}

function xtime(a) {
  return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
}

function addRoundKey(s, w, off) {
  for (let i = 0; i < 16; i++) s[i] ^= w[off + i];
}

function subBytes(s) {
  for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
}

function shiftRows(s) {
  let t;
  t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;      // row1 <<1
  t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t; // row2 <<2
  t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;    // row3 <<3
}

function mixColumns(s) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
    s[i] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
    s[i + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
    s[i + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
    s[i + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
  }
}

/** AES-128-ECB 加密一个 16 字节块 */
function encryptBlock(w, block) {
  const s = new Uint8Array(block);
  addRoundKey(s, w, 0);
  for (let round = 1; round < 10; round++) {
    subBytes(s); shiftRows(s); mixColumns(s); addRoundKey(s, w, round * 16);
  }
  subBytes(s); shiftRows(s); addRoundKey(s, w, 160);
  return s;
}

/** PKCS7 填充 */
function pkcs7Pad(data) {
  const padLen = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + padLen);
  out.set(data);
  out.fill(padLen, data.length);
  return out;
}

/** AES-128-ECB(PKCS7) 加密 → 小写 hex（移植 url_v1 的 AES 部分） */
function aesEcbEncryptHex(plaintextBytes) {
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) key[i] = AES_KEY_ASCII.charCodeAt(i);
  const w = keyExpansion(key);
  const padded = pkcs7Pad(plaintextBytes);
  const out = new Uint8Array(padded.length);
  for (let off = 0; off < padded.length; off += 16) {
    out.set(encryptBlock(w, padded.subarray(off, off + 16)), off);
  }
  return [...out].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ============================== 业务逻辑 ============================== */

/** UTF-8 字符串 → 字节数组 */
function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}

/** 解析 cookie 字符串为对象（移植 parse_cookie） */
function parseCookie(text) {
  const obj = {};
  for (const item of String(text || '').split(';')) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const k = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim();
    const v = eq === -1 ? '' : trimmed.slice(eq + 1).trim();
    if (k) obj[k] = v;
  }
  return obj;
}

/** eapi 请求：md5 摘要 + AES-ECB 加密 params，POST form（移植 url_v1） */
async function eapiUrlV1(id, level, cookieObj) {
  const config = {
    os: 'pc',
    appver: '',
    osver: '',
    deviceId: 'pyncm!',
    requestId: String(20000000 + Math.floor(Math.random() * 10000000)),
  };
  const payload = {
    ids: [id],
    level,
    encodeType: 'flac',
    header: JSON.stringify(config),
  };
  if (level === 'sky') payload.immerseType = 'c51';

  const payloadStr = JSON.stringify(payload);
  const digest = md5Hex(utf8Bytes('nobody' + EAPI_PATH + 'use' + payloadStr + 'md5forencrypt'));
  const plain = EAPI_PATH + '-36cd479b6b5-' + payloadStr + '-36cd479b6b5-' + digest;
  const encrypted = aesEcbEncryptHex(utf8Bytes(plain));

  const body = new URLSearchParams({ params: encrypted }).toString();
  const cookieHeader = Object.entries({ os: 'pc', appver: '', osver: '', deviceId: 'pyncm!', ...cookieObj })
    .map(([k, v]) => k + '=' + v).join('; ');

  const res = await fetch(EAPI_URL, {
    method: 'POST',
    headers: {
      'User-Agent': DESKTOP_UA,
      Referer: '',
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader,
    },
    body,
  });
  return res.json();
}

/** 歌曲详情（歌名/封面/歌手/专辑，移植 name_v1） */
async function songDetail(id) {
  const body = new URLSearchParams({ c: JSON.stringify([{ id, v: 0 }]) }).toString();
  const res = await fetch(DETAIL_URL, {
    method: 'POST',
    headers: {
      'User-Agent': DESKTOP_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  return res.json();
}

/** 歌词（移植 lyric_v1） */
async function songLyric(id, cookieObj) {
  const body = new URLSearchParams({
    id: String(id), cp: 'false', tv: '0', lv: '0', rv: '0',
    kv: '0', yv: '0', ytv: '0', yrv: '0',
  }).toString();
  const cookieHeader = Object.entries(cookieObj).map(([k, v]) => k + '=' + v).join('; ');
  const res = await fetch(LYRIC_URL, {
    method: 'POST',
    headers: {
      'User-Agent': DESKTOP_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader,
    },
    body,
  });
  return res.json();
}

/** 从 url/ids 提取歌曲 id（移植 ids）：163cn.tv 短链跟 302；music.163.com 取 id= 参数 */
async function extractSongId(input) {
  let s = String(input || '');
  if (s.includes('163cn.tv')) {
    try {
      const res = await fetch(s, { method: 'GET', redirect: 'manual' });
      s = res.headers.get('location') || s;
    } catch {
      /* 保持原值 */
    }
  }
  if (s.includes('music.163.com')) {
    const idx = s.indexOf('id=') + 3;
    s = s.slice(idx).split('&')[0];
  }
  return s;
}

/** 字节数格式化（移植 size） */
function formatSize(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = value;
  for (const unit of units) {
    if (v / 1024 < 1) return v.toFixed(2) + unit;
    v = v / 1024;
  }
  return v;
}

/** 音质中文名（移植 music_level1） */
function musicLevelLabel(value) {
  const levels = {
    standard: '标准音质',
    exhigh: '极高音质',
    lossless: '无损音质',
    hires: 'Hires音质',
    sky: '沉浸环绕声',
    jyeffect: '高清环绕声',
    jymaster: '超清母带',
  };
  return levels[value] || '未知音质';
}

/**
 * 解析网易云音乐
 * @param {string} url 歌曲链接或 id（可带 ?level=&type= 参数）
 * @param {object} env Makers 环境变量（含可选 WYY_COOKIE）
 */
export async function parse(url, env = {}) {
  if (!url || typeof url !== 'string') {
    return jsonOut({ code: 201, msg: '必须提供 ids 或 url 参数' });
  }

  // level/type 从 url query 取（无则默认），保持与原版字段语义
  let level = 'standard';
  let type = 'json';
  try {
    const u = new URL(url);
    if (u.searchParams.get('level')) level = u.searchParams.get('level');
    if (u.searchParams.get('type')) type = u.searchParams.get('type');
  } catch {
    /* 非标准 URL，按纯 id 处理 */
  }

  const songIdInput = url;
  const cookieObj = parseCookie((env && env.WYY_COOKIE) || DEFAULT_COOKIE);

  const songId = await extractSongId(songIdInput);
  if (!songId) {
    return jsonOut({ code: 201, msg: '必须提供 ids 或 url 参数' });
  }

  let urlv1;
  try {
    urlv1 = await eapiUrlV1(songId, level, cookieObj);
  } catch (err) {
    return jsonOut({ code: 0, msg: '解析失败！', detail: String(err?.message || err) });
  }

  const firstData = urlv1?.data?.[0];
  if (!firstData || firstData.url == null) {
    return jsonOut({ code: 400, msg: '信息获取不完整！' });
  }

  let namev1;
  try {
    namev1 = await songDetail(firstData.id);
  } catch (err) {
    return jsonOut({ code: 0, msg: '解析失败！', detail: String(err?.message || err) });
  }
  if (!namev1?.songs?.length) {
    return jsonOut({ code: 400, msg: '信息获取不完整！' });
  }

  let lyricv1;
  try {
    lyricv1 = await songLyric(firstData.id, cookieObj);
  } catch {
    lyricv1 = { lrc: { lyric: '' }, tlyric: {} };
  }

  const song = namev1.songs[0];
  const songUrl = firstData.url;
  const songName = song.name;
  const songPic = song.al?.picUrl;
  const songAlname = song.al?.name;
  // 每首歌取 ar 列表里所有歌手名用 '/' 连接，多首（同 id）之间用 ', ' 连接
  const artistNames = [];
  for (const s of namev1.songs) {
    const arList = s.ar || [];
    if (arList.length > 0) artistNames.push(arList.map((ar) => ar.name).join('/'));
  }
  const songArname = artistNames.join(', ');

  if (type === 'text') {
    const text =
      '歌曲名称：' + songName +
      '<br>歌曲图片：' + songPic +
      '<br>歌手：' + songArname +
      '<br>歌曲专辑：' + songAlname +
      '<br>歌曲音质：' + musicLevelLabel(firstData.level) +
      '<br>歌曲大小：' + formatSize(firstData.size) +
      '<br>音乐地址：' + songUrl;
    return new Response(text, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    });
  }

  if (type === 'down') {
    return new Response(null, {
      status: 302,
      headers: { Location: songUrl, 'Access-Control-Allow-Origin': '*' },
    });
  }

  // 默认 json
  return jsonOut({
    status: 200,
    name: songName,
    pic: songPic,
    ar_name: songArname,
    al_name: songAlname,
    level: musicLevelLabel(firstData.level),
    size: formatSize(firstData.size),
    url: String(songUrl).replace('http://', 'https://'),
    lyric: lyricv1?.lrc?.lyric ?? '',
    tlyric: lyricv1?.tlyric?.lyric ?? null,
  });
}
