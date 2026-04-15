const _ = window._;
const { createApp, ref, computed } = window.Vue;

async function getFileList() {
    await window.Clerk.load();
    const token = await window.Clerk.session.getToken();
    const response = await fetch('https://api.gxweb.top/get-list', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
        },
    });
    if (response.redirected) {
        window.location.href = response.url;
        return [];
    } else {
        const filesList = await response.json();
        return filesList;
    }
}

async function bootstrap() {
    const filesList = await getFileList();
    const app = createApp ({
        setup() {
            const rawData = ref(filesList);
            console.log(rawData);
            const currentPath = ref('');
            const gotoFolder = (path) => console.log('进入文件夹:', path);
            const theFolders = computed(() => {
                return _.chain(rawData.value)
                    .filter(item => item.size === 0)
                    .filter(item => /^[^/]+\/$/.test(item.key))
                    .map(item => ({
                        name: item.key.slice(0, -1),
                        key: item.key,
                    }))
                    .value();
            });
            console.log(theFolders.value);
            return {theFolders, gotoFolder, currentPath};
        }
    });
    app.mount('.container');
}

bootstrap();