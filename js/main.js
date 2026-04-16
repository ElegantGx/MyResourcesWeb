const _ = window._;
const { createApp, ref, computed } = window.Vue;

async function fetchFilesList() {
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
    const filesList = await fetchFilesList();
    const app = createApp ({
        setup() {
            const filesData = ref(filesList);
            
            const rootDirs = computed(() => {
                return _.chain(filesData.value.files)
                    .filter(item => item.size === '0')
                    .filter(item => /^[^/]+\/$/.test(item.key))
                    .map(item => ({
                        name: item.key.slice(0, -1),
                        key: item.key,
                    }))
                    .value();
            });
            const curPath = ref('');
            
            const activeDirKey = computed(() => {
                if (!curPath.value) return '';
                const nowDir = rootDirs.value.find(d => curPath.value.startsWith(d.key))?.key || '';
                return nowDir;
            });     
            
            const gotoDir = (dirKey) => {
                curPath.value = dirKey;
            };
            
            const trim = (str) => {
                return str.slice(0, -1);
            }

            const getTopName = (curPath) => {
                const topName = trim(curPath);
                return topName;
            };

            return {
                rootDirs, curPath, activeDirKey, gotoDir, getTopName
            };
        }
    });
    app.mount('.container');
}

bootstrap();