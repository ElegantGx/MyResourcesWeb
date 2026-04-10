window.addEventListener('load', async () => {
    // 持续检查 Clerk SDK 是否被 Worker 成功注入并加载
    const checkClerk = setInterval(async () => {
        if (window.Clerk) {
            clearInterval(checkClerk);
            try {
                await Clerk.load();
                // 核心步骤：一旦检测到 URL 带着认证尾巴，立即清理并重写历史记录
                if (window.location.search.includes('__clerk_db_jwt')) {
                    // 强制浏览器将当前 URL 修正为干净的根路径
                    const cleanUrl = window.location.origin + window.location.pathname;
                    window.history.replaceState({}, document.title, cleanUrl);
                    console.log("认证同步完成，正在还原标准 HTML 视图...");
                }
            } catch (err) {
                console.error("Clerk 初始化失败:", err);
            }
        }
    }, 100);
});