// Luồng chính: tạo trường → đăng bài → xếp giờ → máy phòng tải sớm → xin khoá trước giờ bị từ chối
// → đúng giờ nhận khoá, giải mã ra đúng file gốc → phát đồng loạt, phòng sát vách sang đợt 2.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startWorker, browser, sleep, uploadExam, decryptLikeRoom, hex, MAP, SUPER_TOKEN } from './helpers.mjs';

let w, base;
const S = {};   // trạng thái dùng chung giữa các bước
before(async () => { w = await startWorker(); base = w.base; });
after(() => w && w.stop());

const superCall = (path, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + SUPER_TOKEN, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json() }));

test('siêu admin tạo trường; sai mã siêu admin bị từ chối', async () => {
  const bad = await fetch(base + '/api/truong', { method: 'POST', headers: { authorization: 'Bearer sai' }, body: '{}' });
  assert.equal(bad.status, 403);
  const r = await superCall('/api/truong', { slug: 'thu', ten: 'Trường Thử', ban_do: MAP, admin: { name: 'Admin Thử', username: 'admin' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  S.adminPw = r.data.password;
  const r2 = await superCall('/api/truong', { slug: 'thu2', ten: 'Trường Khác', ban_do: MAP, admin: { name: 'Admin Khác', username: 'admin' } });
  assert.equal(r2.status, 200);
  S.admin2Pw = r2.data.password;
});

test('trang của trường được phục vụ', async () => {
  for (const [p, mark] of [['/thu/a', 'admin'], ['/thu/g', 'teacher'], ['/thu/', 'room'], ['/thu/K7M2', 'room']]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /text\/html/);
  }
  assert.equal((await fetch(base + '/khongco/api/time')).status, 404);
});

test('admin đăng nhập, tạo giáo viên và kỹ thuật viên', async () => {
  S.a = browser(base);
  assert.equal((await S.a('/thu/api/t/login', { body: { username: 'admin', password: 'sai' } })).status, 403);
  const l = await S.a('/thu/api/t/login', { body: { username: 'admin', password: S.adminPw } });
  assert.equal(l.status, 200); assert.equal(l.data.role, 'admin');
  const t = await S.a('/thu/api/admin/user-create', { body: { name: 'Cô Lan', username: 'lan' } });
  assert.equal(t.status, 200); S.teacherPw = t.data.password;
  const k = await S.a('/thu/api/admin/ktv-create', { body: { name: 'Anh Minh' } });
  assert.equal(k.status, 200); S.ktv = k.data.id;
});

test('giáo viên đăng bài (mã hoá trong "trình duyệt", file nhiều phần) và bài được kiểm tra giải mã được', async () => {
  S.g = browser(base);
  assert.equal((await S.g('/thu/api/t/login', { body: { username: 'lan', password: S.teacherPw } })).status, 200);
  S.me = (await S.g('/thu/api/t/me')).data;
  assert.match(S.me.publicKey, /BEGIN PUBLIC KEY/);
  assert.equal((await S.g('/thu/api/admin/status')).status, 403, 'giáo viên không vào được API admin');
  S.plain = new Uint8Array(randomBytes(9 * 1048576));   // > 8 MB → 2 phần
  const r = await uploadExam(S.g, S.me, S.plain, 'Bài nghe 1');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.verified, 1);
  S.exam = r.data.id;
  const small = await uploadExam(S.g, S.me, new Uint8Array(randomBytes(50000)), 'Bài nghe 2');
  assert.equal(small.status, 200); S.exam2 = small.data.id;
});

test('bài đăng với khoá sai bị phát hiện ngay lúc đăng', async () => {
  const other = (await browser(base)('/thu2/api/t/login', { body: { username: 'admin', password: S.admin2Pw } }));
  assert.equal(other.status, 200);
  // bọc khoá bằng khoá công khai của TRƯỜNG KHÁC → máy chủ không mở được
  const a2 = browser(base); await a2('/thu2/api/t/login', { body: { username: 'admin', password: S.admin2Pw } });
  const me2 = (await a2('/thu2/api/t/me')).data;
  const r = await uploadExam(S.g, { ...S.me, publicKey: me2.publicKey }, new Uint8Array(randomBytes(1000)), 'Bài hỏng');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /không giải mã được/);
});

