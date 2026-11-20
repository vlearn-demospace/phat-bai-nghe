// Siêu admin (VLearn) quản lý trường; admin trường sửa sơ đồ phòng.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Script } from 'node:vm';
import { startWorker, browser, uploadExam, MAP, SUPER_TOKEN } from './helpers.mjs';

let w, base;
const S = {};
before(async () => { w = await startWorker(); base = w.base; });
after(() => w && w.stop());
const sup = (path, body) => fetch(base + '/api/' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + SUPER_TOKEN, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  .then(async r => ({ status: r.status, data: await r.json() }));

test('trang siêu admin và ban-do.js được phục vụ; API cần mã', async () => {
  const r = await fetch(base + '/_');
  assert.equal(r.status, 200); assert.match(await r.text(), /Quản lý trường/);
  const js = await fetch(base + '/ban-do.js');
  assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(base + '/api/truong/x')).status, 403);
});

test('tạo trường: sơ đồ lỗi bị từ chối, sơ đồ đúng được làm sạch', async () => {
  const dup = [{ title: 'A', floors: [{ n: 1, rooms: [['101', 'X'], ['101', 'Y']] }] }];
  assert.match((await sup('truong', { slug: 'sa', ten: 'T', ban_do: dup, admin: { name: 'A', username: 'admin' } })).data.error, /lặp/);
  assert.match((await sup('truong', { slug: 'sa', ten: 'T', ban_do: [{ title: 'A', floors: [{ n: 1, rooms: [['1 0', 'X']] }] }], admin: { name: 'A', username: 'admin' } })).data.error, /không hợp lệ/);
  const r = await sup('truong', { slug: 'sa', ten: 'Trường SA', ban_do: MAP, admin: { name: 'Admin', username: 'admin' } });
  assert.equal(r.status, 200);
  S.pw = r.data.password;
  const one = await sup('truong/sa');
  assert.equal(one.data.ten, 'Trường SA'); assert.deepEqual(one.data.admins, [{ name: 'Admin', username: 'admin' }]);
  assert.equal(one.data.ban_do[0].floors[0].rooms.length, 5);
});

test('danh sách trường có số bài, dung lượng, số giáo viên', async () => {
  S.a = browser(base);
  assert.equal((await S.a('/sa/api/t/login', { body: { username: 'admin', password: S.pw } })).status, 200);
  const tp = (await S.a('/sa/api/admin/user-create', { body: { name: 'GV', username: 'giaovien' } })).data.password;
  S.g = browser(base);
  assert.equal((await S.g('/sa/api/t/login', { body: { username: 'giaovien', password: tp } })).status, 200);
  const up = await uploadExam(S.g, (await S.g('/sa/api/t/me')).data, new Uint8Array(randomBytes(5000)), 'Bài 1', {}, 'sa');
  assert.equal(up.status, 200); S.id = up.data.id;
  const t = (await sup('truong')).data.find(x => x.slug === 'sa');
  assert.equal(t.so_bai, 1); assert.equal(t.so_gv, 1); assert.ok(t.dung_luong > 5000); assert.ok(t.hoat_dong > 0);
});

test('hết hạn: không đăng bài mới; tạm khoá: cả trường bị chặn', async () => {
  assert.equal((await sup('truong/sa', { goi: 'nam-hoc', het_han: Date.now() - 1000 })).status, 200);
  const r = await S.g('/sa/api/t/upload-start', { body: { size: 1000 } });
  assert.equal(r.status, 403); assert.match(r.data.error, /hết hạn/);
  assert.equal((await S.a('/sa/api/admin/status')).status, 200, 'hết hạn vẫn xem được');
  assert.equal((await sup('truong/sa', { het_han: null, khoa: true })).status, 200);
  assert.equal((await S.a('/sa/api/admin/status')).status, 403);
  assert.equal((await sup('truong/sa', { khoa: false })).status, 200);
  assert.equal((await S.g('/sa/api/t/upload-start', { body: { size: 1000 } })).status, 200);
  assert.equal((await sup('truong')).data.find(x => x.slug === 'sa').goi, 'nam-hoc');
});

test('cấp lại mật khẩu admin: mật khẩu cũ và phiên cũ hết hiệu lực', async () => {
  const r = await sup('truong/sa/reset-admin', { username: 'admin' });
  assert.equal(r.status, 200);
  assert.equal((await S.a('/sa/api/admin/status')).status, 403, 'phiên cũ bị đăng xuất');
  assert.equal((await S.a('/sa/api/t/login', { body: { username: 'admin', password: S.pw } })).status, 403);
  assert.equal((await S.a('/sa/api/t/login', { body: { username: 'admin', password: r.data.password } })).status, 200);
  assert.match((await sup('truong/sa/reset-admin', { username: 'giaovien' })).data.error, /giáo viên/);
  const n = await sup('truong/sa/reset-admin', { username: 'admin2', name: 'Phó admin' });
  assert.equal(n.status, 200);
  assert.equal((await browser(base)('/sa/api/t/login', { body: { username: 'admin2', password: n.data.password } })).data.role, 'admin');
});

test('admin sửa sơ đồ: phòng đang có lịch thi không xoá được, phòng mới xếp lịch được', async () => {
  assert.equal((await S.a('/sa/api/admin/schedule', { body: { id: S.id, t0: new Date(Date.now() + 3600e3).toISOString(), assign: { P104: '' } } })).status, 200);
  const noP104 = [{ title: 'KHU THỬ', floors: [{ n: 1, rooms: [['101', 'A'], ['102', 'B'], ['103', 'C']] }] }];
  const busy = await S.a('/sa/api/admin/ban-do', { body: { ban_do: noP104 } });
  assert.equal(busy.status, 400); assert.match(busy.data.error, /P\.104 đang có lịch thi/);
  assert.match((await S.a('/sa/api/admin/ban-do', { body: { ban_do: [] } })).data.error, /1–20 khu/);
  assert.equal((await S.g('/sa/api/admin/ban-do', { body: { ban_do: MAP } })).status, 403, 'giáo viên không sửa được');
  const more = [{ title: 'KHU MỚI', floors: [{ n: 2, wait: 'PHÒNG ĐỢI', rooms: [['104', 'D'], null, ['105', 'E']] }] }];
  assert.equal((await S.a('/sa/api/admin/ban-do', { body: { ban_do: more } })).status, 200);
  const st = (await S.a('/sa/api/admin/status')).data;
  assert.deepEqual(st.map, [{ ...more[0], floors: [{ ...more[0].floors[0], n: '2' }] }]);
  assert.equal((await S.a('/sa/api/admin/schedule', { body: { id: S.id, t0: new Date(Date.now() + 3600e3).toISOString(), assign: { P104: '', P105: '' } } })).status, 200);
  assert.match((await S.a('/sa/api/admin/schedule', { body: { id: S.id, t0: new Date(Date.now() + 3600e3).toISOString(), assign: { P101: '' } } })).data.error, /không nằm trên sơ đồ/);
});

test('mã JavaScript của mọi trang dịch được (không lỗi cú pháp)', async () => {
  for (const js of ['/ban-do.js', '/qrcode.js']) { const r = await fetch(base + js); assert.equal(r.status, 200, js); new Script(await r.text()); }
  for (const p of ['/', '/_', '/sa/a', '/sa/g', '/sa/']) {
    const html = await (await fetch(base + p)).text(), scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(scripts.length, p);
    for (const s of scripts) assert.doesNotThrow(() => new Script(s), p);
  }
});

