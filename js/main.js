async function testCOS() {
    console.log("Begin....");
    try {
        const token = await window.Clerk.session.getToken({ template: 'cos-access' });
        const res = await fetch('/api/get-list', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
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
    if (window.Clerk) {
        testCOS();
    } else {
        setTimeout(start, 100);
    }
};
start();
