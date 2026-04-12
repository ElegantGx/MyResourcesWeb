function bufToHex(buf) {
    return [...new Uint8Array(buf)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

function strToBytes(str) {
    return new TextEncoder().encode(str);
}

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

async function generateCosSignature({
    secretId,
    secretKey,
    method,
    pathname,
    headers = {},
    params = {},
    startTime,
    endTime,
}) 
{
    const keyTime = `${startTime};${endTime}`;
    const signKey = await hmacSha1Hex(secretKey, keyTime);
    const sortedHeaderKeys = Object.keys(headers).sort();
    const sortedParamKeys = Object.keys(params).sort();
    const headerStr = sortedHeaderKeys
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(headers[k])}`)
        .join("&");
    const paramStr = sortedParamKeys
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
        .join("&");
    const httpString = [
        method.toLowerCase(),
        pathname,
        paramStr,
        headerStr,
        "",
    ].join("\n");
    const sha1Hash = bufToHex(
        await crypto.subtle.digest("SHA-1", strToBytes(httpString))
    );
    const stringToSign = ["sha1", keyTime, sha1Hash, ""].join("\n");
    const signature = await hmacSha1Hex(signKey, stringToSign);
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

async function generatePresignedUrl({
    secretId,
    secretKey,
    customDomain,
    key,
    ttl = 1800,
}) 
{
    const now = Math.floor(Date.now() / 1000);
    const startTime = now - 60; // 允许 60 秒时钟偏差
    const endTime = now + ttl;
    const encodedKey =
        "/" +
        key
            .split("/")
            .map((seg) => encodeURIComponent(seg))
            .join("/");
    const signHeaders = { host: customDomain };
    const auth = await generateCosSignature({
        secretId,
        secretKey,
        method: "get",
        pathname: encodedKey,
        headers: signHeaders,
        params: {},
        startTime,
        endTime,
    });
    return `https://${customDomain}${encodedKey}?${auth}`;
}

function parseListBucketXml(xml) {
    const files = [];
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

function extractTag(xml, tag) {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
    const m = re.exec(xml);
    return m ? m[1].trim() : null;
}

async function listAllObjects(env, prefix = "") {
    const { COS_SECRET_ID, COS_SECRET_KEY, COS_CUSTOM_DOMAIN } = env;
    const allFiles = [];
    let marker = "";
    let isTruncated = true;
    while (isTruncated) {
        const params = { "max-keys": "1000" };
        if (prefix) params["prefix"] = prefix;
        if (marker) params["marker"] = marker;
        const sortedParamKeys = Object.keys(params).sort();
        const queryString = sortedParamKeys
            .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
            .join("&");

        const now = Math.floor(Date.now() / 1000);
        const startTime = now - 60;
        const endTime = now + 900; // list 操作签名有效期 15 分钟
        const signHeaders = { host: COS_CUSTOM_DOMAIN };
        const lowerParams = {};
        sortedParamKeys.forEach((k) => {
            lowerParams[k.toLowerCase()] = params[k];
        });

        const auth = await generateCosSignature({
            secretId: COS_SECRET_ID,
            secretKey: COS_SECRET_KEY,
            method: "get",
            pathname: "/",
            headers: signHeaders,
            params: lowerParams,
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
        const files = parseListBucketXml(xml);
        allFiles.push(...files);
        const truncatedMatch = /<IsTruncated>([\s\S]*?)<\/IsTruncated>/.exec(xml);
        isTruncated =
            truncatedMatch && truncatedMatch[1].trim().toLowerCase() === "true";

        if (isTruncated) {
            const nextMarkerMatch = /<NextMarker>([\s\S]*?)<\/NextMarker>/.exec(xml);
            if (nextMarkerMatch) {
                marker = nextMarkerMatch[1].trim();
            } else if (files.length > 0) {
                marker = files[files.length - 1].key;
            } else {
                break;
            }
        }
    }
    return allFiles;
}

export async function onRequestGet({ request, env }) {
    const url = new URL(request.url);
    const prefix = url.searchParams.get("prefix") || "";

    try {
        const rawFiles = await listAllObjects(env, prefix);
        const files = rawFiles.filter((f) => !f.key.endsWith("/"));
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
                    name: f.key.split("/").pop(),
                    size: f.size,
                    lastModified: f.lastModified,
                    downloadUrl,
                };
            })
        );

        return new Response(JSON.stringify({ success: true, files: result }), {
            status: 200,
            headers: {
                "Content-Type": "application/json",
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

export async function onRequest({ request, next }) {
    if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
            status: 405,
            headers: { "Content-Type": "application/json" },
        });
    }
    return next();
}