test('admin xếp giờ và phân phòng; mã phòng giữ nguyên khi xếp lại', async () => {
  S.t0 = Date.now() + 12000;
  const r = await S.a('/thu/api/admin/schedule', { body: { id: S.exam, t0: new Date(S.t0).toISOString(), assign: { P101: S.ktv, P102: S.ktv, P103: '' } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const clash = await S.a('/thu/api/admin/schedule', { body: { id: S.exam2, t0: new Date(S.t0).toISOString(), assign: { P101: '' } } });
  assert.equal(clash.status, 400, 'một phòng không phát hai bài trùng giờ');
  const st = (await S.a('/thu/api/admin/status')).data;
  S.codes = st.exams.find(e => e.id === S.exam).codes;
  assert.deepEqual(Object.keys(S.codes), ['P101', 'P102', 'P103']);
  await S.a('/thu/api/admin/schedule', { body: { id: S.exam, t0: new Date(S.t0).toISOString(), assign: { P101: S.ktv, P102: S.ktv, P103: '' } } });
  assert.deepEqual((await S.a('/thu/api/admin/status')).data.exams.find(e => e.id === S.exam).codes, S.codes);
  assert.equal((await S.g('/thu/api/t/delete', { body: { id: S.exam } })).status, 400, 'giáo viên không xoá được bài đã xếp lịch');
});

test('máy phòng tải bản mã sớm; xin khoá trước giờ bị từ chối', async () => {
  S.rooms = {};
  for (const room of ['P101', 'P102', 'P103']) {
    const r = await fetch(`${base}/thu/api/login?code=${S.codes[room].toLowerCase()}`).then(r => r.json());
    assert.equal(r.room, room);
    S.rooms[room] = r.token;
  }
  const res = await fetch(`${base}/thu/api/audio?token=${S.rooms.P101}`);
  assert.equal(res.status, 200);
  S.enc = new Uint8Array(await res.arrayBuffer());
  const login = await fetch(`${base}/thu/api/login?token=${S.rooms.P101}`).then(r => r.json());
  assert.equal(hex(await crypto.subtle.digest('SHA-256', S.enc)), login.sha256);
  const part = await fetch(`${base}/thu/api/audio?token=${S.rooms.P101}`, { headers: { range: 'bytes=100-199' } });
  assert.equal(part.status, 206); assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.ok(Date.now() < S.t0 - 1000, 'bước này phải chạy trước giờ thi');
  const k = await fetch(`${base}/thu/api/key?token=${S.rooms.P101}`);
  assert.equal(k.status, 403);
  assert.equal((await k.json()).error, 'Chưa đến giờ');
  const rep = await fetch(`${base}/thu/api/report?token=${S.rooms.P101}`, { method: 'POST', body: JSON.stringify({ status: 'đã tải', dur: 0 }) }).then(r => r.json());
  assert.equal(rep.released, false);
  assert.equal((await fetch(`${base}/thu/api/key?token=${'0'.repeat(64)}`)).status, 403);
});

test('mã/thẻ phòng của trường này không dùng được ở trường khác', async () => {
  assert.equal((await fetch(`${base}/thu2/api/login?code=${S.codes.P101}`)).status, 403);
  assert.equal((await fetch(`${base}/thu2/api/audio?token=${S.rooms.P101}`)).status, 403);
  assert.equal((await fetch(`${base}/thu2/api/key?token=${S.rooms.P101}`)).status, 403);
  const a2 = browser(base); await a2('/thu2/api/t/login', { body: { username: 'admin', password: S.admin2Pw } });
  const st = (await a2('/thu2/api/admin/status')).data;
  assert.equal(st.exams.length, 0, 'admin trường khác không thấy bài');
  assert.equal((await a2('/thu2/api/admin/release', { body: { id: S.exam } })).status, 404);
  assert.equal((await a2('/thu/api/admin/status')).status, 403, 'cookie trường khác không dùng được');
});

test('WebSocket máy phòng nhận trạng thái và lệnh phát', async () => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/thu/api/ws?token=${S.rooms.P102}`);
  S.wsMsgs = [];
  ws.onmessage = e => S.wsMsgs.push(JSON.parse(e.data));
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  ws.send(JSON.stringify({ status: 'sẵn sàng phát', dur: 3 }));
  await sleep(500);
  assert.ok(S.wsMsgs.length >= 1);
  assert.equal(S.wsMsgs[0].released, false);
  S.ws = ws;
});

test('đúng giờ: phòng nhận khoá và giải mã ra đúng file gốc', async () => {
  await sleep(Math.max(0, S.t0 - Date.now() + 300));
  const k = await fetch(`${base}/thu/api/key?token=${S.rooms.P101}`);
  assert.equal(k.status, 200);
  const plain = await decryptLikeRoom(S.enc, (await k.json()).key);
  assert.equal(plain.length, S.plain.length);
  assert.ok(Buffer.from(plain).equals(Buffer.from(S.plain)));
});

test('phát đồng loạt: phòng sát vách chia 2 đợt, WebSocket nhận lệnh ngay', async () => {
  for (const room of ['P101', 'P103']) await fetch(`${base}/thu/api/report?token=${S.rooms[room]}`, { method: 'POST', body: JSON.stringify({ status: 'sẵn sàng phát', dur: 3 }) });
  const r = await S.a('/thu/api/admin/play', { body: { ids: [S.exam] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.wave2, 1);                       // 101-102-103 liền nhau → 102 sang đợt 2
  assert.equal(r.data.playAt2, r.data.playAt + 3000 + 10000);
  const r101 = await fetch(`${base}/thu/api/report?token=${S.rooms.P101}`, { method: 'POST', body: '{}' }).then(r => r.json());
  assert.equal(r101.playAt, r.data.playAt); assert.equal(r101.wave, 1);
  await sleep(300);
  const last = S.wsMsgs.at(-1);
  assert.equal(last.wave, 2); assert.equal(last.playAt, r.data.playAt2);
  const st = (await S.a('/thu/api/admin/status')).data.exams.find(e => e.id === S.exam);
  assert.equal(st.rooms.P102.status, 'sẵn sàng phát');
  assert.equal(st.rooms.P101.status, '');
  assert.equal((await S.a('/thu/api/admin/schedule', { body: { id: S.exam, t0: new Date().toISOString(), assign: { P101: '' } } })).status, 400, 'đã có lệnh phát thì không đổi lịch');
  S.ws.close();
});

test('mở khoá khẩn cấp trước giờ', async () => {
  const t0 = Date.now() + 3600000;
  assert.equal((await S.a('/thu/api/admin/schedule', { body: { id: S.exam2, t0: new Date(t0).toISOString(), assign: { P104: '' } } })).status, 200);
  const st = (await S.a('/thu/api/admin/status')).data.exams.find(e => e.id === S.exam2);
  const tok = (await fetch(`${base}/thu/api/login?code=${st.codes.P104}`).then(r => r.json())).token;
  assert.equal((await fetch(`${base}/thu/api/key?token=${tok}`)).status, 403);
  assert.equal((await S.g('/thu/api/admin/release', { body: { id: S.exam2 } })).status, 403, 'giáo viên không mở khoá được');
  assert.equal((await S.a('/thu/api/admin/release', { body: { id: S.exam2 } })).status, 200);
  assert.equal((await fetch(`${base}/thu/api/key?token=${tok}`)).status, 200);
});

test('nhập sai mã 20 lần bị chặn, máy đã vào vẫn chạy', async () => {
  let last;
  for (let i = 0; i < 21; i++) last = await fetch(`${base}/thu/api/login?code=ZZZZ`);
  assert.equal(last.status, 429);
  assert.equal((await fetch(`${base}/thu/api/login?token=${S.rooms.P101}`)).status, 200);
});

test('nhật ký ghi lại lần xin khoá trước giờ', async () => {
  const logs = (await S.a('/thu/api/admin/log')).data.map(x => x.msg);
  assert.ok(logs.some(m => /xin khoá TRƯỚC GIỜ/.test(m)));
  assert.ok(logs.some(m => /nhận khoá/.test(m)));
});
