import { createClerkClient } from "@clerk/backend";

export async function onRequest(context) {
    const { request, env, next } = context;
    const url = new URL(request.url);
    const pathname = url.pathname;
    
    if (pathname.startsWith("/login") || pathname.startsWith("/assets/")) {
        return next();
    }

    const clerkClient = createClerkClient({
        secretKey: env.CLERK_SECRET_KEY,
        publishableKey: env.CLERK_PUBLISHABLE_KEY,
    });

    try {
        const authResult = await clerkClient.authenticateRequest(request);
        switch(authResult.status) {
            case "signed-in":
                const response = await next();
                authResult.headers.forEach((value, key) => {
                    response.headers.append(key, value);
                });
                return response;
            
            case "handshake":
                return authResult.toResponse();
            
            case "signed-out":
                return handleUnauthenticated(pathname, url, request);   
            
            default:
                console.error("未知认证:", authResult.status);
                return handleUnauthenticated(pathname, url, request);    
        }
    } catch (err) {
        console.error("_middleware error:", err);
        return handleUnauthenticated(pathname, url, request);
    }
}

function handleUnauthenticated(pathname, url, request) {
    const redirectPath = encodeURIComponent(url.pathname + url.search);
    return Response.redirect(
        `${url.origin}/login?redirect_url=${redirectPath}`,
        302
    );
}