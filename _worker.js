export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 只处理 index.html 的请求
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const response = await env.ASSETS.fetch(request);
      let html = await response.text();

      // 把占位符替换为真实 Key
      html = html.replace(
        "window.__CLERK_PK__ = 'pk_live_Y2xlcmsuZ3h3ZWIudG9wJA';",
        `window.__CLERK_PK__ = '${env.CLERK_PUBLISHABLE_KEY}';`
      );

      return new Response(html, {
        headers: response.headers,
        status: response.status,
      });
    }

    return env.ASSETS.fetch(request);
  },
};