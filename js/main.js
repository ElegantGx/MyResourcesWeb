const response = await fetch('https://api.gxweb.top/get-list', {
    credentials: 'include'
});
if (response.redirected) {
    window.location.href = response.url;
} else {
    const files = await response.json();
    console.log(files);
}
