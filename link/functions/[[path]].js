// Link ngắn cố định: chuyển mọi đường dẫn về địa chỉ đường hầm hiện tại của máy chủ thi.
// Máy chủ thi tự báo địa chỉ mới qua POST /_set (cần LINK_SECRET); địa chỉ lưu trong KV.
const TUNNEL = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

function sameSecret(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

const OFFLINE = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phát bài nghe</title><meta http-equiv="refresh" content="15">
<style>body{font-family:"Segoe UI",Arial,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
div{background:#1e293b;padding:32px 40px;border-radius:18px;max-width:560px}h1{margin:0 0 8px;font-size:26px}p{color:#94a3b8;margin:0}</style></head>
<body><div><h1>Máy chủ thi chưa bật</h1><p>Admin chưa bật truy cập từ xa. Trang sẽ tự thử lại sau 15 giây.</p></div></body></html>`;

export async function onRequest({ request, env }) {
  const u = new URL(request.url);
  if (u.pathname === '/_set') {
    if (request.method !== 'POST') return json(405, { error: 'Chỉ nhận POST' });
    const auth = request.headers.get('authorization') || '';
    if (!env.LINK_SECRET || !sameSecret(auth, 'Bearer ' + env.LINK_SECRET)) return json(403, { error: 'Sai mã link' });
    const b = await request.json().catch(() => ({}));
    if (b.url === null) { await env.LINK.delete('url'); return json(200, { url: null }); }
    if (!TUNNEL.test(b.url || '')) return json(400, { error: 'Địa chỉ không hợp lệ' });
    await env.LINK.put('url', b.url);
    return json(200, { url: b.url });
  }
  const base = await env.LINK.get('url');
  if (!base) return new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  return new Response(null, { status: 302, headers: { Location: base + u.pathname + u.search, 'Cache-Control': 'no-store' } });
}
