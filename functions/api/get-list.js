/**
 * /functions/api/get-list.js
 * Cloudflare Pages Function — 列出腾讯云 COS 对象，并为每个文件生成预签名下载链接
 *
 * 依赖环境变量:
 *   COS_SECRET_ID     — 腾讯云 SecretId
 *   COS_SECRET_KEY    — 腾讯云 SecretKey
 *   COS_BUCKET        — 存储桶名称，如 my-bucket-1250000000
 *   COS_REGION        — 地域，如 ap-guangzhou
 *   COS_CUSTOM_DOMAIN — 自定义域名，如 cdn.gxweb.top（不含协议头）
 *
 * 前置条件: _middleware.js 已完成 JWT 鉴权，此处不再重复校验。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数：ArrayBuffer / Hex / Base64 互转
// ─────────────────────────────────────────────────────────────────────────────

/** ArrayBuffer → 小写十六进制字符串 */
function bufToHex(buf) {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 字符串 → Uint8Array (UTF-8) */
function strToBytes(str) {
  return new TextEncoder().encode(str);
}

// ─────────────────────────────────────────────────────────────────────────────
// 核心：腾讯云 COS HMAC-SHA1 签名生成
// 文档参考：https://cloud.tencent.com/document/product/436/7778
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 使用 Web Crypto API 计算 HMAC-SHA1
 * @param {string} keyStr  密钥字符串
 * @param {string} message 待签名消息
 * @returns {Promise<string>} 小写十六进制签名
 */
async function hmacSha1Hex(keyStr, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    strToBytes(keyStr),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, strToBytes(message));
  return bufToHex(sig);
}

/**
 * 生成腾讯云 COS 请求签名（Authorization 头部值）
 *
 * ⚠️  关于编码规则（对照 COS FormatString 文档）：
 *   - pathname      : 传入【原始未编码】的 key，如 "/DIY软件/贪吃蛇/file.exe"
 *                     COS FormatString 中路径就是原始 UTF-8，不做 %xx 编码
 *   - header key    : encodeURIComponent 后转小写
 *   - header value  : encodeURIComponent（host 值碰巧无影响，但含特殊字符时必须编码）
 *   - param key     : encodeURIComponent 后转小写
 *   - param value   : encodeURIComponent
 *
 * @param {object} opts
 * @param {string} opts.secretId
 * @param {string} opts.secretKey
 * @param {string} opts.method        HTTP 方法，小写，如 "get"
 * @param {string} opts.pathname      【原始未编码】请求路径，如 "/DIY软件/file.exe" 或 "/"
 * @param {Record<string,string>} opts.headers  参与签名的请求头（key 需小写）
 * @param {Record<string,string>} opts.params   URL 查询参数（key 需小写）
 * @param {number}  opts.startTime    Unix 时间戳（秒）
 * @param {number}  opts.endTime      Unix 时间戳（秒）
 * @returns {Promise<string>} Authorization 字段完整值
 */
