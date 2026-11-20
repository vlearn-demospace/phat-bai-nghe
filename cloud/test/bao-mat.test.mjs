// Bảo mật tài khoản: xác thực 2 lớp (TOTP), khoá tài khoản khi nhập sai nhiều, mã phòng chỉ hiệu lực quanh giờ thi,
// giới hạn tần suất đăng nhập.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { startWorker, browser, uploadExam, MAP, SUPER_TOKEN } from './helpers.mjs';
import { totpAt } from '../src/lib.js';

let w, base;
const S = {};
before(async () => { w = await startWorker(); base = w.base; });
after(() => w && w.stop());
const sup = (path, body) => fetch(base + '/api/' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + SUPER_TOKEN, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  .then(async r => ({ status: r.status, data: await r.json() }));
// Mỗi bước dùng một "IP" riêng để bộ đếm theo IP của bước này không ảnh hưởng bước khác
const from = (ip, b = browser(base)) => (path, opts = {}) => b(path, { ...opts, headers: { ...(opts.headers || {}), 'cf-connecting-ip': ip } });

// TOTP độc lập (node:crypto), như ứng dụng trên điện thoại
const unb32 = s => { let bits = 0, v = 0; const out = []; for (const c of s) { v = (v << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
function phone(secretB32, step = Math.floor(Date.now() / 30000)) {
  const msg = Buffer.alloc(8); msg.writeUInt32BE(Math.floor(step / 2 ** 32), 0); msg.writeUInt32BE(step % 2 ** 32, 4);
  const h = createHmac('sha1', unb32(secretB32)).update(msg).digest(), o = h[19] & 15;
  return String(h.readUInt32BE(o) % 0x80000000 % 1e6).padStart(6, '0');
}

test('TOTP đúng vector chuẩn RFC 6238 (giây 59 → 287082)', async () => {
  assert.equal(await totpAt(new TextEncoder().encode('12345678901234567890'), 1), '287082');
  assert.equal(await totpAt(new TextEncoder().encode('12345678901234567890'), Math.floor(1111111109 / 30)), '081804');
});

test('chuẩn bị trường, admin, giáo viên', async () => {
  const r = await sup('truong', { slug: 'bm', ten: 'Trường BM', ban_do: MAP, admin: { name: 'Admin', username: 'admin' } });
  S.pw = r.data.password;
  S.a = from('10.0.0.1');
  assert.equal((await S.a('/bm/api/t/login', { body: { username: 'admin', password: S.pw } })).status, 200);
  S.tp = (await S.a('/bm/api/admin/user-create', { body: { name: 'GV', username: 'giaovien' } })).data.password;
});

test('bật 2 lớp: mã sai không bật được; bật xong đăng nhập phải có mã, mã đã dùng không dùng lại', async () => {
  const s = await S.a('/bm/api/t/2fa-setup', { body: {} });
  assert.equal(s.status, 200); assert.match(s.data.uri, /^otpauth:\/\/totp\//); assert.match(s.data.secret, /^[A-Z2-7]{32}$/);
  S.secret = s.data.secret;
  assert.equal((await S.a('/bm/api/t/2fa-enable', { body: { code: '000000' === phone(S.secret) ? '111111' : '000000' } })).status, 400);
  const used = phone(S.secret);
  assert.equal((await S.a('/bm/api/t/2fa-enable', { body: { code: used } })).status, 200);
  const st = (await S.a('/bm/api/admin/status')).data;
  assert.equal(st.user.totp, true); assert.equal(st.users.find(u => u.username === 'admin').totp, true);
  assert.equal((await S.a('/bm/api/t/2fa-setup', { body: {} })).status, 400, 'đang bật thì không tạo khoá mới');

  const b = from('10.0.0.2');
  const noCode = await b('/bm/api/t/login', { body: { username: 'admin', password: S.pw } });
  assert.equal(noCode.status, 401); assert.equal(noCode.data.need2fa, true);
  assert.equal((await b('/bm/api/admin/status')).status, 403, 'chưa nhập mã thì chưa có phiên');
  assert.equal((await b('/bm/api/t/login', { body: { username: 'admin', password: S.pw, code: used } })).status, 401, 'mã vừa dùng để bật không dùng lại được');
  const next = phone(S.secret, Math.floor(Date.now() / 30000) + 1);
  assert.equal((await b('/bm/api/t/login', { body: { username: 'admin', password: S.pw, code: next } })).status, 200);
  assert.equal((await b('/bm/api/admin/status')).status, 200);
  assert.equal((await from('10.0.0.3')('/bm/api/t/login', { body: { username: 'admin', password: S.pw, code: next } })).status, 401, 'mỗi mã chỉ dùng một lần');
});

test('tắt 2 lớp cần đúng mật khẩu và mã; VLearn cấp lại mật khẩu thì gỡ 2 lớp', async () => {
  assert.match((await S.a('/bm/api/t/2fa-disable', { body: { password: 'sai', code: phone(S.secret) } })).data.error, /Mật khẩu/);
  const r = await sup('truong/bm/reset-admin', { username: 'admin' });
  assert.equal(r.status, 200);
  const b = from('10.0.0.4');
  assert.equal((await b('/bm/api/t/login', { body: { username: 'admin', password: r.data.password } })).status, 200, 'không cần mã nữa');
  assert.equal((await b('/bm/api/admin/status')).data.user.totp, false);
  S.a = b; S.pw = r.data.password;
});

test('nhập sai mật khẩu 10 lần: khoá tài khoản 15 phút, kể cả từ IP khác và mật khẩu đúng', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await from('10.1.0.' + i)('/bm/api/t/login', { body: { username: 'giaovien', password: 'sai' + i } })).status, 403);
  const r = await from('10.1.1.1')('/bm/api/t/login', { body: { username: 'giaovien', password: S.tp } });
  assert.equal(r.status, 429); assert.match(r.data.error, /15 phút/);
  assert.equal((await from('10.1.1.2')('/bm/api/t/login', { body: { username: 'admin', password: S.pw } })).status, 200, 'tài khoản khác không bị ảnh hưởng');
  const reset = await S.a('/bm/api/admin/user-reset', { body: { id: (await S.a('/bm/api/admin/status')).data.users.find(u => u.username === 'giaovien').id } });
  assert.equal((await from('10.1.1.3')('/bm/api/t/login', { body: { username: 'giaovien', password: reset.data.password } })).status, 200, 'admin đặt lại mật khẩu thì mở khoá');
  S.tp = reset.data.password;
});

test('mã phòng chỉ dùng được từ 24 giờ trước giờ thi đến 3 giờ sau khi thi xong', async () => {
  const g = from('10.2.0.1');
  assert.equal((await g('/bm/api/t/login', { body: { username: 'giaovien', password: S.tp } })).status, 200);
  const up = await uploadExam(g, (await g('/bm/api/t/me')).data, new Uint8Array(randomBytes(3000)), 'Bài BM', { dur: 1800 }, 'bm');
  const sched = t0 => S.a('/bm/api/admin/schedule', { body: { id: up.data.id, t0: new Date(t0).toISOString(), assign: { P101: '' } } });
  const login = async () => fetch(`${base}/bm/api/login?code=${(await S.a('/bm/api/admin/status')).data.exams[0].codes.P101}`, { headers: { 'cf-connecting-ip': '10.2.0.9' } });

  assert.equal((await sched(Date.now() + 25 * 3600e3)).status, 200);
  const early = await login();
  assert.equal(early.status, 403);
  const wrong = await fetch(`${base}/bm/api/login?code=ZZZZ`, { headers: { 'cf-connecting-ip': '10.2.0.8' } });
  assert.equal((await early.json()).error, (await wrong.json()).error, 'mã đúng nhưng sớm và mã sai trả cùng một câu');

  assert.equal((await sched(Date.now() + 23 * 3600e3)).status, 200);
  const ok = await login();
  assert.equal(ok.status, 200);
  const token = (await ok.json()).token;

  assert.equal((await sched(Date.now() - 4 * 3600e3)).status, 200);   // thi xong 3,5 giờ trước
  assert.equal((await login()).status, 403, 'quá hạn');
  assert.equal((await fetch(`${base}/bm/api/login?token=${token}`)).status, 200, 'máy đã vào bằng thẻ vẫn dùng được');
});

test('bắt buộc 2 lớp cho admin: admin chưa bật chỉ được bật 2 lớp; không ai tắt được', async () => {
  assert.match((await S.a('/bm/api/admin/bat-buoc-2fa', { body: { on: true } })).data.error, /chính tài khoản của bạn/);
  const sec = (await S.a('/bm/api/t/2fa-setup', { body: {} })).data.secret;
  assert.equal((await S.a('/bm/api/t/2fa-enable', { body: { code: phone(sec) } })).status, 200);
  assert.equal((await S.a('/bm/api/admin/bat-buoc-2fa', { body: { on: true } })).status, 200);
  assert.equal((await S.a('/bm/api/admin/status')).data.school.batBuoc2fa, true);
  const pw2 = (await S.a('/bm/api/admin/user-create', { body: { name: 'Phó admin', username: 'admin2', role: 'admin' } })).data.password;

  const b = from('10.4.0.1');
  assert.equal((await b('/bm/api/t/login', { body: { username: 'admin2', password: pw2 } })).status, 200, 'mật khẩu đúng thì vào, để bật 2 lớp');
  const st = await b('/bm/api/admin/status');
  assert.equal(st.status, 403); assert.equal(st.data.need2faSetup, true); assert.equal(st.data.user.name, 'Phó admin');
  assert.equal((await b('/bm/api/admin/user-create', { body: { name: 'X', username: 'xxx' } })).status, 403, 'chưa bật 2 lớp thì không làm được việc admin');
  assert.equal((await b('/bm/api/t/upload-start', { body: { size: 1000 } })).status, 403);
  assert.equal((await b('/bm/api/t/me')).status, 200);
  const sec2 = (await b('/bm/api/t/2fa-setup', { body: {} })).data.secret;
  assert.equal((await b('/bm/api/t/2fa-enable', { body: { code: phone(sec2) } })).status, 200);
  assert.equal((await b('/bm/api/admin/status')).status, 200, 'bật xong dùng được ngay');
  assert.match((await b('/bm/api/t/2fa-disable', { body: { password: pw2, code: phone(sec2, Math.floor(Date.now() / 30000) + 1) } })).data.error, /bắt buộc/);

  const g = from('10.4.0.2');
  assert.equal((await g('/bm/api/t/login', { body: { username: 'giaovien', password: S.tp } })).status, 200);
  assert.equal((await g('/bm/api/t/me')).status, 200, 'giáo viên không bị ảnh hưởng');

  assert.equal((await sup('truong/bm')).data.bat_buoc_2fa, 1);
  assert.equal((await sup('truong/bm', { bat_buoc_2fa: false })).status, 200);
  assert.equal((await S.a('/bm/api/admin/status')).data.school.batBuoc2fa, false);
});

test('giới hạn tần suất: quá 30 lần đăng nhập/phút từ một IP bị chặn ngay', async () => {
  const b = from('10.3.0.1');
  const codes = [];
  for (let i = 0; i < 35; i++) codes.push((await b('/bm/api/t/login', { body: { username: 'khongco' + i, password: 'x' } })).status);
  assert.ok(codes.includes(429), codes.join(','));
  const r = await b('/bm/api/t/login', { body: { username: 'giaovien', password: S.tp } });
  assert.equal(r.status, 429);
  assert.equal((await from('10.3.0.2')('/bm/api/t/login', { body: { username: 'giaovien', password: S.tp } })).status, 200, 'IP khác vẫn vào được');
});
