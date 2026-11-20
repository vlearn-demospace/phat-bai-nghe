// Worker "phat-bai-nghe": trang tĩnh + API cho nhiều trường.
// Đường dẫn: /<trường>/a (admin) · /<trường>/g (giáo viên) · /<trường>/ hoặc /<trường>/K7M2 (máy phòng)
import { json, same, hashPw, randHex, genCode, norm, CODE_LEN, sha256, hex, newSchoolKeys, keyIdOf, checkPublicKeyPem, roomIds, cleanMap, log, seal, unseal, base32, totpCheck } from './lib.js';
export { Truong } from './truong.js';

const SESSION_MS = 30 * 86400000;           // giáo viên
const ADMIN_SESSION_MS = 7 * 86400000;      // admin: phiên ngắn hơn
const FAIL_IP = 20, FAIL_USER = 10, FAIL_WINDOW = 15 * 60000;   // đăng nhập sai: theo IP / theo tài khoản
const PART = 8 * 1048576;                  // R2 multipart: mọi phần (trừ phần cuối) cùng cỡ, tối thiểu 5 MiB
const MAX_FILE = 500 * 1048576;
const RESERVED = new Set(['api', 'a', 'g', 'static', 'admin', 'www', 'huong-dan']);

const page = (env, req, file) => env.ASSETS.fetch(new Request(new URL('/' + file, req.url), req))
  .then(r => new Response(r.body, { status: r.status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }));
const cookie = (req, name) => { const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)')); return m ? m[1] : ''; };
const body = req => req.json().catch(() => ({}));
const genPassword = () => genCode(8);
const r2Key = (tid, id) => `t/${tid}/bai/${id}.enc`;
function sameOrigin(req) { const o = req.headers.get('origin'); if (!o) return true; try { return new URL(o).host === new URL(req.url).host; } catch { return false; } }

export default {
  async fetch(req, env) {
    const u = new URL(req.url), parts = u.pathname.split('/').filter(Boolean);
    const ip = req.headers.get('cf-connecting-ip') || '127.0.0.1';
    try {
      if (!parts.length) return page(env, req, 'index.html');
      if (parts.length === 1 && parts[0] === '_') return page(env, req, 'super.html');   // trang siêu admin VLearn
      if (parts.length === 1 && parts[0] === 'huong-dan') return page(env, req, 'huong-dan.html');
      if (parts.length === 1 && /^[\w.-]+\.(css|js|png|txt|ico)$/.test(parts[0])) return env.ASSETS.fetch(req);   // vlearn.css, logo, robots.txt
      if (req.method === 'POST' && !sameOrigin(req)) return json(403, { error: 'Yêu cầu không hợp lệ' });
      if (parts[0] === 'api') return await superApi(req, env, parts.slice(1));

      const t = await env.DB.prepare('SELECT * FROM truong WHERE slug = ?').bind(parts[0].toLowerCase()).first();
      if (!t) return parts.length === 1 ? page(env, req, 'index.html') : json(404, { error: 'Không có trường này' });
      if (t.khoa) return json(403, { error: 'Trường đang tạm khoá – liên hệ VLearn' });
      const rest = parts.slice(1);
      if (!rest.length) return page(env, req, 'room.html');
      if (rest.length === 1 && rest[0] === 'a') return page(env, req, 'admin.html');
      if (rest.length === 1 && rest[0] === 'g') return page(env, req, 'teacher.html');
      if (rest.length === 1 && new RegExp(`^[A-Za-z0-9]{${CODE_LEN}}$`).test(rest[0])) return page(env, req, 'room.html');
      if (rest[0] !== 'api') return json(404, { error: 'Không tìm thấy' });
      return await schoolApi(req, env, t, rest.slice(1), ip);
    } catch (e) {
      console.error(e);
      return json(500, { error: 'Lỗi máy chủ' });
    }
  },
};

