/**
 * @Author: JH-Ahua
 * @CreateTime: 20250519
 * @Api: api.bugpk.com
 * @tip: 网易云音乐解析
 * @Remark: 已由 Python/Flask 版移植为 EdgeOne Makers 边缘函数版（逻辑原样保留）：
 *          - 省略 Flask HTML 输出分支，统一返回 JSON（text 分支以 {status,type,text} 包装，
 *            down 分支以 {status,type,url} 包装，信息无损失）
 *          - eapi 签名加密为 AES-128-ECB（Web Crypto 不支持 ECB，自实现纯 JS AES），
 *            MD5 为自实现纯 JS 版本
 *          - Cookie 逻辑与 Python 版一致：默认 MUSIC_U 空值 cookie
 */
const CORS_HEADERS = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type",
}

function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {status: status || 200, headers: CORS_HEADERS});
}

// ==================== 纯 JS MD5（自实现，等价 Python hashlib.md5） ====================

function md5Bytes(bytes) {
    const S = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K = new Array(64);
    for (let i = 0; i < 64; i++) {
        K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
    }
    const len = bytes.length;
    const totalLen = (((len + 8) >> 6) + 1) * 64;
    const buf = new Uint8Array(totalLen);
    buf.set(bytes);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    const bitLen = len * 8;
    dv.setUint32(totalLen - 8, bitLen >>> 0, true);
    dv.setUint32(totalLen - 4, Math.floor(bitLen / 4294967296), true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const M = new Array(16);
    for (let off = 0; off < totalLen; off += 64) {
        for (let j = 0; j < 16; j++) {
            M[j] = dv.getUint32(off + j * 4, true);
        }
        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i++) {
            let F, g;
            if (i < 16) {
                F = (B & C) | (~B & D);
                g = i;
            } else if (i < 32) {
                F = (D & B) | (~D & C);
                g = (5 * i + 1) % 16;
            } else if (i < 48) {
                F = B ^ C ^ D;
                g = (3 * i + 5) % 16;
            } else {
                F = C ^ (B | ~D);
                g = (7 * i) % 16;
            }
            F = (F + A + K[i] + M[g]) >>> 0;
            A = D;
            D = C;
            C = B;
            B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
        }
        a0 = (a0 + A) >>> 0;
        b0 = (b0 + B) >>> 0;
        c0 = (c0 + C) >>> 0;
        d0 = (d0 + D) >>> 0;
    }
    const out = new Uint8Array(16);
    const odv = new DataView(out.buffer);
    odv.setUint32(0, a0, true);
    odv.setUint32(4, b0, true);
    odv.setUint32(8, c0, true);
    odv.setUint32(12, d0, true);
    return out;
}

function bytesToHex(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
        s += bytes[i].toString(16).padStart(2, "0");
    }
    return s;
}

// ==================== 纯 JS AES-128-ECB（Web Crypto 不支持 ECB，自实现） ====================

const AES_SBOX = [
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
];

const AES_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

// AES-128 密钥扩展：44 个 4 字节 word
function aesKeyExpansion(keyBytes) {
    const w = new Array(44);
    for (let i = 0; i < 4; i++) {
        w[i] = [keyBytes[4 * i], keyBytes[4 * i + 1], keyBytes[4 * i + 2], keyBytes[4 * i + 3]];
    }
    for (let i = 4; i < 44; i++) {
        let t = w[i - 1].slice();
        if (i % 4 === 0) {
            // RotWord + SubWord + Rcon
            t = [t[1], t[2], t[3], t[0]];
            for (let j = 0; j < 4; j++) {
                t[j] = AES_SBOX[t[j]];
            }
            t[0] ^= AES_RCON[i / 4 - 1];
        }
        w[i] = [w[i - 4][0] ^ t[0], w[i - 4][1] ^ t[1], w[i - 4][2] ^ t[2], w[i - 4][3] ^ t[3]];
    }
    return w;
}

// GF(2^8) 乘 2
function aesXtime(a) {
    return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff;
}

function aesShiftRows(s) {
    // 行 1 左移 1
    let t;
    t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
    // 行 2 左移 2
    t = s[2]; s[2] = s[10]; s[10] = t;
    t = s[6]; s[6] = s[14]; s[14] = t;
    // 行 3 左移 3（即右移 1）
    t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
}

