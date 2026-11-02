// server.js – Phát bài nghe có khoá theo giờ. Chỉ cần Node.js, không cần thư viện ngoài.
// 3 vai: admin (/a), giáo viên (/g), kỹ thuật viên (/ hoặc /<mã phòng>).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn, exec } = require('child_process');

const PORT = +process.env.PORT || 8080;
const DATA = path.join(__dirname, 'data');
const EXAMS_DIR = path.join(DATA, 'exams');
const EXAMS_FILE = path.join(DATA, 'exams.json');
const USERS_FILE = path.join(DATA, 'users.json');
const SCHOOL_FILE = path.join(DATA, 'school.json');
const KTV_FILE = path.join(DATA, 'ktvs.json');
const LOG_FILE = path.join(__dirname, 'log.txt');
fs.mkdirSync(EXAMS_DIR, { recursive: true });

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
function writeJson(f, obj) { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(obj, null, 2)); fs.renameSync(t, f); }

let exams = readJson(EXAMS_FILE, []);     // [{ id, title, teacherId, teacherName, mime, size, sha256, dur, wrappedKey, keyId, uploadedAt, t0, rooms, tokens }]
let users = readJson(USERS_FILE, []);     // [{ id, name, username, role, salt, hash, createdAt }]
let school = readJson(SCHOOL_FILE, null); // { publicKey, keyId, createdAt } – chỉ có khoá công khai
let ktvs = readJson(KTV_FILE, []);        // [{ id, name }] – kỹ thuật viên không có tài khoản, chỉ để phân phòng
let masterKey = null;                     // khoá riêng của trường CHỈ nằm trong RAM, không ghi ra đĩa
const live = {};                          // trạng thái theo bài, chỉ trong RAM: { force, playAt, rooms }
const sessions = new Map();               // mã phiên -> { userId, exp }
const tunnel = { proc: null, status: 'off', url: '', msg: '' };
const fails = {};                         // chống dò mã: đếm lần nhập sai theo IP
const SESSION_MS = 30 * 86400000;

// Sơ đồ phòng học lý thuyết năm học 2026 – 2027, áp dụng từ 05/9/2026. null = ô cầu thang giữa dãy.
const SCHOOL_MAP = [
  { title: 'KHU 20 PHÒNG (DÃY TRƯỚC SẢNH)', floors: [
    { n: 4, wait: 'PHÒNG ĐỢI', rooms: [['409', '12 SINH'], ['408', '12 HOÁ'], null, ['407', '12 LÝ'], ['406', '12 TOÁN 2'], ['405', '12 TOÁN 1']] },
    { n: 3, wait: 'PHÒNG ĐỢI', rooms: [['309', '12 TIN'], ['308', '12 VĂN'], null, ['307', '12 ANH 1'], ['306', '12 ANH 2'], ['305', '11 TOÁN 1']] },
    { n: 2, wait: 'PHÒNG ĐỢI', rooms: [['209', '11 TIN'], ['208', '11 SINH'], null, ['207', '11 HOÁ'], ['206', '11 LÝ'], ['205', '11 TOÁN 2']] },
    { n: 1, wait: 'PHÒNG ĐỢI', rooms: [['109', '11 VĂN'], ['108', '11 ANH 1'], null, ['107', '11 ANH 2'], ['106', 'DỰ PHÒNG'], ['105', 'DỰ PHÒNG']] },
  ] },
  { title: 'KHU 16 PHÒNG (DÃY PHÍA SAU)', floors: [
    { n: 4, wait: 'PHÒNG ĐỢI', rooms: [['404', 'PHÒNG MÁY'], ['403', 'PHÒNG MÁY'], ['402', 'PHÒNG MÁY'], ['401', 'PHÒNG STEM']] },
    { n: 3, wait: 'PHÒNG ĐỢI', rooms: [['304', '10 HOÁ'], ['303', '10 LÝ'], ['302', '10 TOÁN 2'], ['301', '10 TOÁN 1']] },
    { n: 2, wait: 'PHÒNG ĐỢI', rooms: [['204', '10 SINH'], ['203', '10 TIN'], ['202', '10 VĂN'], ['201', '10 SỬ']] },
    { n: 1, wait: 'PHÒNG THIẾT BỊ GDQP', rooms: [['104', 'DỰ PHÒNG'], ['103', 'DỰ PHÒNG'], ['102', '10 ANH'], ['101', '10 ĐỊA']] },
  ] },
];
const ROOM_IDS = new Set(SCHOOL_MAP.flatMap(k => k.floors.flatMap(f => f.rooms.filter(Boolean).map(r => 'P' + r[0]))));

