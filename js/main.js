const clerkPubKey = 'pk_live_Y2xlcmsuZ3h3ZWIudG9wJA'; // 请替换为实际值
const clerk = new Clerk(clerkPubKey);
clerk.load().then(() => {
    if (clerk.user) {
        document.getElementById('listBtn').disabled = false;
        document.getElementById('listBtn').textContent = '获取文件列表';
    }
});

document.getElementById('listBtn').addEventListener('click', async () => {
    const output = document.getElementById('output');
    output.textContent = '请求中...';
      
    try {
        const token = await clerk.session.getToken();
        const bucket = 'ourresources-1420050009';  // 您的存储桶
        const region = 'ap-hongkong';
        const prefix = ''; // 可指定目录前缀
        
        const res = await fetch(
          `https://api.gxweb.top/list-objects?bucket=${bucket}&region=${region}&prefix=${prefix}`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        
        const data = await res.json();
        output.textContent = JSON.stringify(data, null, 2);
        
        if (data.success) {
          console.log('文件列表:', data.data.Contents);
          console.log('文件夹:', data.data.CommonPrefixes);
        }
    } catch (err) {
        output.textContent = '错误: ' + err.message;
    }
});