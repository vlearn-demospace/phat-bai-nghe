// Kiểm thử nhanh trên môi trường đã triển khai (không phải giả lập):
//   BASE=https://... SUPER_TOKEN=... node test/smoke-remote.mjs
// Tạo trường SLUG (mặc định "thu") và đi hết luồng: đăng bài → xếp giờ → tải sớm → xin khoá trước giờ bị từ chối
// → đúng giờ nhận khoá, giải mã đúng → phát đồng loạt chia đợt. Xoá bài thử khi xong.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { browser, sleep, uploadExam, decryptLikeRoom, makeLanKey, MAP } from './helpers.mjs';

const BASE = process.env.BASE, TOKEN = process.env.SUPER_TOKEN, SLUG = process.env.SLUG || 'thu';
if (!BASE || !TOKEN) { console.error('Cần BASE và SUPER_TOKEN'); process.exit(2); }
const step = (m) => console.log('✓ ' + m);

const r = await fetch(BASE + '/api/truong', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ slug: SLUG, ten: 'Trường kiểm thử tự động', ban_do: MAP, admin: { name: 'Admin kiểm thử', username: 'admin' } }) });
const made = await r.json();
if (r.status !== 200) { console.error('Không tạo được trường ' + SLUG + ': ' + made.error + ' (chạy lại trên trường mới hoặc xoá trường cũ)'); process.exit(1); }
step('tạo trường thử');

const a = browser(BASE);
assert.equal((await a(`/${SLUG}/api/t/login`, { body: { username: 'admin', password: made.password } })).status, 200);
assert.equal((await fetch(BASE + '/_')).status, 200);
const lan = await makeLanKey();
assert.equal((await a(`/${SLUG}/api/admin/lan-key`, { body: { publicKey: lan.publicKey } })).status, 200);
step('trang siêu admin chạy; admin tạo khoá LAN');
const tp = (await a(`/${SLUG}/api/admin/user-create`, { body: { name: 'GV kiểm thử', username: 'giaovien' } })).data.password;
const g = browser(BASE);
assert.equal((await g(`/${SLUG}/api/t/login`, { body: { username: 'giaovien', password: tp } })).status, 200);
const me = (await g(`/${SLUG}/api/t/me`)).data;
const plain = new Uint8Array(randomBytes(1048576));
const up = await uploadExam(g, me, plain, 'Bài kiểm thử', {}, SLUG);
assert.equal(up.status, 200, JSON.stringify(up.data)); assert.equal(up.data.verified, 1);
step('giáo viên đăng bài (bọc thêm khoá LAN), máy chủ giải mã thử được');

const t0 = Date.now() + 20000;
assert.equal((await a(`/${SLUG}/api/admin/schedule`, { body: { id: up.data.id, t0: new Date(t0).toISOString(), assign: { P101: '', P102: '' } } })).status, 200);
const codes = (await a(`/${SLUG}/api/admin/status`)).data.exams[0].codes;
step('xếp giờ (20 giây nữa), 2 phòng sát vách');

const tok = {};
for (const room of ['P101', 'P102']) tok[room] = (await fetch(`${BASE}/${SLUG}/api/login?code=${codes[room]}`).then(r => r.json())).token;
const enc = new Uint8Array(await (await fetch(`${BASE}/${SLUG}/api/audio?token=${tok.P101}`)).arrayBuffer());
step(`máy phòng tải bản mã sớm (${enc.length} byte)`);
const early = await fetch(`${BASE}/${SLUG}/api/key?token=${tok.P101}`);
assert.equal(early.status, 403);
step('xin khoá trước giờ: bị từ chối');

await sleep(Math.max(0, t0 - Date.now() + 1500));
const k = await fetch(`${BASE}/${SLUG}/api/key?token=${tok.P101}`);
assert.equal(k.status, 200);
const out = await decryptLikeRoom(enc, (await k.json()).key);
assert.ok(Buffer.from(out).equals(Buffer.from(plain)));
step('đúng giờ: nhận khoá, giải mã ra đúng file gốc');

const pkg = (await a(`/${SLUG}/api/admin/lan-package`)).data;
assert.deepEqual(pkg.exams.map(e => e.id), [up.data.id]); assert.deepEqual(pkg.exams[0].rooms, codes);
const encPkg = new Uint8Array(await (await a(`/${SLUG}/api/admin/enc?id=${up.data.id}`, { raw: true })).arrayBuffer());
assert.ok(Buffer.from(encPkg).equals(Buffer.from(enc)));
step('gói dự phòng LAN: có bài, đúng mã phòng, bản mã khớp');

for (const room of ['P101', 'P102']) await fetch(`${BASE}/${SLUG}/api/report?token=${tok[room]}`, { method: 'POST', body: JSON.stringify({ status: 'sẵn sàng phát', dur: 3 }) });
const play = await a(`/${SLUG}/api/admin/play`, { body: { ids: [up.data.id] } });
assert.equal(play.status, 200); assert.equal(play.data.wave2, 1);
step('phát đồng loạt: P102 sang đợt 2');

assert.equal((await a(`/${SLUG}/api/admin/delete`, { body: { id: up.data.id } })).status, 200);
step('xoá bài thử');
console.log('\nTẤT CẢ ĐẠT trên ' + BASE);