const saveExams = () => writeJson(EXAMS_FILE, exams);
const saveKtvs = () => writeJson(KTV_FILE, ktvs);
const saveUsers = () => writeJson(USERS_FILE, users);
const encFile = id => path.join(EXAMS_DIR, id + '.enc');
const findExam = id => exams.find(e => e.id === id);

function liveOf(e) {
  const l = live[e.id] || (live[e.id] = { force: false, playAt: null, rooms: {} });
  for (const r of Object.keys(e.rooms || {}))
    if (!l.rooms[r]) l.rooms[r] = { status: 'chưa kết nối', lastSeen: 0, pos: 0, dur: 0, activated: false, ip: '' };
  for (const r of Object.keys(l.rooms)) if (!e.rooms || !e.rooms[r]) delete l.rooms[r];
  return l;
}

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
const CODE_LEN = 4;                                          // mã phòng ngắn để nhập tay và để link ngắn
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const released = e => !!e.t0 && (liveOf(e).force || Date.now() >= e.t0);   // dùng GIỜ MÁY CHỦ
function findRoom(code) {
  const c = norm(code);
  if (c.length !== CODE_LEN) return null;
  for (const e of exams) for (const [room, v] of Object.entries(e.rooms || {})) if (same(c, v)) return { exam: e, room };
  return null;
}
// Thẻ của phòng: cấp khi nhập đúng mã, dùng cho mọi yêu cầu sau đó. Thẻ quá dài để dò nên không tính lần sai,
// và máy đã vào không bị chặn khi có người khác cùng mạng nhập sai mã.
function roomToken(e, room) {
  const t = e.tokens || (e.tokens = {});
  if (!t[room]) { t[room] = crypto.randomBytes(32).toString('hex'); saveExams(); }
  return t[room];
}
function findRoomByToken(token) {
  for (const e of exams) for (const [room, v] of Object.entries(e.tokens || {})) if (e.rooms && e.rooms[room] && same(token, v)) return { exam: e, room };
  return null;
}
function newCode() {
  const used = new Set(exams.flatMap(e => Object.values(e.rooms || {})));
  let c; do c = genCode(CODE_LEN); while (used.has(c));
  return c;
}

// ---------- Tài khoản ----------
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
function createUser(name, username, role, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const u = { id: crypto.randomBytes(6).toString('hex'), name, username, role, salt, hash: hashPw(password, salt), createdAt: Date.now() };
  users.push(u); saveUsers();
  return u;
}
function setPassword(u, password) { u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(password, u.salt); saveUsers(); }
const genPassword = () => genCode(8);
const publicUser = u => ({ id: u.id, name: u.name, username: u.username, role: u.role, createdAt: u.createdAt, examCount: exams.filter(e => e.teacherId === u.id).length });

function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : '';
}
function currentUser(req) {
  const t = cookie(req, 's'), s = t && sessions.get(t);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(t); return null; }
  return users.find(u => u.id === s.userId) || null;
}
function endSessionsOf(userId) { for (const [t, s] of sessions) if (s.userId === userId) sessions.delete(t); }