// ---------- Siêu admin (VLearn): tạo trường bằng SUPER_TOKEN ----------
async function superApi(req, env, p) {
  if (!env.SUPER_TOKEN || !same(req.headers.get('authorization') || '', 'Bearer ' + env.SUPER_TOKEN)) return json(403, { error: 'Không có quyền' });
  const DB = env.DB;
  if (p[0] === 'truong' && p.length === 1 && req.method === 'GET')
    return json(200, (await DB.prepare(`SELECT t.id, t.slug, t.ten, t.goi, t.het_han, t.khoa, t.created_at,
        (SELECT COUNT(*) FROM bai b WHERE b.truong_id = t.id) AS so_bai, (SELECT COALESCE(SUM(size), 0) FROM bai b WHERE b.truong_id = t.id) AS dung_luong,
        (SELECT COUNT(*) FROM users u WHERE u.truong_id = t.id AND u.role = 'teacher') AS so_gv, (SELECT MAX(at) FROM nhat_ky n WHERE n.truong_id = t.id) AS hoat_dong
      FROM truong t ORDER BY t.created_at`).all()).results);
  if (p[0] === 'truong' && p.length >= 2) {
    const t = await DB.prepare('SELECT * FROM truong WHERE slug = ?').bind(String(p[1]).toLowerCase()).first();
    if (!t) return json(404, { error: 'Không có trường này' });
    if (p.length === 2 && req.method === 'GET') {
      const admins = (await DB.prepare("SELECT name, username, totp_on FROM users WHERE truong_id = ? AND role = 'admin' ORDER BY created_at").bind(t.id).all()).results;
      return json(200, { slug: t.slug, ten: t.ten, goi: t.goi, het_han: t.het_han, khoa: t.khoa, bat_buoc_2fa: t.bat_buoc_2fa, ban_do: JSON.parse(t.ban_do), lan_key: !!t.lan_public_key, admins });
    }
    if (req.method !== 'POST') return json(404, { error: 'Không tìm thấy' });
    const b = await body(req);
    if (p.length === 2) {   // sửa tên, gói, hạn dùng, tạm khoá, sơ đồ
      const set = {}, msg = [];
      if (b.ten !== undefined) { set.ten = String(b.ten).trim().slice(0, 120); if (!set.ten) return json(400, { error: 'Chưa nhập tên trường' }); msg.push('tên'); }
      if (b.goi !== undefined) { set.goi = String(b.goi).trim().slice(0, 30) || 'thu'; msg.push('gói ' + set.goi); }
      if (b.het_han !== undefined) { set.het_han = b.het_han ? +b.het_han : null; if (set.het_han !== null && !(set.het_han > 0)) return json(400, { error: 'Hạn dùng không hợp lệ' }); msg.push('hạn dùng'); }
      if (b.bat_buoc_2fa !== undefined) { set.bat_buoc_2fa = b.bat_buoc_2fa ? 1 : 0; msg.push(set.bat_buoc_2fa ? 'bắt buộc 2 lớp cho admin' : 'bỏ bắt buộc 2 lớp'); }
      if (b.khoa !== undefined) { set.khoa = b.khoa ? 1 : 0; msg.push(set.khoa ? 'TẠM KHOÁ' : 'mở khoá'); }
      if (b.ban_do !== undefined) {
        const m = cleanMap(b.ban_do); if (m.error) return json(400, { error: m.error });
        const e = await busyRooms(env, t, m.map); if (e) return json(400, { error: e });
        set.ban_do = JSON.stringify(m.map); msg.push('sơ đồ');
      }
      const keys = Object.keys(set);
      if (!keys.length) return json(400, { error: 'Không có gì để sửa' });
      await DB.prepare(`UPDATE truong SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ?`).bind(...keys.map(k => set[k]), t.id).run();
      await log(env, t.id, `VLearn sửa: ${msg.join(', ')}`);
      return json(200, {});
    }
    if (p[2] === 'reset-admin') {   // cấp lại mật khẩu admin trường (hoặc tạo admin mới nếu chưa có tên đăng nhập này)
      const username = String(b.username || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) return json(400, { error: 'Tên đăng nhập 3–30 ký tự, không dấu' });
      const u = await DB.prepare('SELECT * FROM users WHERE truong_id = ? AND username = ?').bind(t.id, username).first();
      if (u && u.role !== 'admin') return json(400, { error: 'Tài khoản này là giáo viên, không phải admin' });
      const password = genPassword(), salt = randHex(16), hash = await hashPw(password, salt);
      if (u) await DB.batch([DB.prepare('UPDATE users SET salt = ?, hash = ?, totp_on = 0, totp_secret = NULL, totp_last = 0 WHERE id = ?').bind(salt, hash, u.id),   // mất điện thoại: VLearn cấp lại cả 2 lớp
        DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id), DB.prepare('DELETE FROM dang_nhap_sai WHERE k = ?').bind(`u:${t.id}:${username}`)]);
      else {
        const name = String(b.name || '').trim().slice(0, 80) || 'Admin';
        await DB.prepare('INSERT INTO users (id, truong_id, name, username, role, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(randHex(6), t.id, name, username, 'admin', salt, hash, Date.now()).run();
      }
      await log(env, t.id, `VLearn ${u ? 'cấp lại mật khẩu (và gỡ xác thực 2 lớp)' : 'tạo'} admin ${username}`);
      return json(200, { username, password });
    }
    return json(404, { error: 'Không tìm thấy' });
  }
  if (p[0] === 'truong' && req.method === 'POST') {
    const b = await body(req), slug = String(b.slug || '').toLowerCase(), ten = String(b.ten || '').trim().slice(0, 120);
    if (!/^[a-z0-9-]{2,30}$/.test(slug) || RESERVED.has(slug)) return json(400, { error: 'Mã trường 2–30 ký tự a-z, 0-9, -' });
    if (!ten) return json(400, { error: 'Chưa nhập tên trường' });
    const m = cleanMap(b.ban_do);
    if (m.error) return json(400, { error: 'Sơ đồ phòng: ' + m.error });
    const admin = b.admin || {}, username = String(admin.username || '').trim().toLowerCase(), name = String(admin.name || '').trim().slice(0, 80);
    if (!name || !/^[a-z0-9._-]{3,30}$/.test(username)) return json(400, { error: 'Thiếu họ tên / tên đăng nhập admin trường' });
    if (await env.DB.prepare('SELECT 1 FROM truong WHERE slug = ?').bind(slug).first()) return json(400, { error: 'Mã trường đã có' });
    const keys = await newSchoolKeys(env), id = randHex(6), password = genPassword(), salt = randHex(16);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO truong (id, slug, ten, ban_do, public_key, wrapped_private, goi, het_han, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, slug, ten, JSON.stringify(m.map), keys.publicKey, keys.wrappedPrivate, String(b.goi || 'thu'), b.het_han ? +b.het_han : null, Date.now()),
      env.DB.prepare('INSERT INTO users (id, truong_id, name, username, role, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(randHex(6), id, name, username, 'admin', salt, await hashPw(password, salt), Date.now()),
    ]);
    await log(env, id, `VLearn tạo trường ${ten} (${slug}), admin ${username}`);
    return json(200, { id, slug, username, password });
  }
  return json(404, { error: 'Không tìm thấy' });
}

