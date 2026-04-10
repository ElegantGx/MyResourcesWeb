(function () {
  // 1. 立即注入遮罩样式，防止内容闪现
  const style = document.createElement('style');
  style.id = '__auth_style';
  style.textContent = `
    #__auth_overlay {
      position: fixed;
      inset: 0;
      z-index: 9999;
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      background: rgba(0, 0, 0, 0.35);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      cursor: pointer;
      transition: opacity 0.3s ease;
    }
    #__auth_overlay .lock-icon {
      width: 48px;
      height: 48px;
      opacity: 0.9;
    }
    #__auth_overlay p {
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 15px;
      margin: 0;
      opacity: 0.85;
    }
    #__auth_overlay.hide {
      opacity: 0;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);

  // 2. 注入遮罩 DOM（带锁图标 SVG）
  const overlay = document.createElement('div');
  overlay.id = '__auth_overlay';
  overlay.innerHTML = `
    <svg class="lock-icon" viewBox="0 0 24 24" fill="none"
         stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
    <p>请先登录以访问内容</p>
  `;
  overlay.addEventListener('click', () => {
    window.location.href = '/login.html';
  });

  // 3. 等 body 可用时挂载遮罩
  function mountOverlay() {
    if (document.body) {
      document.body.appendChild(overlay);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        document.body.appendChild(overlay);
      });
    }
  }
  mountOverlay();

  // 4. 加载 Clerk JS SDK
  const PUBLISHABLE_KEY = window.__CLERK_PK__ || '';
  // ↑ 实际 Key 通过 Cloudflare Pages 环境变量注入，见下方说明

  const clerkScript = document.createElement('script');
  clerkScript.src = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js';
  clerkScript.crossOrigin = 'anonymous';
  clerkScript.onload = async function () {
    try {
      const clerk = new window.Clerk(PUBLISHABLE_KEY);
      await clerk.load();

      if (clerk.user) {
        // 已登录：淡出遮罩后移除
        overlay.classList.add('hide');
        setTimeout(() => overlay.remove(), 320);
        document.getElementById('__auth_style')?.remove();
      }
      // 未登录：遮罩保持，点击跳转 login.html（已绑定）
    } catch (err) {
      console.error('[auth.js] Clerk 初始化失败:', err);
      // 失败时保留遮罩，不暴露内容
    }
  };
  clerkScript.onerror = function () {
    console.error('[auth.js] Clerk SDK 加载失败');
  };
  document.head.appendChild(clerkScript);
})();