// "Máy chủ" = mở trang ngay trên máy này qua localhost, không đi qua đường hầm Cloudflare
function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  const loop = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  return loop && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'] &&
    /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '');
}
function blocked(ip) { const f = fails[ip]; return f && f.n >= 20 && Date.now() - f.t < 10 * 60000; }
function fail(ip) { const f = fails[ip] || (fails[ip] = { n: 0, t: 0 }); if (Date.now() - f.t > 10 * 60000) f.n = 0; f.n++; f.t = Date.now(); }
// Trang web lạ không được gửi lệnh tới máy chủ qua trình duyệt của người dùng
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
function readJsonBody(req, limit = 10000) {
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
const tmpFile = userId => path.join(DATA, `upload-${userId}.tmp`);
function readBody(req, limit) {   // luôn đọc HẾT thân yêu cầu rồi mới trả lời → trình duyệt nhận được thông báo lỗi thật
  return new Promise((ok, no) => {
    const parts = []; let size = 0, over = false;
    req.on('data', c => { size += c.length; if (size > limit) over = true; else parts.push(c); });
    req.on('end', () => over ? no(new Error('Phần dữ liệu quá lớn')) : ok(Buffer.concat(parts)));
    req.on('error', no);
  });
}
async function receiveChunk(req, q, user) {
  const body = await readBody(req, 9 * 1048576), tmp = tmpFile(user.id);
  const offset = parseInt(q.offset);
  if (!(offset >= 0)) throw new Error('Thiếu vị trí phần dữ liệu');
  if (offset === 0) { fs.writeFileSync(tmp, body); return body.length; }
  const cur = fs.existsSync(tmp) ? fs.statSync(tmp).size : -1;
  if (cur !== offset) throw new Error(`Dữ liệu gửi lên bị lệch (máy chủ có ${cur}, trình duyệt gửi từ ${offset}) – bấm đăng lại`);
  if (cur + body.length > 500 * 1048576) throw new Error('File quá lớn (tối đa 500 MB)');
  fs.appendFileSync(tmp, body);
  return cur + body.length;
}
async function finishUpload(b, user) {
  const tmp = tmpFile(user.id);
  if (!school) throw new Error('Admin chưa tạo khoá trường');
  if (b.keyId !== school.keyId) throw new Error('Khoá trường vừa đổi – tải lại trang rồi đăng lại');
  if (!/^audio\/[\w.+-]+$/.test(b.mime || '')) throw new Error('Định dạng âm thanh không hợp lệ: ' + b.mime);
  if (!/^[A-Za-z0-9+/=]{100,2000}$/.test(b.wrappedKey || '')) throw new Error('Khoá của bài không hợp lệ');
  if (!fs.existsSync(tmp)) throw new Error('Máy chủ chưa nhận được file – bấm đăng lại');
  const size = fs.statSync(tmp).size;
  if (size !== parseInt(b.size)) throw new Error(`File nhận được không đủ (${size}/${b.size} byte) – bấm đăng lại`);
  const sha256 = await new Promise((ok, no) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(tmp).on('data', c => h.update(c)).on('end', () => ok(h.digest('hex'))).on('error', no);
  });
  if (b.sha256 && b.sha256 !== sha256) throw new Error('File nhận được bị sai lệch – bấm đăng lại');
  const id = crypto.randomBytes(6).toString('hex');
  try { fs.renameSync(tmp, encFile(id)); } catch { fs.copyFileSync(tmp, encFile(id)); try { fs.unlinkSync(tmp); } catch {} }
  const e = { id, title: String(b.title || 'Bài thi nghe').trim().slice(0, 120) || 'Bài thi nghe', teacherId: user.id, teacherName: user.name,
    mime: b.mime, size, sha256, dur: +b.dur || 0, wrappedKey: b.wrappedKey, keyId: school.keyId, uploadedAt: Date.now(), t0: null, rooms: {} };
  exams.push(e); saveExams();
  return e;
}
function deleteExam(e) {
  try { fs.unlinkSync(encFile(e.id)); } catch {}
  exams = exams.filter(x => x !== e); delete live[e.id]; saveExams();
}

// Admin xếp lịch và phân phòng: giữ mã các phòng đã có để phiếu đã in vẫn dùng được
function schedule(e, t0, assign) {
  const old = e.rooms || {}, rooms = Object.keys(assign).sort();
  e.rooms = {};
  for (const r of rooms) if (old[r]) e.rooms[r] = old[r];
  for (const r of rooms) if (!e.rooms[r]) e.rooms[r] = newCode();
  e.rooms = Object.fromEntries(rooms.map(r => [r, e.rooms[r]]));
  e.ktv = Object.fromEntries(rooms.filter(r => assign[r]).map(r => [r, assign[r]]));
  e.tokens = Object.fromEntries(Object.entries(e.tokens || {}).filter(([r]) => e.rooms[r]));
  e.t0 = t0; saveExams();
  liveOf(e);
}
// Một phòng không thể phát hai bài trùng giờ. Bài chưa rõ độ dài thì tính 60 phút.
const examSpan = e => (e.dur || 3600) * 1000;
function roomClash(e, t0, rooms) {
  for (const o of exams) {
    if (o === e || !o.t0 || !(t0 < o.t0 + examSpan(o) && o.t0 < t0 + examSpan(e))) continue;
    const r = rooms.find(x => o.rooms && o.rooms[x]);
    if (r) return `P.${r.slice(1)} đang dùng cho bài "${o.title}" trùng giờ`;
  }
  return null;
}

