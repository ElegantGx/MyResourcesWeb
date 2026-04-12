async function testCOS() {
    console.log("Begin....");
    try {
        await Clerk.load();
        const res = await fetch('/api/get-list');
        const data = await res.json();
        if (data.success) {
            console.table(data.files);
            console.log("Successful.")
        }
        else {
            console.error("检查get-list.js相关", e);
        }
    } catch(e) {
        console.error("请求失败, 检查_middleware.js相关", e);
    }
}
const start = () => {
    // 检查 Clerk 是否已经由 index.html 的脚本加载
    if (window.Clerk) {
        // 如果已经有了，直接执行
        testCOS();
    } else {
        // 如果还没有，等待 100ms 后重试
        setTimeout(start, 100);
    }
};

start();