// 单块加密：block 为 16 字节，w 为扩展密钥；state 按列主序（s[4c+r]）
function aesEncryptBlock(block, w) {
    const s = new Array(16);
    for (let i = 0; i < 16; i++) {
        s[i] = block[i];
    }
    // 初始轮 AddRoundKey
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            s[4 * c + r] ^= w[c][r];
        }
    }
    for (let round = 1; round < 10; round++) {
        // SubBytes
        for (let i = 0; i < 16; i++) {
            s[i] = AES_SBOX[s[i]];
        }
        // ShiftRows
        aesShiftRows(s);
        // MixColumns
        for (let c = 0; c < 4; c++) {
            const a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
            s[4 * c] = aesXtime(a0) ^ (aesXtime(a1) ^ a1) ^ a2 ^ a3;
            s[4 * c + 1] = a0 ^ aesXtime(a1) ^ (aesXtime(a2) ^ a2) ^ a3;
            s[4 * c + 2] = a0 ^ a1 ^ aesXtime(a2) ^ (aesXtime(a3) ^ a3);
            s[4 * c + 3] = (aesXtime(a0) ^ a0) ^ a1 ^ a2 ^ aesXtime(a3);
        }
        // AddRoundKey
        for (let c = 0; c < 4; c++) {
            for (let r = 0; r < 4; r++) {
                s[4 * c + r] ^= w[4 * round + c][r];
            }
        }
    }
    // 末轮（无 MixColumns）
    for (let i = 0; i < 16; i++) {
        s[i] = AES_SBOX[s[i]];
    }
    aesShiftRows(s);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            s[4 * c + r] ^= w[40 + c][r];
        }
    }
    return Uint8Array.from(s);
}

// AES-128-ECB + PKCS7 填充，输出 hex（等价 Python cryptography AES/ECB 加密后 HexDigest）；导出以便自测
export function aes128EcbEncryptHex(keyStr, plaintext) {
    const keyBytes = new TextEncoder().encode(keyStr);
    const dataBytes = new TextEncoder().encode(plaintext);
    // PKCS7：长度恰为 16 倍数时仍追加整块填充（与 Python padding.PKCS7 一致）
    const padLen = 16 - (dataBytes.length % 16);
    const padded = new Uint8Array(dataBytes.length + padLen);
    padded.set(dataBytes);
    for (let i = dataBytes.length; i < padded.length; i++) {
        padded[i] = padLen;
    }
    const w = aesKeyExpansion(keyBytes);
    const out = new Uint8Array(padded.length);
    for (let i = 0; i < padded.length; i += 16) {
        out.set(aesEncryptBlock(padded.subarray(i, i + 16), w), i);
    }
    return bytesToHex(out);
}

// ==================== 等价 Python 辅助函数 ====================

function HexDigest(data) {
    return Array.from(data)
        .map((d) => d.toString(16).padStart(2, "0"))
        .join("");
}

function HashDigest(text) {
    return md5Bytes(new TextEncoder().encode(String(text)));
}

// 导出以便自测（边缘运行时亦可使用）
export function HashHexDigest(text) {
    return HexDigest(HashDigest(text));
}

// 等价 Python parse_cookie()
function parseCookie(text) {
    const out = {};
    for (const item of String(text).trim().split(";")) {
        if (!item) {
            continue;
        }
        const trimmed = item.trim();
        const idx = trimmed.indexOf("=");
        const k = (idx === -1 ? trimmed : trimmed.slice(0, idx)).trim();
        const v = idx === -1 ? "" : trimmed.slice(idx + 1).trim();
        out[k] = v;
    }
    return out;
}

// 等价 Python read_cookie()：默认 MUSIC_U 空值 cookie（cookie 以此格式填写）
function readCookie() {
    return "MUSIC_U=;os=pc;appver=8.9.75;";
}

// 等价 Python post()：eapi 表单请求（cookie 合并基础字段后拼入 Cookie 头）
async function eapiPost(url, params, cookie) {
    const headers = {
        "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/2.10.2.200154",
        referer: "",
        "content-type": "application/x-www-form-urlencoded",
    };
    const cookies = {os: "pc", appver: "", osver: "", deviceId: "pyncm!"};
    Object.assign(cookies, cookie);
    headers["cookie"] = Object.entries(cookies)
        .map(([k, v]) => k + "=" + v)
        .join("; ");
    const body = "params=" + encodeURIComponent(params);
    const resp = await fetch(url, {
        method: "POST",
        headers: headers,
        body: body,
        redirect: "follow",
        signal: timeoutSignal(30000),
    });
    return await resp.text();
}

// 等价 Python ids()：163cn.tv 短链取 Location，music.163.com 提取 id 参数
async function resolveId(input) {
    let ids = String(input === undefined || input === null ? "" : input);
    if (ids.indexOf("163cn.tv") !== -1) {
        try {
            const resp = await fetch(ids, {
                method: "GET",
                redirect: "manual",
                signal: timeoutSignal(30000),
            });
            ids = resp.headers.get("location") || "";
        } catch (e) {
            ids = "";
        }
    }
    if (ids.indexOf("music.163.com") !== -1) {
        const index = ids.indexOf("id=") + 3;
        ids = ids.slice(index).split("&")[0];
    }
    return ids;
}