// ---------- Một trường ----------
async function currentUser(req, env, t) {
  const tok = cookie(req, 's');
  if (!/^[0-9a-f]{64}$/.test(tok)) return null;
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE token_hash = ? AND truong_id = ?').bind(await sha256(tok), t.id).first();
  if (!s || s.exp < Date.now()) return null;
  return env.DB.prepare('SELECT * FROM users WHERE id = ? AND truong_id = ?').bind(s.user_id, t.id).first();
}
// Chống dò mật khẩu: đếm trên D1 nên không mất khi Worker khởi động lại hay chạy nhiều nơi
async function isBlocked(env, k, max) {
  const r = await env.DB.prepare('SELECT n, t FROM dang_nhap_sai WHERE k = ?').bind(k).first();
  return !!r && r.n >= max && Date.now() - r.t < FAIL_WINDOW;
}
async function addFail(env, k) {
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO dang_nhap_sai (k, n, t) VALUES (?1, 1, ?2)
    ON CONFLICT(k) DO UPDATE SET n = CASE WHEN ?2 - t > ?3 THEN 1 ELSE n + 1 END, t = CASE WHEN ?2 - t > ?3 THEN ?2 ELSE t END`).bind(k, now, FAIL_WINDOW).run();
}

async function schoolApi(req, env, t, p, ip) {
  const a = p.join('/'), post = req.method === 'POST', stub = env.TRUONG.get(env.TRUONG.idFromName(t.id));
  if (a === 'time') return json(200, { now: Date.now() });

  // Máy phòng: đăng nhập, xin khoá, báo trạng thái, WebSocket → Durable Object
  if (['login', 'key', 'report', 'ws'].includes(a)) {
    const h = new Headers(req.headers); h.set('x-truong', t.id); h.set('x-ip', ip);
    return stub.fetch(new Request(req, { headers: h }));
  }
  if (a === 'audio') {   // bản mã: tải bất kỳ lúc nào, cần thẻ phòng
    const tok = new URL(req.url).searchParams.get('token') || '';
    const row = /^[0-9a-f]{64}$/.test(tok) && await env.DB.prepare('SELECT b.id, b.title, p.room FROM phong p JOIN bai b ON b.id = p.bai_id WHERE p.truong_id = ? AND p.token = ?').bind(t.id, tok).first();
    if (!row) return json(403, { error: 'Sai mã' });
    const range = req.headers.get('range');
    const obj = await env.R2.get(r2Key(t.id, row.id), range ? { range: req.headers } : {});
    if (!obj) return json(404, { error: 'Không thấy file' });
    if (!range) await log(env, t.id, `${row.title} / ${row.room} tải file đề (mã hoá)`);
    const h = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    if (range && obj.range) {
      const { offset = 0, length = obj.size - offset } = obj.range;
      return new Response(obj.body, { status: 206, headers: { ...h, 'Content-Length': length, 'Content-Range': `bytes ${offset}-${offset + length - 1}/${obj.size}` } });
    }
    return new Response(obj.body, { headers: { ...h, 'Content-Length': obj.size } });
  }

  // ---------- Đăng nhập tài khoản ----------
  const path = `/${t.slug}`;
  if (a === 't/login' && post) {
    if (env.LIMIT && !(await env.LIMIT.limit({ key: 'login:' + ip })).success) return json(429, { error: 'Thử đăng nhập quá nhanh – đợi một phút' });
    const b = await body(req), name = String(b.username || '').trim().toLowerCase().slice(0, 40);
    const kIp = 'ip:' + ip, kUser = `u:${t.id}:${name}`;
    if (await isBlocked(env, kIp, FAIL_IP) || await isBlocked(env, kUser, FAIL_USER)) return json(429, { error: 'Nhập sai quá nhiều lần – thử lại sau 15 phút' });
    const user = await env.DB.prepare('SELECT * FROM users WHERE truong_id = ? AND username = ?').bind(t.id, name).first();
    if (!user || !same(await hashPw(b.password || '', user.salt), user.hash)) {
      await addFail(env, kIp); await addFail(env, kUser);
      await log(env, t.id, `Đăng nhập tài khoản SAI "${name}" từ ${ip}`);
      return json(403, { error: 'Sai tên đăng nhập hoặc mật khẩu' });
    }
    if (user.totp_on) {   // xác thực 2 lớp
      if (!b.code) return json(401, { need2fa: true, error: 'Nhập mã 6 số trên ứng dụng xác thực' });
      const step = await totpCheck(await unseal(env, user.totp_secret), b.code, user.totp_last);
      if (step < 0) {
        await addFail(env, kIp); await addFail(env, kUser);
        await log(env, t.id, `${user.name}: mã xác thực 2 lớp SAI từ ${ip}`);
        return json(401, { need2fa: true, error: 'Mã xác thực không đúng hoặc đã dùng – đợi mã mới' });
      }
      await env.DB.prepare('UPDATE users SET totp_last = ? WHERE id = ?').bind(step, user.id).run();
    }
    await env.DB.prepare('DELETE FROM dang_nhap_sai WHERE k = ?').bind(kUser).run();
    const ms = user.role === 'admin' ? ADMIN_SESSION_MS : SESSION_MS, tok = randHex(32);
    await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, truong_id, exp) VALUES (?, ?, ?, ?)').bind(await sha256(tok), user.id, t.id, Date.now() + ms).run();
    await log(env, t.id, `${user.name} đăng nhập từ ${ip}` + (user.totp_on ? ' (2 lớp)' : ''));
    const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
    return json(200, { role: user.role }, { 'Set-Cookie': `s=${tok}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${ms / 1000}${secure}` });
  }
  if (a === 't/logout' && post) {
    const tok = cookie(req, 's');
    if (tok) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(tok)).run();
    return json(200, {}, { 'Set-Cookie': `s=; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=0` });
  }

  const user = await currentUser(req, env, t);
  if (!user) return json(403, { error: 'Chưa đăng nhập' });
  // Trường bắt buộc 2 lớp: admin chưa bật chỉ được làm đúng việc bật 2 lớp (và đăng xuất, xem tên mình)
  if (t.bat_buoc_2fa && user.role === 'admin' && !user.totp_on && !['t/me', 't/2fa-setup', 't/2fa-enable', 't/password'].includes(a))
    return json(403, { error: 'Trường bắt buộc xác thực 2 lớp cho admin – hãy bật ngay', need2faSetup: true, user: { name: user.name }, school: { ten: t.ten } });
  if (p[0] === 't') return teacherApi(req, env, t, user, p[1], post);
  if (p[0] === 'admin') {
    if (user.role !== 'admin') return json(403, { error: 'Cần đăng nhập tài khoản admin' });
    return adminApi(req, env, t, user, p[1], post, stub);
  }
  return json(404, { error: 'Không tìm thấy' });
}

// ---------- Giáo viên: chỉ thấy bài của mình ----------
async function teacherApi(req, env, t, user, a, post) {
  const DB = env.DB;
  if (a === 'me') {
    const exams = (await DB.prepare('SELECT b.*, (SELECT COUNT(*) FROM phong p WHERE p.bai_id = b.id) AS room_count FROM bai b WHERE truong_id = ? AND teacher_id = ? ORDER BY uploaded_at').bind(t.id, user.id).all()).results;
    return json(200, { now: Date.now(), user: { name: user.name, role: user.role, totp: !!user.totp_on }, school: t.ten, publicKey: t.public_key, keyId: await keyIdOf(t.public_key), lanPublicKey: t.lan_public_key || null, lanKeyId: t.lan_public_key ? await keyIdOf(t.lan_public_key) : null, part: PART,
      exams: exams.map(e => ({ id: e.id, title: e.title, size: e.size, dur: e.dur, uploadedAt: e.uploaded_at, t0: e.t0, roomCount: e.room_count, verified: e.verified })) });
  }
  if (post && a === 'upload-start') {
    if (t.het_han && Date.now() > t.het_han) return json(403, { error: 'Gói dịch vụ của trường đã hết hạn – không đăng được bài mới (bài đã xếp lịch vẫn thi bình thường)' });
    const b = await body(req), size = +b.size;
    if (!(size > 28 && size <= MAX_FILE)) return json(400, { error: 'File quá lớn (tối đa 500 MB)' });
    await DB.prepare('DELETE FROM tai_len WHERE created_at < ?').bind(Date.now() - 86400000).run();
    const id = randHex(6), mpu = await env.R2.createMultipartUpload(r2Key(t.id, id));
    await DB.prepare('INSERT INTO tai_len (id, truong_id, user_id, upload_id, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, t.id, user.id, mpu.uploadId, Date.now()).run();
    return json(200, { id, part: PART });
  }
  if (post && (a === 'upload-part' || a === 'upload-finish' || a === 'upload-abort')) {
    const q = new URL(req.url).searchParams, b = a === 'upload-part' ? null : await body(req), id = a === 'upload-part' ? q.get('id') : b.id;
    const up = await DB.prepare('SELECT * FROM tai_len WHERE id = ? AND truong_id = ? AND user_id = ?').bind(String(id || ''), t.id, user.id).first();
    if (!up) return json(400, { error: 'Phiên tải lên đã hết hạn – bấm đăng lại' });
    const mpu = env.R2.resumeMultipartUpload(r2Key(t.id, up.id), up.upload_id);
    if (a === 'upload-part') {
      const n = parseInt(q.get('n')), data = await req.arrayBuffer();
      if (!(n >= 1 && n <= 10000) || data.byteLength > PART) return json(400, { error: 'Phần dữ liệu không hợp lệ' });
      const part = await mpu.uploadPart(n, data);
      return json(200, { partNumber: part.partNumber, etag: part.etag });
    }
    const drop = async () => { try { await mpu.abort(); } catch {} await DB.prepare('DELETE FROM tai_len WHERE id = ?').bind(up.id).run(); };
    if (a === 'upload-abort') { await drop(); return json(200, {}); }
    const fail = async msg => { await drop(); await env.R2.delete(r2Key(t.id, up.id)); await log(env, t.id, 'Lỗi đăng bài: ' + msg); return json(400, { error: msg }); };
    const keyId = await keyIdOf(t.public_key);
    if (b.keyId !== keyId) return fail('Khoá trường vừa đổi – tải lại trang rồi đăng lại');
    if (!/^audio\/[\w.+-]+$/.test(b.mime || '')) return fail('Định dạng âm thanh không hợp lệ: ' + b.mime);
    if (!/^[A-Za-z0-9+/=]{100,2000}$/.test(b.wrappedKey || '')) return fail('Khoá của bài không hợp lệ');
    if (b.lanWrappedKey && !/^[A-Za-z0-9+/=]{100,2000}$/.test(b.lanWrappedKey)) return fail('Khoá LAN của bài không hợp lệ');
    const lanKeyId = b.lanWrappedKey && t.lan_public_key ? await keyIdOf(t.lan_public_key) : null;
    if (b.lanWrappedKey && b.lanKeyId !== lanKeyId) return fail('Khoá LAN vừa đổi – tải lại trang rồi đăng lại');
    let obj;
    try { obj = await mpu.complete((Array.isArray(b.parts) ? b.parts : []).map(x => ({ partNumber: +x.partNumber, etag: String(x.etag) }))); }
    catch (e) { return fail('Máy chủ chưa nhận đủ file – bấm đăng lại'); }
    if (obj.size !== +b.size) return fail(`File nhận được không đủ (${obj.size}/${b.size} byte) – bấm đăng lại`);
    const ds = new crypto.DigestStream('SHA-256');
    await (await env.R2.get(r2Key(t.id, up.id))).body.pipeTo(ds);
    const sha = hex(await ds.digest);
    if (b.sha256 && b.sha256 !== sha) return fail('File nhận được bị sai lệch – bấm đăng lại');
    const title = String(b.title || 'Bài thi nghe').trim().slice(0, 120) || 'Bài thi nghe';
    await DB.batch([
      DB.prepare('INSERT INTO bai (id, truong_id, title, teacher_id, teacher_name, mime, size, sha256, dur, wrapped_key, lan_wrapped_key, lan_key_id, key_id, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(up.id, t.id, title, user.id, user.name, b.mime, obj.size, sha, +b.dur || 0, b.wrappedKey, lanKeyId ? b.lanWrappedKey : null, lanKeyId, keyId, Date.now()),
      DB.prepare('DELETE FROM tai_len WHERE id = ?').bind(up.id),
    ]);
    const v = await env.TRUONG.get(env.TRUONG.idFromName(t.id)).verify(up.id);
    await log(env, t.id, `${user.name} đăng bài "${title}" (${(obj.size / 1048576).toFixed(1)} MB)` + (v < 0 ? ' – KHÔNG MỞ ĐƯỢC' : ''));
    if (v < 0) return json(400, { error: 'Bài vừa đăng không giải mã được – bấm đăng lại', id: up.id });
    return json(200, { id: up.id, verified: v });
  }
  if (post && a === 'delete') {
    const b = await body(req), e = await DB.prepare('SELECT * FROM bai WHERE id = ? AND truong_id = ? AND teacher_id = ?').bind(String(b.id || ''), t.id, user.id).first();
    if (!e) return json(404, { error: 'Không tìm thấy bài' });
    if (e.t0) return json(400, { error: 'Bài đã xếp lịch – nhờ admin xoá' });
    await deleteExam(env, t, e); await log(env, t.id, `${user.name} xoá bài "${e.title}"`);
    return json(200, {});
  }
  if (post && (a === '2fa-setup' || a === '2fa-enable' || a === '2fa-disable')) {
    const b = await body(req);
    if (a === '2fa-setup') {   // tạo khoá mới (chưa bật cho đến khi nhập đúng mã)
      if (user.totp_on) return json(400, { error: 'Xác thực 2 lớp đang bật' });
      const secret = crypto.getRandomValues(new Uint8Array(20));
      await DB.prepare('UPDATE users SET totp_secret = ?, totp_last = 0 WHERE id = ?').bind(await seal(env, secret), user.id).run();
      const label = encodeURIComponent(`Phát bài nghe (${t.slug}):${user.username}`);
      return json(200, { secret: base32(secret), uri: `otpauth://totp/${label}?secret=${base32(secret)}&issuer=${encodeURIComponent('Phát bài nghe')}&digits=6&period=30` });
    }
    if (a === '2fa-enable') {
      if (user.totp_on || !user.totp_secret) return json(400, { error: 'Bấm "Bật xác thực 2 lớp" lại từ đầu' });
      const step = await totpCheck(await unseal(env, user.totp_secret), b.code, 0);
      if (step < 0) return json(400, { error: 'Mã chưa đúng – kiểm tra giờ trên điện thoại và nhập mã đang hiện' });
      await DB.batch([DB.prepare('UPDATE users SET totp_on = 1, totp_last = ? WHERE id = ?').bind(step, user.id),
        DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, await sha256(cookie(req, 's')))]);
      await log(env, t.id, `${user.name} bật xác thực 2 lớp (đăng xuất các máy khác)`);
      return json(200, {});
    }
    if (!user.totp_on) return json(400, { error: 'Xác thực 2 lớp chưa bật' });
    if (t.bat_buoc_2fa && user.role === 'admin') return json(400, { error: 'Trường đang bắt buộc 2 lớp cho admin – không tắt được' });
    if (!same(await hashPw(b.password || '', user.salt), user.hash)) return json(400, { error: 'Mật khẩu không đúng' });
    if (await totpCheck(await unseal(env, user.totp_secret), b.code, user.totp_last) < 0) return json(400, { error: 'Mã xác thực không đúng' });
    await DB.prepare('UPDATE users SET totp_on = 0, totp_secret = NULL, totp_last = 0 WHERE id = ?').bind(user.id).run();
    await log(env, t.id, `${user.name} TẮT xác thực 2 lớp`);
    return json(200, {});
  }
  if (post && a === 'password') {
    const b = await body(req);
    if (!same(await hashPw(b.old || '', user.salt), user.hash)) return json(400, { error: 'Mật khẩu hiện tại không đúng' });
    if (String(b.password || '').length < 6) return json(400, { error: 'Mật khẩu mới phải từ 6 ký tự' });
    const salt = randHex(16);
    await DB.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').bind(salt, await hashPw(b.password, salt), user.id).run();
    await log(env, t.id, `${user.name} đổi mật khẩu`);
    return json(200, {});
  }
  return json(404, { error: 'Không tìm thấy' });
}

