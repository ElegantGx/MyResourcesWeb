async function testAPI() {
    const apiUrl = 'https://api.gxweb.top';
    try {
        const response = await fetch(apiUrl);
        const data = await response.json();
        console.log("Begin...");
        if (data.success) {
            console.log(data.data.files);
        } else {
            console.log("API Error");
        }
    } catch(error) {
        console.log("请求失败");
    }
}
testAPI();