// 等价 Python size()
function size(value) {
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let s = 1024.0;
    for (let i = 0; i < units.length; i++) {
        if (value / s < 1) {
            return value.toFixed(2) + units[i];
        }
        value = value / s;
    }
    return value;
}

// 等价 Python music_level1()
function musicLevel1(value) {
    const levels = {
        standard: "标准音质",
        exhigh: "极高音质",
        lossless: "无损音质",
        hires: "Hires音质",
        sky: "沉浸环绕声",
        jyeffect: "高清环绕声",
        jymaster: "超清母带",
    };
    return levels[value] !== undefined ? levels[value] : "未知音质";
}

// 等价 Python url_v1()：eapi 加密请求（AES-128-ECB + MD5 签名）
async function urlV1(id, level, cookies) {
    const url = "https://interface3.music.163.com/eapi/song/enhance/player/url/v1";
    const AES_KEY = "e82ckenh8dichen8"; // 16 字节
    const config = {
        os: "pc",
        appver: "",
        osver: "",
        deviceId: "pyncm!",
        requestId: String(20000000 + Math.floor(Math.random() * 10000000)), // 等价 randrange(20000000, 30000000)
    };

    const payload = {
        ids: [id],
        level: level,
        encodeType: "flac",
        header: JSON.stringify(config),
    };

    if (level === "sky") {
        payload.immerseType = "c51";
    }

    const url2 = "/eapi/song/enhance/player/url/v1".replace("/eapi/", "/api/");
    const digest = HashHexDigest("nobody" + url2 + "use" + JSON.stringify(payload) + "md5forencrypt");
    let params = url2 + "-36cd479b6b5-" + JSON.stringify(payload) + "-36cd479b6b5-" + digest;
    params = aes128EcbEncryptHex(AES_KEY, params);
    const responseText = await eapiPost(url, params, cookies);
    return JSON.parse(responseText);
}

// 等价 Python name_v1()：歌曲详情（不带 cookie）
async function nameV1(id) {
    const urls = "https://interface3.music.163.com/api/v3/song/detail";
    const body = "c=" + encodeURIComponent(JSON.stringify([{id: id, v: 0}]));
    const resp = await fetch(urls, {
        method: "POST",
        headers: {"content-type": "application/x-www-form-urlencoded"},
        body: body,
        redirect: "follow",
        signal: timeoutSignal(30000),
    });
    return await resp.json();
}

// 等价 Python lyric_v1()：歌词（带 cookie）
async function lyricV1(id, cookies) {
    const url = "https://interface3.music.163.com/api/song/lyric";
    const form = {id: String(id), cp: "false", tv: "0", lv: "0", rv: "0", kv: "0", yv: "0", ytv: "0", yrv: "0"};
    const body = new URLSearchParams(form).toString();
    const headers = {
        "content-type": "application/x-www-form-urlencoded",
        cookie: Object.entries(cookies)
            .map(([k, v]) => k + "=" + v)
            .join("; "),
    };
    const resp = await fetch(url, {
        method: "POST",
        headers: headers,
        body: body,
        redirect: "follow",
        signal: timeoutSignal(30000),
    });
    return await resp.json();
}

