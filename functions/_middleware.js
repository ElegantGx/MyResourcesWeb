const PUBLIC_PATHS = [
    "/login",
    "/assets/",
    "/__clerk",
    "/cdn-cgi/",
];

export async function onRequest(context) {
    const { request, env, next } = context;
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (isPublicPath(pathname)) {
        return next();
    }
    const sessionToken = extractSessionToken(request.headers.get("Cookie"));
    if (!sessionToken) {
        return redirectToLogin(url);
    }
    try {
        const pemPublicKey = env.CLERK_PEM_PUBLIC_KEY;
        if (!pemPublicKey) {
            return new Response("服务器配置错误：缺少 CLERK_PEM_PUBLIC_KEY", {
            status: 500,
            });
        }
        const payload = await verifyJWT(sessionToken, pemPublicKey);
        return next();
    } catch (err) {
        console.error("[Middleware] JWT 验证失败:", err.message);
        console.log(`[Middleware Check] 触发重定向判定! 路径: ${pathname}, 原因: ${err.message}`);
        const isExpired = err.message.includes("EXPIRED");
        if (isExpired) {
            return redirectToLogin(url, false);
        }
        return redirectToLogin(url, true);
    }
}

function isPublicPath(pathname) {
    return PUBLIC_PATHS.some((publicPath) => pathname.startsWith(publicPath));
}

function extractSessionToken(cookieHeader) {
    if (!cookieHeader) return null;
    const cookies = cookieHeader.split(";").map((c) => c.trim());
    for (const cookie of cookies) {
        const [name, ...rest] = cookie.split("=");
        if (name.trim() === "__session") {
            return rest.join("=").trim();
        }
    }
    return null; 
}

async function verifyJWT(token, pemKey) {
    const parts = token.split(".");
    if (parts.length !== 3) {
        throw new Error("JWT 格式错误：应包含三段");
    }
    const [headerB64, payloadB64, signatureB64] = parts;
    const payload = JSON.parse(base64UrlDecode(payloadB64));
    const now = Math.floor(Date.now() / 1000);
    const LEEWAY = 120; 
    if (payload.exp && (payload.exp + LEEWAY) < now) {
        throw new Error(`EXPIRED: JWT 过期(exp: ${payload.exp}, now: ${now}), leeway: ${LEEWAY})`);
    }
    const cryptoKey = await importPublicKey(pemKey);
    const encoder = new TextEncoder();
    const dataToVerify = encoder.encode(`${headerB64}.${payloadB64}`);
    const signatureBytes = base64UrlToArrayBuffer(signatureB64);
    const isValid = await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" }, 
        cryptoKey,
        signatureBytes,
        dataToVerify
    );
    if (!isValid) {
        throw new Error("JWT 签名验证失败");
    }
    return payload; 
}

async function importPublicKey(pem) {
    const pemBody = pem
        .replace(/-----BEGIN PUBLIC KEY-----/g, "")
        .replace(/-----END PUBLIC KEY-----/g, "")
        .replace(/\s+/g, "");
    const binaryDer = atob(pemBody);
    const buffer = new ArrayBuffer(binaryDer.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < binaryDer.length; i++) {
        view[i] = binaryDer.charCodeAt(i);
    }
    return crypto.subtle.importKey(
        "spki",
        buffer,
        {
        name: "RSASSA-PKCS1-v1_5",
        hash: { name: "SHA-256" }, 
        },
        false,
        ["verify"]
    );
}

function base64UrlDecode(str) {
    const base64 = str
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(str.length + ((4 - (str.length % 4)) % 4), "=");
    return atob(base64);
}

function base64UrlToArrayBuffer(str) {
    const binaryString = base64UrlDecode(str);
    const buffer = new ArrayBuffer(binaryString.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < binaryString.length; i++) {
        view[i] = binaryString.charCodeAt(i);
    }
    return buffer;
}

function redirectToLogin(originalUrl, clearCookie = false) {
    const loginUrl = new URL("/login", originalUrl.origin);
    loginUrl.searchParams.set("redirect_url", originalUrl.pathname);
    const response = Response.redirect(loginUrl.toString(), 302);
    if (clearCookie) {
        const headers = new Headers(response.headers);
        headers.append(
            "Set-Cookie",
            "__session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax"
        );
        return new Response(null, {
            status: 302,
            headers,
        });
    }
    return response;
}
