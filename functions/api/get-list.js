/**
 * /functions/api/get-list.js
 * Cloudflare Pages Function — 列出腾讯云 COS 文件并生成预签名下载链接
 *
 * 依赖环境变量：
 *   COS_SECRET_ID     — 腾讯云 SecretId
 *   COS_SECRET_KEY    — 腾讯云 SecretKey（不会暴露给前端）
 *   COS_BUCKET        — 存储桶名，如 myapp-1250000000
 *   COS_REGION        — 地域，如 ap-guangzhou
 *   COS_CUSTOM_DOMAIN — 自定义域名，如 cdn.gxweb.top
 *
 * 前置条件：
 *   _middleware.js 已完成 JWT (Clerk) 鉴权，此函数无需再做身份验证。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数：ArrayBuffer <-> Hex / Base64
// ─────────────────────────────────────────────────────────────────────────────

/** ArrayBuffer → 小写十六进制字符串 */
function bufToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 字符串 → ArrayBuffer (UTF-8) */
function strToBuf(str) {
  return new TextEncoder().encode(str);
}

// ─────────────────────────────────────────────────────────────────────────────
// HMAC-SHA1 via Web Crypto API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 计算 HMAC-SHA1
 * @param {string} keyStr  密钥（字符串）或 hex 字符串（当 isHex=true）
 * @param {string} message 待签名消息
 * @param {boolean} isHex  keyStr 是否为 hex 编码的密钥（第二轮签名用）
 * @returns {Promise<ArrayBuffer>}
 */