// ---------- Khoá trường ----------
function unwrapKey(e) {
  if (!masterKey || e.keyId !== school?.keyId) return null;
  try { return crypto.privateDecrypt({ key: masterKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(e.wrappedKey, 'base64')); }
  catch { return null; }
}
// Thử giải mã để chắc chắn bài này mở được
function checkExam(e) {
  const key = unwrapKey(e);
  if (!key || key.length !== 32) return false;
  try {
    const enc = fs.readFileSync(encFile(e.id));
    const d = crypto.createDecipheriv('aes-256-gcm', key, enc.subarray(0, 12));
    d.setAuthTag(enc.subarray(enc.length - 16));
    d.update(enc.subarray(12, enc.length - 16)); d.final();
    return true;
  } catch { return false; }
}
let badExams = [];
function loadMasterKey(pem) {
  if (!school) return 'Chưa tạo khoá trường';
  let priv;
  try { priv = crypto.createPrivateKey(pem); } catch { return 'File này không phải khoá trường'; }
  const pub = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' });
  if (String(pub).replace(/\s/g, '') !== school.publicKey.replace(/\s/g, '')) return 'Khoá này không khớp với khoá trường hiện tại';
  masterKey = priv;
  badExams = exams.filter(e => !checkExam(e)).map(e => e.id);
  return null;
}

// ---------- Link ngắn cố định (thư mục link/): báo địa chỉ đường hầm hiện tại, tự thử lại nếu mất mạng ----------
const LINK_FILE = path.join(DATA, 'link.json');
let link = readJson(LINK_FILE, null);     // { url, secret } – file này không lên GitHub
const linkState = { ok: false, msg: '', timer: null };
async function publishLink(url) {
  clearTimeout(linkState.timer);
  if (!link) return;
  try {
    const r = await fetch(link.url + '/_set', { method: 'POST', headers: { Authorization: 'Bearer ' + link.secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(r.status === 403 ? 'sai mã link' : 'lỗi ' + r.status);
    Object.assign(linkState, { ok: !!url, msg: '' });
    log(url ? `Link ngắn ${link.url} trỏ về ${url}` : `Link ngắn ${link.url} đã tắt`);
  } catch (e) {
    Object.assign(linkState, { ok: false, msg: 'Chưa cập nhật được link ngắn: ' + e.message });
    if (e.message !== 'sai mã link' && tunnel.url === (url || '')) linkState.timer = setTimeout(() => publishLink(url), 15000);
  }
}

function startTunnel() {
  if (tunnel.proc) return;
  Object.assign(tunnel, { status: 'starting', url: '', msg: 'Đang mở đường hầm HTTPS…' });
  let p;
  const exe = ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe')]
    .find(f => process.platform === 'win32' && fs.existsSync(f)) || 'cloudflared';
  try { p = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { windowsHide: true }); }
  catch { Object.assign(tunnel, { status: 'missing', msg: 'Chưa cài cloudflared' }); return; }
  tunnel.proc = p;
  const scan = d => {
    const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !tunnel.url) { Object.assign(tunnel, { status: 'on', url: m[0], msg: '' }); log('Truy cập từ xa: ' + m[0]); publishLink(m[0]); }
  };
  p.stdout.on('data', scan); p.stderr.on('data', scan);
  p.on('error', e => { tunnel.proc = null; Object.assign(tunnel, e.code === 'ENOENT' ? { status: 'missing', msg: 'Chưa cài cloudflared' } : { status: 'error', msg: e.message }); });
  p.on('exit', () => { if (tunnel.proc === p) { tunnel.proc = null; if (tunnel.status !== 'missing') { const was = tunnel.status === 'on'; Object.assign(tunnel, { status: 'off', url: '', msg: was ? 'Đường hầm đã đóng' : 'Không mở được đường hầm' }); if (was) publishLink(null); } } });
}
function stopTunnel() { const had = !!tunnel.url; if (tunnel.proc) { const p = tunnel.proc; tunnel.proc = null; p.kill(); } Object.assign(tunnel, { status: 'off', url: '', msg: '' }); if (had) publishLink(null); }
process.on('exit', () => { if (tunnel.proc) tunnel.proc.kill(); });
process.on('uncaughtException', e => log('LỖI KHÔNG MONG ĐỢI (máy chủ vẫn chạy): ' + (e && e.stack || e)));
process.on('unhandledRejection', e => log('LỖI KHÔNG MONG ĐỢI (máy chủ vẫn chạy): ' + (e && e.stack || e)));
process.on('SIGINT', () => process.exit());

function examForAdmin(e) {
  const l = liveOf(e);
  return { id: e.id, title: e.title, teacherName: e.teacherName, teacherId: e.teacherId, mime: e.mime, size: e.size, dur: e.dur, uploadedAt: e.uploadedAt,
    t0: e.t0, codes: e.rooms || {}, ktv: e.ktv || {}, released: released(e), force: l.force, playAt: l.playAt, rooms: l.rooms,
    oldKey: e.keyId !== school?.keyId, bad: badExams.includes(e.id) };
}
function adminStatus(req, user) {
  const local = isLocal(req);
  return { now: Date.now(), local, user: user ? { name: user.name } : { name: 'Máy chủ' }, hasSchoolKey: !!school, schoolKeyAt: school?.createdAt || null,
    hasKey: !!masterKey, exams: exams.map(examForAdmin), users: users.map(publicUser), ktvs, map: SCHOOL_MAP, tunnel: { status: tunnel.status, url: tunnel.url, msg: tunnel.msg },
    short: link ? { url: link.url, ok: linkState.ok, msg: linkState.msg } : null };
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(u.searchParams), p = u.pathname;
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  try {
    if (p === '/') return page(res, 'room.html');
    if (p === '/a') return page(res, 'admin.html');
    if (p === '/g') return page(res, 'teacher.html');
    if (p === '/admin') { res.writeHead(302, { Location: '/a' }); return res.end(); }
    if (new RegExp(`^/[A-Za-z0-9]{${CODE_LEN}}$`).test(p)) return page(res, 'room.html');   // link ngắn của phòng: /K7M2
    if (p === '/api/time') return send(res, 200, { now: Date.now() });
    if (req.method === 'POST' && !sameOrigin(req)) { req.resume(); return send(res, 403, { error: 'Yêu cầu không hợp lệ' }); }

    // ---------- Kỹ thuật viên: chỉ cần mã phòng ----------
    if (p === '/api/login') {
      let f;
      if (q.token) { f = findRoomByToken(q.token); if (!f) return send(res, 403, { error: 'Mã phòng không còn hiệu lực' }); }
      else {
        if (blocked('r:' + ip)) return send(res, 429, { error: 'Nhập sai quá nhiều lần, thử lại sau 10 phút' });
        f = findRoom(q.code);
        if (!f) { fail('r:' + ip); log(`Đăng nhập SAI từ ${ip}`); return send(res, 403, { error: 'Sai mã truy cập' }); }
      }
      log(`${f.exam.title} / ${f.room} đăng nhập từ ${ip}`);
      const ktv = ktvs.find(k => k.id === (f.exam.ktv || {})[f.room]);
      return send(res, 200, { room: f.room, title: f.exam.title, mime: f.exam.mime, sha256: f.exam.sha256, size: f.exam.size, t0: f.exam.t0, ktv: ktv ? ktv.name : '', token: roomToken(f.exam, f.room) });
    }
    if (p === '/api/audio') {
      const f = findRoomByToken(q.token);
      if (!f) return send(res, 403, { error: 'Sai mã' });
      log(`${f.exam.title} / ${f.room} tải file đề (mã hoá)`);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(encFile(f.exam.id)).size, 'Cache-Control': 'no-store' });
      return fs.createReadStream(encFile(f.exam.id)).pipe(res);
    }
    if (p === '/api/key') {
      const f = findRoomByToken(q.token);
      if (!f) return send(res, 403, { error: 'Sai mã' });
      if (!released(f.exam)) { log(`${f.exam.title} / ${f.room} xin khoá TRƯỚC GIỜ – từ chối`); return send(res, 403, { error: 'Chưa đến giờ' }); }
      const key = unwrapKey(f.exam);
      if (!key) return send(res, 503, { error: masterKey ? 'Bài này không mở được – báo admin' : 'Admin chưa nạp khoá' });
      log(`${f.exam.title} / ${f.room} nhận khoá`);
      return send(res, 200, { key: key.toString('base64') });
    }
    if (p === '/api/report' && req.method === 'POST') {
      const b = await readJsonBody(req), f = findRoomByToken(b.token);
      if (!f) return send(res, 403, {});
      const l = liveOf(f.exam), s = l.rooms[f.room], st = String(b.status || '').slice(0, 60);
      if (s.status !== st) log(`${f.exam.title} / ${f.room}: ${st}`);
      Object.assign(s, { status: st, pos: +b.pos || 0, dur: +b.dur || 0, activated: !!b.activated, lastSeen: Date.now(), ip });
      return send(res, 200, { playAt: l.playAt, released: released(f.exam), title: f.exam.title, t0: f.exam.t0 });
    }

    // ---------- Đăng nhập tài khoản ----------
    if (p === '/api/t/login' && req.method === 'POST') {
      if (blocked('t:' + ip)) return send(res, 429, { error: 'Nhập sai quá nhiều lần, thử lại sau 10 phút' });
      const b = await readJsonBody(req), name = String(b.username || '').trim().toLowerCase();
      const user = users.find(x => x.username === name);
      if (!user || !same(hashPw(b.password || '', user.salt), user.hash)) { fail('t:' + ip); log(`Đăng nhập tài khoản SAI "${name.slice(0, 40)}" từ ${ip}`); return send(res, 403, { error: 'Sai tên đăng nhập hoặc mật khẩu' }); }
      const t = crypto.randomBytes(32).toString('hex');
      sessions.set(t, { userId: user.id, exp: Date.now() + SESSION_MS });
      log(`${user.name} đăng nhập từ ${ip}`);
      const secure = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { role: user.role }, { 'Set-Cookie': `s=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
    }
    if (p === '/api/t/logout' && req.method === 'POST') {
      sessions.delete(cookie(req, 's'));
      return send(res, 200, {}, { 'Set-Cookie': 's=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }

    // ---------- Giáo viên: chỉ thấy bài của mình ----------
    if (p.startsWith('/api/t/')) {
      const user = currentUser(req);
      if (!user) { req.resume(); return send(res, 403, { error: 'Chưa đăng nhập' }); }
      const a = p.slice(7), post = req.method === 'POST';
      if (a === 'me') return send(res, 200, { now: Date.now(), user: { name: user.name, role: user.role }, publicKey: school?.publicKey || null, keyId: school?.keyId || null,
        exams: exams.filter(e => e.teacherId === user.id).map(e => ({ id: e.id, title: e.title, size: e.size, dur: e.dur, uploadedAt: e.uploadedAt, t0: e.t0, roomCount: Object.keys(e.rooms || {}).length, oldKey: e.keyId !== school?.keyId })) });
      if (post && a === 'chunk') {
        try { return send(res, 200, { got: await receiveChunk(req, q, user) }); }
        catch (e) { log('Lỗi nhận file đề: ' + e.message); return send(res, 400, { error: e.message }); }
      }
      if (post && a === 'finish') {
        const b = await readJsonBody(req);
        try { const e = await finishUpload(b, user); log(`${user.name} đăng bài "${e.title}" (${(e.size / 1048576).toFixed(1)} MB)`); return send(res, 200, { id: e.id }); }
        catch (e) { log('Lỗi đăng bài: ' + e.message); return send(res, 400, { error: e.message }); }
      }
      if (post && a === 'delete') {
        const b = await readJsonBody(req), e = findExam(b.id);
        if (!e || e.teacherId !== user.id) return send(res, 404, { error: 'Không tìm thấy bài' });
        if (e.t0) return send(res, 400, { error: 'Bài đã xếp lịch – nhờ admin xoá' });
        deleteExam(e); log(`${user.name} xoá bài "${e.title}"`);
        return send(res, 200, {});
      }
      if (post && a === 'password') {
        const b = await readJsonBody(req);
        if (!same(hashPw(b.old || '', user.salt), user.hash)) return send(res, 400, { error: 'Mật khẩu hiện tại không đúng' });
        if (String(b.password || '').length < 6) return send(res, 400, { error: 'Mật khẩu mới phải từ 6 ký tự' });
        setPassword(user, b.password); log(`${user.name} đổi mật khẩu`);
        return send(res, 200, {});
      }
      return send(res, 404, { error: 'Không tìm thấy' });
    }

    // ---------- Admin ----------
    if (p.startsWith('/api/admin/')) {
      const local = isLocal(req), sessionUser = currentUser(req);
      const admin = sessionUser && sessionUser.role === 'admin' ? sessionUser : null;
      if (!local && !admin) { req.resume(); return send(res, 403, { error: 'Cần đăng nhập tài khoản admin' }); }
      const a = p.slice(11), post = req.method === 'POST', who = admin ? admin.name : 'Admin (máy chủ)';

      if (a === 'status') return send(res, 200, adminStatus(req, admin));
      if (!post) return send(res, 404, { error: 'Không tìm thấy' });
      const b = await readJsonBody(req, 20000);

      if (a === 'school-key') {
        let pub, pem;
        try { pub = crypto.createPublicKey(String(b.publicKey || '')); pem = pub.export({ type: 'spki', format: 'pem' }); } catch { return send(res, 400, { error: 'Khoá công khai không hợp lệ' }); }
        if (pub.asymmetricKeyType !== 'rsa' || pub.asymmetricKeyDetails.modulusLength < 2048) return send(res, 400, { error: 'Khoá công khai quá yếu' });
        school = { publicKey: String(pem), keyId: crypto.createHash('sha256').update(String(pem)).digest('hex').slice(0, 16), createdAt: Date.now() };
        writeJson(SCHOOL_FILE, school); masterKey = null; badExams = [];
        log(`${who}: tạo khoá trường mới`);
        return send(res, 200, {});
      }
      if (a === 'key') {
        const err = loadMasterKey(String(b.key || ''));
        if (err) { log(`${who}: nạp khoá SAI`); return send(res, 400, { error: err }); }
        log(`${who}: đã nạp khoá trường` + (badExams.length ? ` (${badExams.length} bài không mở được)` : ''));
        return send(res, 200, { bad: badExams.length });
      }
      if (a === 'unkey') { masterKey = null; badExams = []; log(`${who}: gỡ khoá khỏi máy chủ`); return send(res, 200, {}); }

      if (a === 'user-create') {
        const name = String(b.name || '').trim().slice(0, 80), username = String(b.username || '').trim().toLowerCase();
        if (!name) return send(res, 400, { error: 'Chưa nhập họ tên' });
        if (!/^[a-z0-9._-]{3,30}$/.test(username)) return send(res, 400, { error: 'Tên đăng nhập 3–30 ký tự, không dấu, không khoảng trắng' });
        if (users.some(x => x.username === username)) return send(res, 400, { error: 'Tên đăng nhập đã có' });
        const role = b.role === 'admin' ? 'admin' : 'teacher', password = genPassword();
        createUser(name, username, role, password); log(`${who}: tạo tài khoản ${username} (${role})`);
        return send(res, 200, { username, password });
      }
      if (a === 'user-reset' || a === 'user-delete') {
        const target = users.find(x => x.id === b.id);
        if (!target) return send(res, 404, { error: 'Không tìm thấy tài khoản' });
        endSessionsOf(target.id);
        if (a === 'user-reset') { const password = genPassword(); setPassword(target, password); log(`${who}: đặt lại mật khẩu ${target.username}`); return send(res, 200, { username: target.username, password }); }
        users = users.filter(x => x !== target); saveUsers(); log(`${who}: xoá tài khoản ${target.username} (giữ các bài đã đăng)`);
        return send(res, 200, {});
      }

      if (a === 'ktv-create') {
        const name = String(b.name || '').trim().slice(0, 80);
        if (!name) return send(res, 400, { error: 'Chưa nhập họ tên' });
        if (ktvs.some(k => k.name.toLowerCase() === name.toLowerCase())) return send(res, 400, { error: 'Tên này đã có trong danh sách' });
        const k = { id: crypto.randomBytes(6).toString('hex'), name };
        ktvs.push(k); saveKtvs(); log(`${who}: thêm kỹ thuật viên ${name}`);
        return send(res, 200, k);
      }
      if (a === 'ktv-delete') {
        const k = ktvs.find(x => x.id === b.id);
        if (!k) return send(res, 404, { error: 'Không tìm thấy kỹ thuật viên' });
        ktvs = ktvs.filter(x => x !== k); saveKtvs();
        for (const e of exams) for (const [r, id] of Object.entries(e.ktv || {})) if (id === k.id) delete e.ktv[r];
        saveExams(); log(`${who}: xoá kỹ thuật viên ${k.name} (các phòng của người này thành chưa phân)`);
        return send(res, 200, {});
      }
      if (a === 'link-set') {
        if (!local) return send(res, 403, { error: 'Thao tác này chỉ làm được trên máy chủ' });
        const url = String(b.url || '').trim().replace(/\/+$/, ''), secret = String(b.secret || '').trim();
        if (!/^https:\/\/[a-z0-9.-]+$/.test(url) || !secret) return send(res, 400, { error: 'Cần địa chỉ https:// và mã link' });
        link = { url, secret }; writeJson(LINK_FILE, link); log(`${who}: đặt link ngắn ${url}`);
        if (tunnel.url) publishLink(tunnel.url);
        return send(res, 200, {});
      }
      if (a === 'tunnel-start' || a === 'tunnel-stop') {
        if (!local) return send(res, 403, { error: 'Thao tác này chỉ làm được trên máy chủ' });
        if (a === 'tunnel-start') startTunnel(); else stopTunnel();
        return send(res, 200, {});
      }

      // Phát đồng loạt: một lệnh có thể áp dụng cho nhiều bài, mọi phòng bắt đầu cùng một thời điểm
      if (a === 'play') {
        const list = (Array.isArray(b.ids) ? b.ids : []).map(findExam).filter(Boolean);
        const ready = list.filter(e => released(e) && !!unwrapKey(e));
        if (!ready.length) return send(res, 400, { error: 'Chưa có bài nào đến giờ và đã có khoá' });
        const at = Date.now() + 5000;
        for (const e of ready) liveOf(e).playAt = at;
        log(`${who}: lệnh phát đồng loạt ${ready.map(e => `"${e.title}"`).join(', ')}`);
        return send(res, 200, { playAt: at, count: ready.length });
      }
      if (a === 'cancel') {
        for (const e of (Array.isArray(b.ids) ? b.ids : []).map(findExam).filter(Boolean)) { liveOf(e).playAt = null; log(`${who}: huỷ lệnh phát "${e.title}"`); }
        return send(res, 200, {});
      }

      const e = findExam(b.id);
      if (!e) return send(res, 404, { error: 'Không tìm thấy bài' });
      if (a === 'schedule') {
        const t0 = Date.parse(b.t0), assign = b.assign && typeof b.assign === 'object' ? b.assign : {}, rooms = Object.keys(assign);
        if (isNaN(t0)) return send(res, 400, { error: 'Giờ thi không hợp lệ' });
        if (!rooms.length) return send(res, 400, { error: 'Chưa chọn phòng nào trên sơ đồ' });
        if (rooms.some(r => !ROOM_IDS.has(r))) return send(res, 400, { error: 'Có phòng không nằm trên sơ đồ' });
        if (rooms.some(r => assign[r] && !ktvs.some(k => k.id === assign[r]))) return send(res, 400, { error: 'Có kỹ thuật viên không còn trong danh sách' });
        if (liveOf(e).playAt) return send(res, 400, { error: 'Bài đã có lệnh phát – không đổi lịch được' });
        const clash = roomClash(e, t0, rooms);
        if (clash) return send(res, 400, { error: clash });
        schedule(e, t0, assign); log(`${who}: xếp lịch "${e.title}" lúc ${new Date(t0).toLocaleString('vi-VN')}, ${rooms.length} phòng`);
        return send(res, 200, {});
      }
      if (a === 'release') { liveOf(e).force = true; log(`${who}: MỞ KHOÁ KHẨN CẤP "${e.title}"`); return send(res, 200, {}); }
      if (a === 'delete') { deleteExam(e); log(`${who}: xoá bài "${e.title}" của ${e.teacherName}`); return send(res, 200, {}); }
    }
    send(res, 404, { error: 'Không tìm thấy' });
  } catch (e) { log('Lỗi: ' + e.message); if (!res.headersSent) send(res, 500, { error: 'Lỗi máy chủ' }); }
}).on('error', e => {
  if (e.code === 'EADDRINUSE') { console.log(`\nChương trình đã đang chạy (cổng ${PORT} bận). Mở trình duyệt vào http://localhost:${PORT}/a`); openBrowser(); setTimeout(() => process.exit(), 4000); }
  else console.log(e);
}).listen(PORT, () => {
  log(`Máy chủ chạy tại http://localhost:${PORT}  (admin: /a · giáo viên: /g · kỹ thuật viên: /) · Node ${process.version}`);
  if (fs.existsSync(path.join(DATA, 'config.json'))) log('LƯU Ý: có đề kiểu cũ trong data/config.json. Bản này không dùng đề đó; hãy đăng lại bài qua trang giáo viên.');
  console.log('Giữ cửa sổ này MỞ trong suốt buổi thi. Đóng cửa sổ = tắt chương trình.\n');
  openBrowser();
});

function openBrowser() {
  if (process.env.NO_OPEN) return;
  const url = `http://localhost:${PORT}/a`;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}
