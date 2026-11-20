// Gói dự phòng LAN: dữ liệu tải từ dịch vụ phải chạy được bằng đúng bản LAN (../server.js) –
// cùng mã phòng đã in, khoá vẫn chỉ mở đúng giờ, giải mã bằng file khoá LAN ra đúng file gốc.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWorker, browser, sleep, uploadExam, decryptLikeRoom, makeLanKey, MAP, SUPER_TOKEN } from './helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let w, base, lanProc, lanDir;
const S = {};
before(async () => { w = await startWorker(); base = w.base; });
after(() => { w && w.stop(); lanProc && lanProc.kill(); if (lanDir) try { rmSync(lanDir, { recursive: true, force: true }); } catch {} });

test('chuẩn bị: trường, giáo viên, một bài đăng TRƯỚC khi có khoá LAN', async () => {
  const r = await fetch(base + '/api/truong', { method: 'POST', headers: { authorization: 'Bearer ' + SUPER_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'lan', ten: 'Trường LAN', ban_do: MAP, admin: { name: 'Admin', username: 'admin' } }) }).then(r => r.json());
  S.a = browser(base);
  assert.equal((await S.a('/lan/api/t/login', { body: { username: 'admin', password: r.password } })).status, 200);
  const tp = (await S.a('/lan/api/admin/user-create', { body: { name: 'GV', username: 'giaovien' } })).data.password;
  S.g = browser(base);
  assert.equal((await S.g('/lan/api/t/login', { body: { username: 'giaovien', password: tp } })).status, 200);
  const old = await uploadExam(S.g, (await S.g('/lan/api/t/me')).data, new Uint8Array(randomBytes(2000)), 'Bài cũ', {}, 'lan');
  assert.equal(old.status, 200);
  assert.equal((await S.a('/lan/api/admin/lan-package')).status, 400, 'chưa có khoá LAN thì không có gói');
});

test('tạo khoá LAN; bài đăng sau đó được bọc thêm; khoá LAN cũ bị từ chối', async () => {
  const stale = await makeLanKey();
  assert.equal((await S.a('/lan/api/admin/lan-key', { body: { publicKey: stale.publicKey } })).status, 200);
  const meStale = (await S.g('/lan/api/t/me')).data;
  S.lan = await makeLanKey();
  assert.equal((await S.a('/lan/api/admin/lan-key', { body: { publicKey: S.lan.publicKey } })).status, 200);
  const bad = await uploadExam(S.g, meStale, new Uint8Array(randomBytes(2000)), 'Khoá LAN cũ', {}, 'lan');
  assert.equal(bad.status, 400); assert.match(bad.data.error, /Khoá LAN vừa đổi/);

  const me = (await S.g('/lan/api/t/me')).data;
  assert.ok(me.lanKeyId);
  S.plain = new Uint8Array(randomBytes(1048576 + 4321));
  const up = await uploadExam(S.g, me, S.plain, 'Bài có dự phòng', {}, 'lan');
  assert.equal(up.status, 200, JSON.stringify(up.data));
  S.id = up.data.id;
  assert.equal((await S.a('/lan/api/admin/ktv-create', { body: { name: 'Thầy Hùng' } })).status, 200);
  S.ktvId = (await S.a('/lan/api/admin/status')).data.ktvs[0].id;
  S.t0 = Date.now() + 9000;
  assert.equal((await S.a('/lan/api/admin/schedule', { body: { id: S.id, t0: new Date(S.t0).toISOString(), assign: { P101: S.ktvId, P102: '' } } })).status, 200);
  const st = (await S.a('/lan/api/admin/status')).data;
  const mine = st.exams.find(e => e.id === S.id);
  assert.equal(mine.lan, true); assert.equal(st.exams.find(e => e.title === 'Bài cũ').lan, false);
  S.codes = mine.codes;
});

test('gói dự phòng: chỉ có bài bọc khoá LAN hiện tại, bản mã tải đủ; giáo viên không tải được', async () => {
  const p = (await S.a('/lan/api/admin/lan-package')).data;
  assert.deepEqual(p.exams.map(e => e.id), [S.id]);
  assert.deepEqual(p.missing, ['Bài cũ']);
  assert.equal(p.school.publicKey, S.lan.publicKey);
  assert.deepEqual(p.exams[0].rooms, S.codes);
  assert.equal(p.exams[0].ktv.P101, S.ktvId);
  const enc = await S.a('/lan/api/admin/enc?id=' + S.id, { raw: true });
  assert.equal(enc.status, 200);
  S.enc = new Uint8Array(await enc.arrayBuffer());
  assert.equal(S.enc.length, p.exams[0].size);
  assert.equal((await S.g('/lan/api/admin/lan-package')).status, 403);
  assert.equal((await S.g('/lan/api/admin/enc?id=' + S.id)).status, 403);
  S.pkg = p;
});

test('bản LAN (server.js) chạy gói: đúng mã phòng, khoá chỉ mở đúng giờ, giải mã ra file gốc', async () => {
  lanDir = mkdtempSync(join(tmpdir(), 'pbn-lan-'));
  writeFileSync(join(lanDir, 'server.js'), readFileSync(join(REPO, 'server.js')));
  cpSync(join(REPO, 'public'), join(lanDir, 'public'), { recursive: true });
  mkdirSync(join(lanDir, 'data', 'exams'), { recursive: true });
  const j = o => JSON.stringify(o, null, 2);
  writeFileSync(join(lanDir, 'data', 'school.json'), j(S.pkg.school));
  writeFileSync(join(lanDir, 'data', 'exams.json'), j(S.pkg.exams));
  writeFileSync(join(lanDir, 'data', 'ktvs.json'), j(S.pkg.ktvs));
  writeFileSync(join(lanDir, 'data', 'exams', S.id + '.enc'), S.enc);

  const port = 19700 + Math.floor(Math.random() * 300), lan = `http://localhost:${port}`;
  lanProc = spawn(process.execPath, ['server.js'], { cwd: lanDir, env: { ...process.env, PORT: String(port), NO_OPEN: '1' }, stdio: 'ignore' });
  for (let i = 0; ; i++) { try { if ((await fetch(lan + '/api/time')).ok) break; } catch {} if (i > 60) throw new Error('bản LAN không chạy'); await sleep(250); }

  const login = await fetch(`${lan}/api/login?code=${S.codes.P101}`).then(r => r.json());
  assert.equal(login.room, 'P101'); assert.equal(login.ktv, 'Thầy Hùng'); assert.equal(login.t0, S.t0);
  const enc = new Uint8Array(await (await fetch(`${lan}/api/audio?token=${login.token}`)).arrayBuffer());
  assert.equal((await fetch(`${lan}/api/key?token=${login.token}`)).status, 403, 'trước giờ bị từ chối');

  const k = await fetch(lan + '/api/admin/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: S.lan.keyFile }) });
  assert.equal(k.status, 200, await k.clone().text());
  assert.equal((await fetch(`${lan}/api/key?token=${login.token}`)).status, 403, 'nạp khoá rồi vẫn chưa đến giờ');

  await sleep(Math.max(0, S.t0 - Date.now() + 800));
  const key = await fetch(`${lan}/api/key?token=${login.token}`);
  assert.equal(key.status, 200);
  const out = await decryptLikeRoom(enc, (await key.json()).key);
  assert.ok(Buffer.from(out).equals(Buffer.from(S.plain)));
});