// 聚合入口：等价 Python Song_v1()，返回最终 JSON 对象
// opts.ids  - 对应原版 ids 参数（歌曲 ID 或链接），优先于 shareUrl
// opts.level - 音质（必填）
// opts.type  - 输出类型 text/down/json（必填）
export async function parse(shareUrl, env, opts = {}) {
    const songIds = opts.ids !== undefined && opts.ids !== null && String(opts.ids).trim() !== "" ? String(opts.ids) : "";
    const urlParam = String(shareUrl === undefined || shareUrl === null ? "" : shareUrl).trim();

    if (!songIds && !urlParam) {
        return {error: "必须提供 ids 或 url 参数"};
    }
    const level = opts.level;
    if (level === undefined || level === null || String(level) === "") {
        return {error: "level参数为空"};
    }
    const type = opts.type;
    if (type === undefined || type === null || String(type) === "") {
        return {error: "type参数为空"};
    }

    const jsondata = songIds || urlParam;
    const cookies = parseCookie(readCookie());
    const urlv1 = await urlV1(await resolveId(jsondata), level, cookies);
    const d0 = urlv1 && urlv1.data && urlv1.data[0] ? urlv1.data[0] : null;
    if (!d0) {
        // Python 版此处 KeyError -> 500；统一按信息不完整返回
        return {status: 400, msg: "信息获取不完整！"};
    }
    const namev1 = await nameV1(d0.id);
    const lyricv1 = await lyricV1(d0.id, cookies);

    let songUrl, songName, songPicUrl, songAlname, songArname;
    if (d0.url !== null && d0.url !== undefined) {
        if (namev1 && Array.isArray(namev1.songs) && namev1.songs.length > 0) {
            songUrl = d0.url;
            songName = namev1.songs[0].name;
            songPicUrl = namev1.songs[0].al.picUrl;
            songAlname = namev1.songs[0].al.name;
            const artistNames = [];
            for (const song of namev1.songs) {
                const arList = song.ar || [];
                if (arList.length > 0) {
                    artistNames.push(arList.map((ar) => ar.name).join("/"));
                }
            }
            songArname = artistNames.join(", ");
        } else {
            return {status: 400, msg: "信息获取不完整！"};
        }
    } else {
        return {status: 400, msg: "信息获取不完整！"};
    }

    if (type === "text") {
        // 原 Flask 版返回 text/html 文本；边缘版统一 JSON 包装，内容原样保留
        const text =
            "歌曲名称：" + songName +
            "<br>歌曲图片：" + songPicUrl +
            "<br>歌手：" + songArname +
            "<br>歌曲专辑：" + songAlname +
            "<br>歌曲音质：" + musicLevel1(d0.level) +
            "<br>歌曲大小：" + size(d0.size) +
            "<br>音乐地址：" + songUrl;
        return {status: 200, type: "text", text: text};
    } else if (type === "down") {
        // 原 Flask 版 302 重定向下载；边缘版统一 JSON，返回下载地址
        return {status: 200, type: "down", url: songUrl};
    } else if (type === "json") {
        return {
            status: 200,
            name: songName,
            pic: songPicUrl,
            ar_name: songArname,
            al_name: songAlname,
            level: musicLevel1(d0.level),
            size: size(d0.size),
            url: String(songUrl).replace("http://", "https://"),
            lyric: lyricv1 && lyricv1.lrc && lyricv1.lrc.lyric !== undefined ? lyricv1.lrc.lyric : null,
            tlyric: lyricv1 && lyricv1.tlyric && lyricv1.tlyric.lyric !== undefined ? lyricv1.tlyric.lyric : null,
        };
    } else {
        return {status: 400, msg: "解析失败！请检查参数是否完整！"};
    }
}

export async function onRequest(context) {
    const request = context.request;
    if (request.method === "OPTIONS") {
        return new Response(null, {status: 204, headers: CORS_HEADERS});
    }

    let ids = "", url = "", level = "", type = "";
    const u = new URL(request.url);

    if (request.method === "POST") {
        try {
            const ct = request.headers.get("content-type") || "";
            if (ct.includes("application/json")) {
                const body = await request.json();
                ids = body.ids !== undefined && body.ids !== null ? body.ids : "";
                url = body.url !== undefined && body.url !== null ? body.url : "";
                level = body.level !== undefined && body.level !== null ? body.level : "";
                type = body.type !== undefined && body.type !== null ? body.type : "";
            } else {
                const form = await request.formData();
                ids = form.get("ids") !== null ? form.get("ids") : "";
                url = form.get("url") !== null ? form.get("url") : "";
                level = form.get("level") !== null ? form.get("level") : "";
                type = form.get("type") !== null ? form.get("type") : "";
            }
        } catch (e) {
            // 忽略 body 解析失败
        }
    }

    if (!ids && !url) {
        ids = u.searchParams.get("ids") || "";
        url = u.searchParams.get("url") || "";
    }
    if (!level) {
        level = u.searchParams.get("level") || "";
    }
    if (!type) {
        type = u.searchParams.get("type") || "";
    }

    // ids 优先于 url（与 Python 版 jsondata = song_ids if song_ids else url 一致）
    const input = ids && String(ids).trim() !== "" ? String(ids) : String(url || "");

    try {
        const result = await parse(input, context.env, {ids: ids, level: level, type: type});
        // 与 Flask 版一致：错误（{error:...} 或 status:400）返回 HTTP 400
        const status = result && (result.error !== undefined || result.status === 400) ? 400 : 200;
        return jsonResponse(result, status);
    } catch (e) {
        // Python 版异常 -> Flask 500；统一 JSON
        return jsonResponse({status: 500, msg: "解析失败: " + (e && e.message ? e.message : "未知错误")}, 500);
    }
}

// ---------- 兼容性辅助：边缘函数运行时不支持 AbortSignal.timeout() ----------
function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), Number(ms) || 0);
  return controller.signal;
}
