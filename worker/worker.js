// Cloudflare Worker: "Sync now" trigger for the GDD pipeline.
// Designers open https://<worker-url>/sync?key=<TRIGGER_KEY> (linked from the
// Notion Draft page); the worker fires a repository_dispatch event that starts
// the gdd-sync GitHub Actions workflow.

function page(title, body, ok) {
  return new Response(
    `<!doctype html>
<html lang="zh">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<body style="font-family: system-ui, sans-serif; background: #f7f6f3; display: flex; justify-content: center; padding-top: 15vh; margin: 0;">
  <div style="text-align: center; max-width: 26em; padding: 0 1em;">
    <div style="font-size: 3em;">${ok ? '✅' : '❌'}</div>
    <h1 style="font-size: 1.3em;">${title}</h1>
    <p style="color: #666; line-height: 1.6;">${body}</p>
  </div>
</body>
</html>`,
    { status: ok ? 200 : 502, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/sync') {
      return new Response('Not found', { status: 404 });
    }
    if (url.searchParams.get('key') !== env.TRIGGER_KEY) {
      return new Response('Forbidden', { status: 403 });
    }

    const resp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gdd-sync-trigger',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ event_type: 'sync-now' }),
    });

    if (resp.status === 204) {
      return page(
        'GDD 整理已开始',
        '稍后刷新 Notion 的 GDD 页面查看结果。<br>若草稿自上次整理后没有改动，本次会自动跳过。',
        true,
      );
    }
    return page('触发失败', `GitHub 返回 HTTP ${resp.status}，请联系管理员。`, false);
  },
};