async function hmacSha1(keyStr, message, isHex = false) {
  let keyBuf;
  if (isHex) {
    // hex 字符串 → Uint8Array
    const bytes = new Uint8Array(keyStr.length / 2);
    for (let i = 0; i < keyStr.length; i += 2) {
      bytes[i / 2] = parseInt(keyStr.slice(i, i + 2), 16);
    }
    keyBuf = bytes.buffer;
  } else {
    keyBuf = strToBuf(keyStr);
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", key, strToBuf(message));
}

// ─────────────────────────────────────────────────────────────────────────────
// 腾讯云 COS 签名 v5（Authorization Header 方式）
// 文档：https://cloud.tencent.com/document/product/436/7778
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 生成腾讯云 COS 请求签名（Authorization 头）
 *
 * @param {object} opts
 * @param {string} opts.secretId
 * @param {string} opts.secretKey
 * @param {string} opts.method       HTTP 方法，大小写不限，内部自动转小写
 * @param {string} opts.pathname     URL 路径，如 "/"
 * @param {object} opts.query        查询参数键值对（均为字符串）
 * @param {object} opts.headers      参与签名的请求头键值对（键需小写）
 * @param {number} opts.startTime    Unix 秒（签名起始时间）
 * @param {number} opts.endTime      Unix 秒（签名结束时间）
 * @returns {Promise<string>}        完整的 Authorization 字段值
 */
async function generateCosSignature({
  secretId,
  secretKey,
  method,
  pathname,
  query = {},
  headers = {},
  startTime,
  endTime,
}) {
  // ① KeyTime
  const keyTime = `${startTime};${endTime}`;

  // ② SignKey = HMAC-SHA1(SecretKey, KeyTime)  →  hex
  const signKeyBuf = await hmacSha1(secretKey, keyTime, false);
  const signKey = bufToHex(signKeyBuf);

  // ③ HttpMethod（小写）
  const httpMethod = method.toLowerCase();

  // ④ UrlParamList + HttpParameters
  //    键名小写、字典序排列、encodeURIComponent 编码（RFC3986）
  const queryEntries = Object.entries(query).map(([k, v]) => [
    k.toLowerCase(),
    v,
  ]);
  queryEntries.sort(([a], [b]) => a.localeCompare(b));
  const urlParamList = queryEntries.map(([k]) => k).join(";");
  const httpParameters = queryEntries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
    .join("&");

  // ⑤ HeaderList + HttpHeaders
  const headerEntries = Object.entries(headers).map(([k, v]) => [
    k.toLowerCase(),
    v,
  ]);
  headerEntries.sort(([a], [b]) => a.localeCompare(b));
  const headerList = headerEntries.map(([k]) => k).join(";");
  const httpHeaders = headerEntries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
    .join("&");

  // ⑥ HttpString（注意末尾有一个空行，即以 \n 结束）
  const httpString = `${httpMethod}\n${pathname}\n${httpParameters}\n${httpHeaders}\n`;

  // ⑦ StringToSign
  const httpStringSha1Buf = await crypto.subtle.digest(
    "SHA-1",
    strToBuf(httpString)
  );
  const httpStringSha1 = bufToHex(httpStringSha1Buf);
  const stringToSign = `sha1\n${keyTime}\n${httpStringSha1}\n`;

  // ⑧ Signature = HMAC-SHA1(SignKey, StringToSign)  →  hex
  //    注意：第二步 SignKey 已经是 hex 字符串，需作为原始字节使用
  const signatureBuf = await hmacSha1(signKey, stringToSign, true);
  const signature = bufToHex(signatureBuf);

  // ⑨ 拼装 Authorization
  return (
    `q-sign-algorithm=sha1` +
    `&q-ak=${secretId}` +
    `&q-sign-time=${keyTime}` +
    `&q-key-time=${keyTime}` +
    `&q-header-list=${headerList}` +
    `&q-url-param-list=${urlParamList}` +
    `&q-signature=${signature}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 生成预签名下载 URL（Pre-signed URL，签名放在 Query String 中）
// 强制 Content-Disposition: attachment，触发下载而非预览
// 有效期 30 分钟
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.secretId
 * @param {string} opts.secretKey
 * @param {string} opts.customDomain  如 cdn.gxweb.top
 * @param {string} opts.key           对象键，如 "videos/demo.mp4"
 * @param {number} [opts.ttlSeconds]  有效期（秒），默认 1800（30 分钟）
 * @returns {Promise<string>}         完整预签名 URL
 */
async function generatePresignedUrl({
  secretId,
  secretKey,
  customDomain,
  key,
  ttlSeconds = 1800,
}) {
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - 60; // 向前偏移 60 秒，容忍时钟偏差
  const endTime = now + ttlSeconds;

  // 对象键作为 URL 路径，需以 "/" 开头，同时对路径各段分别编码
  const pathname =
    "/" +
    key
      .replace(/^\/+/, "")
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");

  // 强制下载文件名（RFC 5987 UTF-8 编码，处理中文/空格等特殊字符）
  const filename = key.split("/").pop();
  const encodedFilename = encodeURIComponent(filename);
  const disposition = `attachment; filename*=UTF-8''${encodedFilename}`;

  // 参与签名的 query 参数（response-* 参数必须参与签名）
  const signedQuery = {
    "response-content-disposition": disposition,
  };

  // 计算签名（Pre-signed URL 签名不包含请求头，headerList 为空字符串）
  const authorization = await generateCosSignature({
    secretId,
    secretKey,
    method: "get",
    pathname: "/" + key.replace(/^\/+/, ""), // 签名用未编码路径
    query: signedQuery,
    headers: {}, // Pre-signed URL 不对 headers 签名
    startTime,
    endTime,
  });

  // 构建最终 URL：签名参数 + 业务参数合并
  // authorization 本身是 key=val&key=val 形式，直接拼接到 URL
  const businessParams = new URLSearchParams({
    "response-content-disposition": disposition,
  }).toString();

  return (
    `https://${customDomain}${pathname}` +
    `?${authorization}&${businessParams}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 轻量 XML 解析：从 COS ListObjectsV2 响应提取文件信息
// Workers 环境无 DOMParser，使用正则处理
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 COS XML 响应中提取 <Contents> 列表
 * @param {string} xml
 * @returns {{ key: string, size: number, lastModified: string }[]}
 */
function parseListObjectsXml(xml) {
  const items = [];
  const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let block;
  while ((block = contentsRe.exec(xml)) !== null) {
    const inner = block[1];
    const key = (inner.match(/<Key>([\s\S]*?)<\/Key>/) ?? [])[1] ?? "";
    const size = parseInt(
      (inner.match(/<Size>([\s\S]*?)<\/Size>/) ?? [])[1] ?? "0",
      10
    );
    const lastModified =
      (inner.match(/<LastModified>([\s\S]*?)<\/LastModified>/) ?? [])[1] ?? "";

    // 跳过纯目录占位对象（Key 以 / 结尾且 Size 为 0）
    if (key.endsWith("/") && size === 0) continue;

    items.push({ key, size, lastModified });
  }
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare Pages Function 入口
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { request, env } = context;

  // 只接受 GET 请求
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 读取环境变量
  const secretId = env.COS_SECRET_ID;
  const secretKey = env.COS_SECRET_KEY;
  const bucket = env.COS_BUCKET;           // e.g. myapp-1250000000
  const region = env.COS_REGION;           // e.g. ap-guangzhou（备用，当前未直接使用）
  const customDomain = env.COS_CUSTOM_DOMAIN; // e.g. cdn.gxweb.top

  if (!secretId || !secretKey || !bucket || !region || !customDomain) {
    return new Response(
      JSON.stringify({ error: "Server misconfiguration: missing env vars" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // 可选查询参数：prefix（模拟目录）、max（每页数量上限）
  const reqUrl = new URL(request.url);
  const prefix = reqUrl.searchParams.get("prefix") ?? "";
  const maxKeys = Math.min(
    parseInt(reqUrl.searchParams.get("max") ?? "200", 10),
    1000
  );

  try {
    // ── 步骤 1：构造 COS List Objects V2 请求 ─────────────────────────────

    const cosHost = customDomain; // 使用绑定的自定义域名
    const pathname = "/";
    const now = Math.floor(Date.now() / 1000);
    const startTime = now - 60;
    const endTime = now + 900; // List 签名有效 15 分钟

    // 构造查询参数
    const query = {
      "list-type": "2",
      "max-keys": String(maxKeys),
    };
    if (prefix) query["prefix"] = prefix;

    // 参与签名的请求头（Host 必须签名）
    const signedHeaders = { host: cosHost };

    const authorization = await generateCosSignature({
      secretId,
      secretKey,
      method: "get",
      pathname,
      query,
      headers: signedHeaders,
      startTime,
      endTime,
    });

    // 拼接完整请求 URL
    const cosUrl = `https://${cosHost}${pathname}?${new URLSearchParams(query).toString()}`;

    // ── 步骤 2：请求 COS ──────────────────────────────────────────────────

    const cosResp = await fetch(cosUrl, {
      method: "GET",
      headers: {
        Host: cosHost,
        Authorization: authorization,
      },
    });

    if (!cosResp.ok) {
      const errBody = await cosResp.text();
      console.error("[get-list] COS returned error:", cosResp.status, errBody);
      return new Response(
        JSON.stringify({ error: "Failed to fetch file list from COS" }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const xmlText = await cosResp.text();

    // ── 步骤 3：解析 XML ──────────────────────────────────────────────────

    const rawItems = parseListObjectsXml(xmlText);

    // ── 步骤 4：为每个文件生成预签名下载链接 ─────────────────────────────

    const files = await Promise.all(
      rawItems.map(async (item) => {
        const downloadUrl = await generatePresignedUrl({
          secretId,
          secretKey,
          customDomain,
          key: item.key,
          ttlSeconds: 1800, // 30 分钟
        });

        const filename = item.key.split("/").pop();
        const ext = filename.includes(".")
          ? filename.split(".").pop().toLowerCase()
          : "";

        // 脱敏输出：只返回必要字段，不泄露 SecretKey、完整 bucket 信息
        return {
          key: item.key,      // 对象完整路径（前端可用于再次请求）
          filename,           // 纯文件名
          ext,                // 扩展名（方便前端图标渲染）
          size: item.size,    // 字节数
          lastModified: item.lastModified, // ISO 8601
          downloadUrl,        // 预签名链接，30 分钟有效，强制下载
        };
      })
    );

    // ── 步骤 5：返回 JSON ─────────────────────────────────────────────────

    return new Response(
      JSON.stringify({ files, total: files.length }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          // 不缓存响应，保证每次都拿到新鲜的预签名链接
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (err) {
    console.error("[get-list] Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: "Internal Server Error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
