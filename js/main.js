let resourceData = {};
async function init() {
    try {
        const response = await fetch('assets/data/resourcesLib.json');
        resourceData = await response.json();
        console.log("加载完毕", resourceData);
    } catch (error) {
        console.error("加载失败，请检查网络连接", error);
    }
}

window.onload = init;