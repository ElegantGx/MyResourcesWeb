import { createClerkClient } from "@clerk/backend";

export async function onRequest(context) {
    const { request, env, next, data } = context;
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
        if (authResult.status == "signed-in") {
            return next();
        }
        throw new Error("Unauthenticated");
    } catch (_err) {
        if (pathname.startsWith("/api/")) {
            return new Response(
                JSON.stringify({ error: "Unauthorized", message: "Authentication required." }),
                {
                    status: 401,
                    headers: { "Content-Type": "application/json" },
                }
            );
        }
        const redirectUrl = encodeURIComponent(request.url);
        return Response.redirect(
            `${url.origin}/login?redirect_url=${redirectUrl}`,
            302
        );
    }
}