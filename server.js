// server.js – Phát bài nghe có khoá theo giờ. Chỉ cần Node.js, không cần thư viện ngoài.
// Mọi thao tác làm trên trang web: http://localhost:8080/admin
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn, exec } = require('child_process');

const PORT = +process.env.PORT || 8080;
const DATA = path.join(__dirname, 'data');
const CFG_FILE = path.join(DATA, 'config.json');
const ENC_FILE = path.join(DATA, 'exam.enc');
const LOG_FILE = path.join(__dirname, 'log.txt');
fs.mkdirSync(DATA, { recursive: true });

let cfg = null;
try { if (fs.existsSync(CFG_FILE) && fs.existsSync(ENC_FILE)) cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { cfg = null; }
let examKey = null;                    // khoá giải mã CHỈ nằm trong RAM, không ghi ra đĩa
let forceRelease = false, playAt = null, state = {};
const tunnel = { proc: null, status: 'off', url: '', msg: '' };
const fails = {};                      // chống dò mã: đếm lần nhập sai theo IP

function resetRooms() {
  state = {};
  if (cfg) for (const r of Object.keys(cfg.rooms))
    state[r] = { status: 'chưa kết nối', lastSeen: 0, pos: 0, dur: 0, activated: false, ip: '' };
}
resetRooms();

function log(msg) {
  const line = `${new Date().toLocaleString('vi-VN')}  ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  process.stdout.write(line);
}
function same(a, b) {
  a = Buffer.from(String(a || '')); b = Buffer.from(String(b || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';           // bỏ I, O, 0, 1 cho dễ đọc
const genCode = n => [...crypto.randomBytes(n)].map(x => ALPHA[x % 32]).join('');
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const T0 = () => cfg ? Date.parse(cfg.t0) : Infinity;
const released = () => !!cfg && (forceRelease || Date.now() >= T0());   // dùng GIỜ MÁY CHỦ
const roomOk = (room, code) => !!cfg && Object.prototype.hasOwnProperty.call(cfg.rooms, room) && same(norm(code), cfg.rooms[room]);
const roomByCode = code => cfg && Object.keys(cfg.rooms).find(r => same(norm(code), cfg.rooms[r]));

// "Máy chủ" = mở trang ngay trên máy này qua localhost, không đi qua đường hầm Cloudflare
function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  const loop = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  return loop && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'] &&
    /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '');
}
function blocked(ip) { const f = fails[ip]; return f && f.n >= 20 && Date.now() - f.t < 10 * 60000; }
function fail(ip) { const f = fails[ip] || (fails[ip] = { n: 0, t: 0 }); if (Date.now() - f.t > 10 * 60000) f.n = 0; f.n++; f.t = Date.now(); }

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readJson(req, limit = 10000) {
  return new Promise(ok => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > limit) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } });
    req.on('error', () => ok({}));
  });
}
function page(res, file) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(path.join(__dirname, 'public', file)).pipe(res);
}

// Nhận file đề ĐÃ MÃ HOÁ từ trình duyệt theo từng phần nhỏ (trình duyệt tự mã hoá, máy chủ không thấy file gốc)
const TMP_FILE = path.join(DATA, 'upload.tmp');
function readBody(req, limit) {   // luôn đọc HẾT thân yêu cầu rồi mới trả lời → trình duyệt nhận được thông báo lỗi thật
  return new Promise((ok, no) => {
    const parts = []; let size = 0, over = false;
    req.on('data', c => { size += c.length; if (size > limit) over = true; else parts.push(c); });
    req.on('end', () => over ? no(new Error('Phần dữ liệu quá lớn')) : ok(Buffer.concat(parts)));
    req.on('error', no);
  });
}
async function receiveChunk(req, q) {
  const body = await readBody(req, 9 * 1048576);
  const offset = parseInt(q.offset);
  if (!(offset >= 0)) throw new Error('Thiếu vị trí phần dữ liệu');
  if (offset === 0) { fs.writeFileSync(TMP_FILE, body); return body.length; }
  const cur = fs.existsSync(TMP_FILE) ? fs.statSync(TMP_FILE).size : -1;
  if (cur !== offset) throw new Error(`Dữ liệu gửi lên bị lệch (máy chủ có ${cur}, trình duyệt gửi từ ${offset}) – bấm lại nút Mã hoá`);
  if (cur + body.length > 500 * 1048576) throw new Error('File quá lớn (tối đa 500 MB)');
  fs.appendFileSync(TMP_FILE, body);
  return cur + body.length;
}
async function finishExam(q) {
  const t0 = Date.parse(q.t0), n = Math.min(Math.max(parseInt(q.n) || 20, 1), 200);
  if (isNaN(t0)) throw new Error('Giờ thi không hợp lệ');
  if (!/^audio\/[\w.+-]+$/.test(q.mime || '')) throw new Error('Định dạng âm thanh không hợp lệ: ' + q.mime);
  if (!fs.existsSync(TMP_FILE)) throw new Error('Máy chủ chưa nhận được file – bấm lại nút Mã hoá');
  const size = fs.statSync(TMP_FILE).size;
  if (size !== parseInt(q.size)) throw new Error(`File nhận được không đủ (${size}/${q.size} byte) – bấm lại nút Mã hoá`);
  const sha256 = await new Promise((ok, no) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(TMP_FILE).on('data', c => h.update(c)).on('end', () => ok(h.digest('hex'))).on('error', no);
  });
  if (q.sha256 && q.sha256 !== sha256) throw new Error('File nhận được bị sai lệch – bấm lại nút Mã hoá');
  try { fs.unlinkSync(ENC_FILE); } catch {}                   // Windows: xoá file cũ trước rồi mới đổi tên
  try { fs.renameSync(TMP_FILE, ENC_FILE); } catch { fs.copyFileSync(TMP_FILE, ENC_FILE); try { fs.unlinkSync(TMP_FILE); } catch {} }
  const rooms = {}, used = new Set();
  for (let i = 1; i <= n; i++) { let c; do c = genCode(6); while (used.has(c)); used.add(c); rooms['P' + String(i).padStart(2, '0')] = c; }
  cfg = { title: String(q.title || 'Bài thi nghe').slice(0, 120), t0: new Date(t0).toISOString(), mime: q.mime,
    size, sha256, adminToken: genCode(10), createdAt: new Date().toISOString(), rooms };
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
  examKey = null; forceRelease = false; playAt = null; resetRooms();
}

// Thử giải mã để chắc chắn khoá đúng với đề hiện tại
function checkKey(b64) {
  const key = Buffer.from(String(b64 || ''), 'base64');
  if (key.length !== 32) return 'Khoá không đúng định dạng';
  try {
    const enc = fs.readFileSync(ENC_FILE);
    const d = crypto.createDecipheriv('aes-256-gcm', key, enc.subarray(0, 12));
    d.setAuthTag(enc.subarray(enc.length - 16));
    d.update(enc.subarray(12, enc.length - 16)); d.final();
    return null;
  } catch { return 'Khoá không khớp với đề hiện tại'; }
}

function startTunnel() {
  if (tunnel.proc) return;
  Object.assign(tunnel, { status: 'starting', url: '', msg: 'Đang mở đường hầm HTTPS…' });
  let p;
  try { p = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { windowsHide: true }); }
  catch { Object.assign(tunnel, { status: 'missing', msg: 'Chưa cài cloudflared' }); return; }
  tunnel.proc = p;
  const scan = d => {
    const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !tunnel.url) { Object.assign(tunnel, { status: 'on', url: m[0], msg: '' }); log('Truy cập từ xa: ' + m[0]); }
  };
  p.stdout.on('data', scan); p.stderr.on('data', scan);
  p.on('error', e => { tunnel.proc = null; Object.assign(tunnel, e.code === 'ENOENT' ? { status: 'missing', msg: 'Chưa cài cloudflared' } : { status: 'error', msg: e.message }); });
  p.on('exit', () => { if (tunnel.proc === p) { tunnel.proc = null; if (tunnel.status !== 'missing') Object.assign(tunnel, { status: 'off', url: '', msg: tunnel.status === 'on' ? 'Đường hầm đã đóng' : 'Không mở được đường hầm' }); } });
}
function stopTunnel() { if (tunnel.proc) { const p = tunnel.proc; tunnel.proc = null; p.kill(); } Object.assign(tunnel, { status: 'off', url: '', msg: '' }); }
process.on('exit', stopTunnel);
process.on('uncaughtException', e => log('LỖI KHÔNG MONG ĐỢI (máy chủ vẫn chạy): ' + (e && e.stack || e)));
process.on('unhandledRejection', e => log('LỖI KHÔNG MONG ĐỢI (máy chủ vẫn chạy): ' + (e && e.stack || e)));
process.on('SIGINT', () => process.exit());

function adminStatus(local) {
  return {
    now: Date.now(), local, configured: !!cfg,
    exam: cfg && { title: cfg.title, t0: T0(), mime: cfg.mime, size: cfg.size, createdAt: cfg.createdAt, roomCount: Object.keys(cfg.rooms).length },
    codes: cfg ? cfg.rooms : {}, adminToken: local && cfg ? cfg.adminToken : undefined,
    hasKey: !!examKey, released: released(), forceRelease, playAt, rooms: state,
    tunnel: { status: tunnel.status, url: tunnel.url, msg: tunnel.msg }
  };
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(u.searchParams), p = u.pathname;
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  try {
    if (p === '/') return page(res, 'room.html');
    if (p === '/admin') return page(res, 'admin.html');
    if (p === '/api/time') return send(res, 200, { now: Date.now(), t0: cfg ? T0() : null });

    // ---------- Máy phòng thi ----------
    if (p.startsWith('/api/') && !p.startsWith('/api/admin') && blocked(ip)) return send(res, 429, { error: 'Nhập sai quá nhiều lần, thử lại sau 10 phút' });

    if (p === '/api/login') {
      if (!cfg) return send(res, 503, { error: 'Hội đồng chưa chuẩn bị đề' });
      const room = roomByCode(q.code);
      if (!room) { fail(ip); log(`Đăng nhập SAI từ ${ip}`); return send(res, 403, { error: 'Sai mã truy cập' }); }
      log(`${room} đăng nhập từ ${ip}`);
      return send(res, 200, { room, title: cfg.title, mime: cfg.mime, sha256: cfg.sha256, size: cfg.size });
    }
    if (p === '/api/audio') {
      if (!roomOk(q.room, q.code)) { fail(ip); return send(res, 403, { error: 'Sai mã' }); }
      log(`${q.room} tải file đề (mã hoá)`);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(ENC_FILE).size, 'Cache-Control': 'no-store' });
      return fs.createReadStream(ENC_FILE).pipe(res);
    }
    if (p === '/api/key') {
      if (!roomOk(q.room, q.code)) { fail(ip); return send(res, 403, { error: 'Sai mã' }); }
      if (!released()) { log(`${q.room} xin khoá TRƯỚC GIỜ – từ chối`); return send(res, 403, { error: 'Chưa đến giờ' }); }
      if (!examKey) return send(res, 503, { error: 'Hội đồng chưa nạp khoá' });
      log(`${q.room} nhận khoá`);
      return send(res, 200, { key: examKey });
    }
    if (p === '/api/report' && req.method === 'POST') {
      const b = await readJson(req);
      if (!roomOk(b.room, b.code)) return send(res, 403, {});
      const s = state[b.room], st = String(b.status || '').slice(0, 60);
      if (s.status !== st) log(`${b.room}: ${st}`);
      Object.assign(s, { status: st, pos: +b.pos || 0, dur: +b.dur || 0, activated: !!b.activated, lastSeen: Date.now(), ip });
      return send(res, 200, { playAt, released: released(), title: cfg.title });
    }

    // ---------- Hội đồng ----------
    if (p.startsWith('/api/admin/')) {
      const local = isLocal(req);
      if (!local && !(cfg && same(norm(q.token), cfg.adminToken))) return send(res, 403, { error: 'Sai mã quản trị' });
      const a = p.slice(11), post = req.method === 'POST';
      const localOnly = () => { send(res, 403, { error: 'Thao tác này chỉ làm được trên máy chủ' }); };

      if (a === 'status') return send(res, 200, adminStatus(local));
      if (post && a === 'chunk') {
        if (!local) { req.resume(); return localOnly(); }
        try { const got = await receiveChunk(req, q); if (+q.offset === 0) log(`Đang nhận file đề mã hoá (${(q.total / 1048576).toFixed(1)} MB)…`); return send(res, 200, { got }); }
        catch (e) { log('Lỗi nhận file đề: ' + e.message); return send(res, 400, { error: e.message }); }
      }
      if (post && a === 'setup') {
        if (!local) return localOnly();
        try { await finishExam(q); } catch (e) { log('Lỗi chuẩn bị đề: ' + e.message); return send(res, 400, { error: e.message }); }
        log(`HỘI ĐỒNG: chuẩn bị đề mới "${cfg.title}", T0 = ${new Date(T0()).toLocaleString('vi-VN')}, ${Object.keys(cfg.rooms).length} phòng`);
        return send(res, 200, adminStatus(local));
      }
      if (post && a === 'key') {
        if (!cfg) return send(res, 400, { error: 'Chưa có đề' });
        const b = await readJson(req), err = checkKey(b.key);
        if (err) { log('HỘI ĐỒNG: nạp khoá SAI'); return send(res, 400, { error: err }); }
        examKey = Buffer.from(b.key, 'base64').toString('base64'); log('HỘI ĐỒNG: đã nạp khoá');
        return send(res, 200, {});
      }
      if (post && a === 'unkey') { examKey = null; log('HỘI ĐỒNG: gỡ khoá khỏi máy chủ'); return send(res, 200, {}); }
      if (post && a === 'play') { if (!released()) return send(res, 400, { error: 'Chưa đến giờ thi' }); playAt = Date.now() + 5000; log('HỘI ĐỒNG: lệnh phát đồng loạt'); return send(res, 200, { playAt }); }
      if (post && a === 'cancel') { playAt = null; log('HỘI ĐỒNG: huỷ lệnh phát'); return send(res, 200, {}); }
      if (post && a === 'release') { forceRelease = true; log('HỘI ĐỒNG: MỞ KHOÁ KHẨN CẤP'); return send(res, 200, {}); }
      if (post && a === 'tunnel-start') { if (!local) return localOnly(); startTunnel(); return send(res, 200, {}); }
      if (post && a === 'tunnel-stop') { if (!local) return localOnly(); stopTunnel(); return send(res, 200, {}); }
      if (post && a === 'delete') {
        if (!local) return localOnly();
        for (const f of [ENC_FILE, CFG_FILE]) try { fs.unlinkSync(f); } catch {}
        cfg = null; examKey = null; forceRelease = false; playAt = null; resetRooms(); log('HỘI ĐỒNG: xoá đề');
        return send(res, 200, {});
      }
    }
    send(res, 404, { error: 'Không tìm thấy' });
  } catch (e) { log('Lỗi: ' + e.message); if (!res.headersSent) send(res, 500, { error: 'Lỗi máy chủ' }); }
}).on('error', e => {
  if (e.code === 'EADDRINUSE') { console.log(`\nChương trình đã đang chạy (cổng ${PORT} bận). Mở trình duyệt vào http://localhost:${PORT}/admin`); openBrowser(); setTimeout(() => process.exit(), 4000); }
  else console.log(e);
}).listen(PORT, () => {
  log(`Máy chủ chạy tại http://localhost:${PORT}  (bảng điều khiển: http://localhost:${PORT}/admin) · Node ${process.version}`);
  console.log('Giữ cửa sổ này MỞ trong suốt buổi thi. Đóng cửa sổ = tắt chương trình.\n');
  openBrowser();
});

function openBrowser() {
  if (process.env.NO_OPEN) return;
  const url = `http://localhost:${PORT}/admin`;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}