async function generateCosSignature({
  secretId,
  secretKey,
  method,
  pathname,
  headers = {},
  params = {},
  startTime,
  endTime,
}) {
  // Step 1 — KeyTime
  const keyTime = `${startTime};${endTime}`;

  // Step 2 — SignKey = HMAC-SHA1(SecretKey, KeyTime)
  const signKey = await hmacSha1Hex(secretKey, keyTime);

  // Step 3 — HttpString
  // COS 规范：key 做 encodeURIComponent 并转小写；value 做 encodeURIComponent
  // 然后按 key 字典序排列，用 & 连接
  const sortedHeaderKeys = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const sortedParamKeys = Object.keys(params)
    .map((k) => k.toLowerCase())
    .sort();

  const headerStr = sortedHeaderKeys
    .map(
      (k) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(headers[k] ?? headers[k.toUpperCase()] ?? "")}`
    )
    .join("&");

  const paramStr = sortedParamKeys
    .map(
      (k) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(params[k] ?? "")}`
    )
    .join("&");

  // ✅ pathname 直接使用原始未编码路径（与 COS FormatString 一致）
  const httpString = [
    method.toLowerCase(),
    pathname,       // 原始路径，如 "/DIY软件/贪吃蛇/file.exe"
    paramStr,
    headerStr,
    "",
  ].join("\n");

  // Step 4 — StringToSign
  const sha1Hash = bufToHex(
    await crypto.subtle.digest("SHA-1", strToBytes(httpString))
  );
  const stringToSign = ["sha1", keyTime, sha1Hash, ""].join("\n");

  // Step 5 — Signature = HMAC-SHA1(SignKey, StringToSign)
  const signature = await hmacSha1Hex(signKey, stringToSign);

  // Step 6 — Authorization 拼装
  const signedHeaderKeys = sortedHeaderKeys.join(";");
  const signedParamKeys = sortedParamKeys.join(";");

  return (
    `q-sign-algorithm=sha1` +
    `&q-ak=${secretId}` +
    `&q-sign-time=${keyTime}` +
    `&q-key-time=${keyTime}` +
    `&q-header-list=${signedHeaderKeys}` +
    `&q-url-param-list=${signedParamKeys}` +
    `&q-signature=${signature}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 生成预签名下载 URL（Pre-signed URL）
// 将签名放在查询参数中，不需要 Authorization 头，有效期由 q-sign-time 控制
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 为单个对象生成预签名 GET URL
 *
 * 签名用原始 key（不编码），实际 URL 中路径按段编码（保留 /）
 *
 * @param {object} opts
 * @param {string} opts.secretId
 * @param {string} opts.secretKey
 * @param {string} opts.customDomain  如 cdn.gxweb.top（不含 https://）
 * @param {string} opts.key           对象的原始 Key，如 "DIY软件/贪吃蛇/file.exe"
 * @param {number} opts.ttl           有效期（秒），默认 1800
 * @returns {Promise<string>} 完整预签名 URL
 */
async function generatePresignedUrl({
  secretId,
  secretKey,
  customDomain,
  key,
  ttl = 1800,
}) {
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - 60;
  const endTime = now + ttl;

  // 签名用原始路径（UTF-8，不做 %xx 编码）
  const rawPathname = "/" + key;

  // 实际 URL 中路径按段编码，保留 "/"
  const encodedPathname =
    "/" +
    key
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");

  // ✅ 强制下载：response-content-disposition 必须同时出现在签名参数和 URL 查询串中
  // 文件名取 key 最后一段，encodeURIComponent 处理中文/特殊字符
  const filename = key.split("/").pop();
  const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;

  // 参与签名的查询参数（key 小写，字典序）
  const signParams = {
    "response-content-disposition": disposition,
  };

  const signHeaders = { host: customDomain };

  const auth = await generateCosSignature({
    secretId,
    secretKey,
    method: "get",
    pathname: rawPathname,
    headers: signHeaders,
    params: signParams,
    startTime,
    endTime,
  });

  // 构造最终 URL：编码路径 + disposition 参数 + 签名
  const dispositionEncoded = encodeURIComponent(disposition);
  return (
    `https://${customDomain}${encodedPathname}` +
    `?response-content-disposition=${dispositionEncoded}` +
    `&${auth}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 轻量 XML 解析：从 COS ListBucketResult 中提取文件列表
// Workers 环境无 DOMParser，改用正则
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析 COS ListBucketResult XML，返回对象数组
 * @param {string} xml
 * @returns {{ key: string, size: number, lastModified: string }[]}
 */
function parseListBucketXml(xml) {
  const files = [];
  // 每个 <Contents> 块
  const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;
  while ((match = contentsRe.exec(xml)) !== null) {
    const block = match[1];
    const key = extractTag(block, "Key");
    const size = extractTag(block, "Size");
    const lastModified = extractTag(block, "LastModified");
    if (key) {
      files.push({
        key,
        size: size ? parseInt(size, 10) : 0,
        lastModified: lastModified || "",
      });
    }
  }
  return files;
}

/**
 * 从 XML 片段中提取第一个匹配标签的文本内容，并反转义 XML 实体
 * COS 会对 Key 中的 ' & < > " 做实体编码，必须还原后才能用于签名
 */
function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const m = re.exec(xml);
  if (!m) return null;
  return unescapeXml(m[1].trim());
}

/** 反转义 XML 实体 → 原始字符串 */
function unescapeXml(str) {
  return str
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ─────────────────────────────────────────────────────────────────────────────
// 分页列举 COS 对象（处理超过 1000 个对象的情况）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 列举存储桶内所有对象（自动翻页）
 * @param {object} env  Cloudflare 环境变量
 * @param {string} [prefix]  可选前缀过滤
 * @returns {Promise<{ key: string, size: number, lastModified: string }[]>}
 */
async function listAllObjects(env, prefix = "") {
  const { COS_SECRET_ID, COS_SECRET_KEY, COS_CUSTOM_DOMAIN } = env;
  const allFiles = [];
  let marker = "";
  let isTruncated = true;

  while (isTruncated) {
    // 构造查询参数
    const params = { "max-keys": "1000" };
    if (prefix) params["prefix"] = prefix;
    if (marker) params["marker"] = marker;

    // 参数 key 排序后构造查询字符串（用于签名和请求）
    const sortedParamKeys = Object.keys(params).sort();
    const queryString = sortedParamKeys
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join("&");

    const now = Math.floor(Date.now() / 1000);
    const startTime = now - 60;
    const endTime = now + 900; // list 操作签名有效期 15 分钟

    const signHeaders = { host: COS_CUSTOM_DOMAIN };

    // params key 已经是小写（max-keys, prefix, marker 均为小写）
    // 直接传入，generateCosSignature 内部会再做一次 toLowerCase 保险
    const auth = await generateCosSignature({
      secretId: COS_SECRET_ID,
      secretKey: COS_SECRET_KEY,
      method: "get",
      pathname: "/",          // 列举请求路径固定为 "/"，无需编码
      headers: signHeaders,
      params,                 // { "max-keys": "1000", ... }
      startTime,
      endTime,
    });

    const url = `https://${COS_CUSTOM_DOMAIN}/?${queryString}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Host: COS_CUSTOM_DOMAIN,
        Authorization: auth,
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(
        `COS ListObjects failed: HTTP ${response.status} — ${errText}`
      );
    }

    const xml = await response.text();

    // 解析文件列表
    const files = parseListBucketXml(xml);
    allFiles.push(...files);

    // 判断是否还有下一页
    const truncatedMatch = /<IsTruncated>([\s\S]*?)<\/IsTruncated>/.exec(xml);
    isTruncated =
      truncatedMatch && truncatedMatch[1].trim().toLowerCase() === "true";

    if (isTruncated) {
      // 下一页起始 marker = 当前页最后一个 Key
      const nextMarkerMatch = /<NextMarker>([\s\S]*?)<\/NextMarker>/.exec(xml);
      if (nextMarkerMatch) {
        marker = nextMarkerMatch[1].trim();
      } else if (files.length > 0) {
        marker = files[files.length - 1].key;
      } else {
        break; // 防止死循环
      }
    }
  }

  return allFiles;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare Pages Function 入口
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestGet({ request, env }) {
  // 解析可选查询参数：?prefix=xxx
  const url = new URL(request.url);
  const prefix = url.searchParams.get("prefix") || "";

  try {
    // 1. 列举对象
    const rawFiles = await listAllObjects(env, prefix);

    // 2. 过滤掉"目录占位符"（Key 以 / 结尾、Size 为 0 通常是伪目录）
    const files = rawFiles.filter((f) => !f.key.endsWith("/"));

    // 3. 为每个文件生成预签名下载链接（30 分钟有效期）
    const result = await Promise.all(
      files.map(async (f) => {
        const downloadUrl = await generatePresignedUrl({
          secretId: env.COS_SECRET_ID,
          secretKey: env.COS_SECRET_KEY,
          customDomain: env.COS_CUSTOM_DOMAIN,
          key: f.key,
          ttl: 1800, // 30 分钟
        });

        return {
          key: f.key,
          // 取文件名（最后一段路径）
          name: f.key.split("/").pop(),
          size: f.size,
          lastModified: f.lastModified,
          downloadUrl, // 预签名链接，不含任何服务端密钥
        };
      })
    );

    return new Response(JSON.stringify({ success: true, files: result }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // 短暂缓存：列表数据 30 秒内可复用，但不超过预签名链接有效期
        "Cache-Control": "private, max-age=30",
      },
    });
  } catch (err) {
    console.error("[get-list] Error:", err);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

// 拒绝非 GET 方法
export async function onRequest({ request, next }) {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }
  return next();
}