// Không cho bỏ khỏi sơ đồ một phòng còn đang có lịch thi (bài chưa thi xong)
async function busyRooms(env, t, map) {
  const keep = roomIds(map), now = Date.now();
  const rows = (await env.DB.prepare('SELECT b.title, b.t0, b.dur, p.room FROM phong p JOIN bai b ON b.id = p.bai_id WHERE p.truong_id = ? AND b.t0 IS NOT NULL').bind(t.id).all()).results;
  const gone = rows.filter(r => !keep.has(r.room) && r.t0 + (r.dur || 3600) * 1000 > now);
  return gone.length ? `Phòng ${[...new Set(gone.map(r => 'P.' + r.room.slice(1)))].join(', ')} đang có lịch thi ("${gone[0].title}") – bỏ phòng khỏi lịch thi trước khi xoá khỏi sơ đồ` : null;
}

async function deleteExam(env, t, e) {
  await env.DB.batch([env.DB.prepare('DELETE FROM phong WHERE bai_id = ?').bind(e.id), env.DB.prepare('DELETE FROM bai WHERE id = ?').bind(e.id)]);
  await env.R2.delete(r2Key(t.id, e.id));
  await env.TRUONG.get(env.TRUONG.idFromName(t.id)).reset(e.id);
}

// ---------- Admin trường ----------
async function adminApi(req, env, t, user, a, post, stub) {
  const DB = env.DB, who = user.name, map = JSON.parse(t.ban_do);
  if (a === 'status' || a === 'log') {
    if (a === 'log') return json(200, (await DB.prepare('SELECT at, msg FROM nhat_ky WHERE truong_id = ? ORDER BY id DESC LIMIT 500').bind(t.id).all()).results);
    const [exams, rooms, users, ktvs, live] = await Promise.all([
      DB.prepare('SELECT * FROM bai WHERE truong_id = ? ORDER BY uploaded_at').bind(t.id).all(),
      DB.prepare('SELECT bai_id, room, code, ktv_id FROM phong WHERE truong_id = ? ORDER BY room').bind(t.id).all(),
      DB.prepare('SELECT u.id, u.name, u.username, u.role, u.created_at, u.totp_on, (SELECT COUNT(*) FROM bai b WHERE b.teacher_id = u.id) AS exam_count FROM users u WHERE truong_id = ? ORDER BY created_at').bind(t.id).all(),
      DB.prepare('SELECT id, name FROM ktv WHERE truong_id = ? ORDER BY name').bind(t.id).all(),
      stub.liveState(),
    ]);
    const now = Date.now(), lanId = t.lan_public_key ? await keyIdOf(t.lan_public_key) : null;
    return json(200, {
      now, user: { name: user.name, username: user.username, totp: !!user.totp_on }, school: { ten: t.ten, slug: t.slug, goi: t.goi, hetHan: t.het_han, lanKey: !!t.lan_public_key, batBuoc2fa: !!t.bat_buoc_2fa }, map, ktvs: ktvs.results,
      users: users.results.map(u => ({ id: u.id, name: u.name, username: u.username, role: u.role, createdAt: u.created_at, examCount: u.exam_count, totp: !!u.totp_on })),
      exams: exams.results.map(e => {
        const l = live.live[e.id] || {}, mine = rooms.results.filter(r => r.bai_id === e.id), st = live.rooms[e.id] || {};
        return { id: e.id, title: e.title, teacherName: e.teacher_name, teacherId: e.teacher_id, mime: e.mime, size: e.size, dur: e.dur, uploadedAt: e.uploaded_at, t0: e.t0, verified: e.verified,
          bad: e.verified < 0, lan: !!lanId && e.lan_key_id === lanId, released: !!e.t0 && (!!l.force || now >= e.t0), force: !!l.force, playAt: l.playAt || null, playAt2: l.playAt2 || null, wave2: l.wave2 || [],
          codes: Object.fromEntries(mine.map(r => [r.room, r.code])), ktv: Object.fromEntries(mine.filter(r => r.ktv_id).map(r => [r.room, r.ktv_id])),
          rooms: Object.fromEntries(mine.map(r => [r.room, st[r.room] || { status: 'chưa kết nối', lastSeen: 0, pos: 0, dur: 0, activated: false, ip: '' }])) };
      }),
    });
  }
  if (a === 'lan-package') {   // gói dự phòng: dữ liệu theo đúng dạng thư mục data/ của bản LAN (server.js)
    if (!t.lan_public_key) return json(400, { error: 'Trường chưa tạo khoá LAN dự phòng' });
    const lanId = await keyIdOf(t.lan_public_key);
    const [exams, rooms, ktvs] = await Promise.all([
      DB.prepare('SELECT * FROM bai WHERE truong_id = ? ORDER BY uploaded_at').bind(t.id).all(),
      DB.prepare('SELECT bai_id, room, code, ktv_id FROM phong WHERE truong_id = ? ORDER BY room').bind(t.id).all(),
      DB.prepare('SELECT id, name FROM ktv WHERE truong_id = ? ORDER BY name').bind(t.id).all(),
    ]);
    const ok = exams.results.filter(e => e.lan_key_id === lanId && e.lan_wrapped_key);
    await log(env, t.id, `${who}: tải gói dự phòng LAN (${ok.length} bài)`);
    return json(200, {
      school: { publicKey: t.lan_public_key, keyId: lanId, createdAt: Date.now() },
      map,
      ktvs: ktvs.results,
      exams: ok.map(e => {
        const mine = rooms.results.filter(r => r.bai_id === e.id);
        return { id: e.id, title: e.title, teacherId: e.teacher_id, teacherName: e.teacher_name, mime: e.mime, size: e.size, sha256: e.sha256, dur: e.dur,
          wrappedKey: e.lan_wrapped_key, keyId: lanId, uploadedAt: e.uploaded_at, t0: e.t0,
          rooms: Object.fromEntries(mine.map(r => [r.room, r.code])), ktv: Object.fromEntries(mine.filter(r => r.ktv_id).map(r => [r.room, r.ktv_id])), tokens: {} };
      }),
      missing: exams.results.filter(e => !ok.includes(e)).map(e => e.title),
    });
  }
  if (a === 'enc') {   // bản mã của một bài (admin tải về để đóng gói dự phòng)
    const e = await DB.prepare('SELECT id FROM bai WHERE id = ? AND truong_id = ?').bind(new URL(req.url).searchParams.get('id') || '', t.id).first();
    const obj = e && await env.R2.get(r2Key(t.id, e.id));
    if (!obj) return json(404, { error: 'Không thấy file' });
    return new Response(obj.body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': obj.size } });
  }
  if (!post) return json(404, { error: 'Không tìm thấy' });
  const b = await body(req);

  if (a === 'user-create') {
    const name = String(b.name || '').trim().slice(0, 80), username = String(b.username || '').trim().toLowerCase();
    if (!name) return json(400, { error: 'Chưa nhập họ tên' });
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return json(400, { error: 'Tên đăng nhập 3–30 ký tự, không dấu, không khoảng trắng' });
    if (await DB.prepare('SELECT 1 FROM users WHERE truong_id = ? AND username = ?').bind(t.id, username).first()) return json(400, { error: 'Tên đăng nhập đã có' });
    const role = b.role === 'admin' ? 'admin' : 'teacher', password = genPassword(), salt = randHex(16);
    await DB.prepare('INSERT INTO users (id, truong_id, name, username, role, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(randHex(6), t.id, name, username, role, salt, await hashPw(password, salt), Date.now()).run();
    await log(env, t.id, `${who}: tạo tài khoản ${username} (${role})`);
    return json(200, { username, password });
  }
  if (a === 'user-reset' || a === 'user-delete') {
    const target = await DB.prepare('SELECT * FROM users WHERE id = ? AND truong_id = ?').bind(String(b.id || ''), t.id).first();
    if (!target) return json(404, { error: 'Không tìm thấy tài khoản' });
    if (target.id === user.id && a === 'user-delete') return json(400, { error: 'Không tự xoá tài khoản đang dùng' });
    await DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id).run();
    if (a === 'user-reset') {
      const password = genPassword(), salt = randHex(16);
      await DB.batch([DB.prepare('UPDATE users SET salt = ?, hash = ?, totp_on = 0, totp_secret = NULL, totp_last = 0 WHERE id = ?').bind(salt, await hashPw(password, salt), target.id),
        DB.prepare('DELETE FROM dang_nhap_sai WHERE k = ?').bind(`u:${t.id}:${target.username}`)]);
      await log(env, t.id, `${who}: đặt lại mật khẩu ${target.username}` + (target.totp_on ? ' (gỡ xác thực 2 lớp)' : ''));
      return json(200, { username: target.username, password });
    }
    await DB.prepare('DELETE FROM users WHERE id = ?').bind(target.id).run();
    await log(env, t.id, `${who}: xoá tài khoản ${target.username} (giữ các bài đã đăng)`);
    return json(200, {});
  }
  if (a === 'ktv-create') {
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return json(400, { error: 'Chưa nhập họ tên' });
    if (await DB.prepare('SELECT 1 FROM ktv WHERE truong_id = ? AND lower(name) = lower(?)').bind(t.id, name).first()) return json(400, { error: 'Tên này đã có trong danh sách' });
    const k = { id: randHex(6), name };
    await DB.prepare('INSERT INTO ktv (id, truong_id, name) VALUES (?, ?, ?)').bind(k.id, t.id, name).run();
    await log(env, t.id, `${who}: thêm kỹ thuật viên ${name}`);
    return json(200, k);
  }
  if (a === 'ktv-delete') {
    const k = await DB.prepare('SELECT * FROM ktv WHERE id = ? AND truong_id = ?').bind(String(b.id || ''), t.id).first();
    if (!k) return json(404, { error: 'Không tìm thấy kỹ thuật viên' });
    await DB.batch([DB.prepare('DELETE FROM ktv WHERE id = ?').bind(k.id), DB.prepare('UPDATE phong SET ktv_id = NULL WHERE ktv_id = ? AND truong_id = ?').bind(k.id, t.id)]);
    await log(env, t.id, `${who}: xoá kỹ thuật viên ${k.name} (các phòng của người này thành chưa phân)`);
    return json(200, {});
  }
  if (a === 'bat-buoc-2fa') {
    const on = !!b.on;
    if (on && !user.totp_on) return json(400, { error: 'Hãy bật xác thực 2 lớp cho chính tài khoản của bạn trước' });
    await DB.prepare('UPDATE truong SET bat_buoc_2fa = ? WHERE id = ?').bind(on ? 1 : 0, t.id).run();
    await log(env, t.id, `${who}: ${on ? 'BẮT BUỘC' : 'bỏ bắt buộc'} xác thực 2 lớp cho admin`);
    return json(200, {});
  }
  if (a === 'ban-do') {
    const m = cleanMap(b.ban_do); if (m.error) return json(400, { error: m.error });
    const e = await busyRooms(env, t, m.map); if (e) return json(400, { error: e });
    await DB.prepare('UPDATE truong SET ban_do = ? WHERE id = ?').bind(JSON.stringify(m.map), t.id).run();
    await log(env, t.id, `${who}: sửa sơ đồ phòng (${roomIds(m.map).size} phòng)`);
    return json(200, {});
  }
  if (a === 'lan-key') {   // khoá LAN dự phòng: chỉ nhận khoá công khai, khoá riêng trường tự giữ trên USB
    if (b.publicKey && !checkPublicKeyPem(b.publicKey)) return json(400, { error: 'Khoá công khai không hợp lệ' });
    await DB.prepare('UPDATE truong SET lan_public_key = ? WHERE id = ?').bind(b.publicKey || null, t.id).run();
    await log(env, t.id, `${who}: ${b.publicKey ? 'đặt' : 'gỡ'} khoá LAN dự phòng`);
    return json(200, {});
  }
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).slice(0, 50);
  if (a === 'play') { const r = await stub.play(t.id, ids, who, map); return json(r.error ? 400 : 200, r); }
  if (a === 'cancel') { await stub.cancel(t.id, ids, who); return json(200, {}); }

  const e = await DB.prepare('SELECT * FROM bai WHERE id = ? AND truong_id = ?').bind(String(b.id || ''), t.id).first();
  if (!e) return json(404, { error: 'Không tìm thấy bài' });
  if (a === 'schedule') {
    const t0 = Date.parse(b.t0), assign = b.assign && typeof b.assign === 'object' ? b.assign : {}, rooms = Object.keys(assign).sort();
    if (isNaN(t0)) return json(400, { error: 'Giờ thi không hợp lệ' });
    if (!rooms.length) return json(400, { error: 'Chưa chọn phòng nào trên sơ đồ' });
    const valid = roomIds(map);
    if (rooms.some(r => !valid.has(r))) return json(400, { error: 'Có phòng không nằm trên sơ đồ' });
    const ktvIds = new Set((await DB.prepare('SELECT id FROM ktv WHERE truong_id = ?').bind(t.id).all()).results.map(k => k.id));
    if (rooms.some(r => assign[r] && !ktvIds.has(assign[r]))) return json(400, { error: 'Có kỹ thuật viên không còn trong danh sách' });
    if ((await stub.liveState()).live[e.id]?.playAt) return json(400, { error: 'Bài đã có lệnh phát – không đổi lịch được' });
    // Một phòng không phát hai bài trùng giờ. Bài chưa rõ độ dài tính 60 phút.
    const span = x => (x.dur || 3600) * 1000;
    const others = (await DB.prepare('SELECT b.id, b.title, b.t0, b.dur, p.room FROM bai b JOIN phong p ON p.bai_id = b.id WHERE b.truong_id = ? AND b.id != ? AND b.t0 IS NOT NULL').bind(t.id, e.id).all()).results;
    const clash = others.find(o => rooms.includes(o.room) && t0 < o.t0 + span(o) && o.t0 < t0 + span(e));
    if (clash) return json(400, { error: `P.${clash.room.slice(1)} đang dùng cho bài "${clash.title}" trùng giờ` });
    // Giữ mã các phòng đã có để phiếu đã in vẫn dùng được
    const old = Object.fromEntries((await DB.prepare('SELECT * FROM phong WHERE bai_id = ?').bind(e.id).all()).results.map(r => [r.room, r]));
    const used = new Set((await DB.prepare('SELECT code FROM phong WHERE truong_id = ?').bind(t.id).all()).results.map(r => r.code));
    const stmts = [DB.prepare('DELETE FROM phong WHERE bai_id = ?').bind(e.id)];
    for (const r of rooms) {
      let code = old[r]?.code;
      if (!code) { do code = genCode(CODE_LEN); while (used.has(code)); used.add(code); }
      stmts.push(DB.prepare('INSERT INTO phong (bai_id, truong_id, room, code, ktv_id, token) VALUES (?, ?, ?, ?, ?, ?)').bind(e.id, t.id, r, code, assign[r] || null, old[r]?.token || null));
    }
    stmts.push(DB.prepare('UPDATE bai SET t0 = ? WHERE id = ?').bind(t0, e.id));
    await DB.batch(stmts);
    if (e.t0 !== t0) await stub.reset(e.id, true);
    await log(env, t.id, `${who}: xếp lịch "${e.title}" lúc ${new Date(t0).toISOString()}, ${rooms.length} phòng`);
    return json(200, {});
  }
  if (a === 'release') { await stub.release(t.id, e.id, who); return json(200, {}); }
  if (a === 'delete') { await deleteExam(env, t, e); await log(env, t.id, `${who}: xoá bài "${e.title}" của ${e.teacher_name}`); return json(200, {}); }
  return json(404, { error: 'Không tìm thấy' });
}
