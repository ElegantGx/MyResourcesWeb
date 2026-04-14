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
} else {
    const files = await response.json();
    console.log(files);
}