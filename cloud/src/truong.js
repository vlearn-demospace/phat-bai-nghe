// Durable Object "Truong": mỗi trường một đối tượng, một luồng xử lý, một đồng hồ.
// Giữ: lệnh phát, mở khoá khẩn cấp, trạng thái phòng, WebSocket máy phòng, đếm nhập sai mã.
// Là NƠI DUY NHẤT trả khoá bài cho máy phòng, và chỉ khi đã đến giờ (#keyFor).
import { DurableObject } from 'cloudflare:workers';
import { json, norm, CODE_LEN, randHex, b64, unwrapExamKey, splitWaves, log } from './lib.js';

const WAVE_GAP = 10000;          // đợt 2 phát 10 giây sau khi đợt 1 xong
const FAIL_MAX = 20, FAIL_MS = 10 * 60000;
// Mã phòng chỉ dùng được từ 24 giờ trước giờ thi đến 3 giờ sau khi bài kết thúc (máy đã vào bằng thẻ không bị ảnh hưởng)
export const CODE_EARLY = 24 * 3600e3, CODE_LATE = 3 * 3600e3;
export const codeOpen = (row, now = Date.now()) => !!row.t0 && now >= row.t0 - CODE_EARLY && now <= row.t0 + (row.dur || 3600) * 1000 + CODE_LATE;
const VERIFY_MAX = 40 * 1048576; // thử giải mã toàn bộ file đến 40 MB (giới hạn bộ nhớ 128 MB)

export class Truong extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.status = new Map();     // `${baiId}|${room}` -> { status, pos, dur, activated, lastSeen, ip } (máy hỏi qua HTTP)
    this.keys = new Map();       // baiId -> { key, until } khoá đã mở, chỉ trong bộ nhớ
    this.fails = new Map();      // ip -> { n, t }
    this.ready = ctx.blockConcurrencyWhile(async () => { this.live = (await ctx.storage.get('live')) || {}; });
  }
  liveOf(id) { return this.live[id] || (this.live[id] = { force: false, playAt: null, playAt2: null, wave2: [] }); }
  async saveLive() { await this.ctx.storage.put('live', this.live); }
  released(row) { return !!row.t0 && (this.liveOf(row.id).force || Date.now() >= row.t0); }   // GIỜ CLOUDFLARE

  // ---------- Tra cứu phòng ----------
  roomQuery(where) {
    return `SELECT p.room, p.code, p.ktv_id, p.token, b.id, b.truong_id, b.title, b.mime, b.sha256, b.size, b.dur, b.t0, b.wrapped_key, b.verified
            FROM phong p JOIN bai b ON b.id = p.bai_id WHERE ${where}`;
  }
  async byToken(tid, token) {
    if (!/^[0-9a-f]{64}$/.test(token || '')) return null;
    return this.env.DB.prepare(this.roomQuery('p.truong_id = ? AND p.token = ?')).bind(tid, token).first();
  }
  blocked(ip) { const f = this.fails.get(ip); return f && f.n >= FAIL_MAX && Date.now() - f.t < FAIL_MS; }
  fail(ip) { const f = this.fails.get(ip) || { n: 0, t: 0 }; if (Date.now() - f.t > FAIL_MS) f.n = 0; f.n++; f.t = Date.now(); this.fails.set(ip, f); }

  // Khoá bài: chỉ trả khi đã đến giờ. Khoá trường được mở bằng MASTER_KEY ngay trong DO, không ra khỏi đây.
  async #keyFor(row) {
    if (!this.released(row)) return null;
    const c = this.keys.get(row.id);
    if (c && c.until > Date.now()) return c.key;
    const t = await this.env.DB.prepare('SELECT wrapped_private FROM truong WHERE id = ?').bind(row.truong_id).first();
    const key = b64(await unwrapExamKey(this.env, t.wrapped_private, row.wrapped_key));
    this.keys.set(row.id, { key, until: Math.max(Date.now(), row.t0) + ((row.dur || 3600) + 7200) * 1000 });
    return key;
  }
  stateFor(row, room) {
    const l = this.liveOf(row.id), w2 = l.wave2.includes(room);
    return { playAt: w2 ? l.playAt2 : l.playAt, wave: w2 ? 2 : 1, released: this.released(row), title: row.title, t0: row.t0 };
  }

  // ---------- Máy phòng (HTTP và WebSocket) ----------
  async fetch(req) {
    await this.ready;
    const u = new URL(req.url), tid = req.headers.get('x-truong'), ip = req.headers.get('x-ip') || '';
    const a = u.pathname.split('/').pop(), q = Object.fromEntries(u.searchParams);

    if (a === 'login') {
      let row;
      if (q.token) { row = await this.byToken(tid, q.token); if (!row) return json(403, { error: 'Mã phòng không còn hiệu lực' }); }
      else {
        if (this.blocked(ip)) return json(429, { error: 'Nhập sai quá nhiều lần, thử lại sau 10 phút' });
        const code = norm(q.code);
        row = code.length === CODE_LEN && await this.env.DB.prepare(this.roomQuery('p.truong_id = ? AND p.code = ?')).bind(tid, code).first();
        // Mã sai và mã ngoài thời gian dùng trả CÙNG một câu, để không dò được mã đúng từ trước
        if (!row || !codeOpen(row)) {
          this.fail(ip);
          await log(this.env, tid, row ? `${row.title} / ${row.room}: nhập mã NGOÀI thời gian dùng mã từ ${ip}` : `Đăng nhập SAI từ ${ip}`);
          return json(403, { error: 'Mã không đúng, hoặc chưa đến thời gian dùng mã (từ 24 giờ trước giờ thi)' });
        }
        if (!row.token) {
          row.token = randHex(32);
          await this.env.DB.prepare('UPDATE phong SET token = ? WHERE bai_id = ? AND room = ? AND token IS NULL').bind(row.token, row.id, row.room).run();
          row = await this.env.DB.prepare(this.roomQuery('p.bai_id = ? AND p.room = ?')).bind(row.id, row.room).first();
        }
      }
      await log(this.env, tid, `${row.title} / ${row.room} đăng nhập từ ${ip}`);
      const ktv = row.ktv_id ? await this.env.DB.prepare('SELECT name FROM ktv WHERE id = ? AND truong_id = ?').bind(row.ktv_id, tid).first() : null;
      return json(200, { room: row.room, title: row.title, mime: row.mime, sha256: row.sha256, size: row.size, t0: row.t0, ktv: ktv ? ktv.name : '', token: row.token });
    }

    const row = await this.byToken(tid, q.token);
    if (!row) return json(403, { error: 'Sai mã' });

    if (a === 'key') {
      if (!this.released(row)) { await log(this.env, tid, `${row.title} / ${row.room} xin khoá TRƯỚC GIỜ – từ chối`); return json(403, { error: 'Chưa đến giờ' }); }
      let key;
      try { key = await this.#keyFor(row); } catch (e) { await log(this.env, tid, `${row.title}: không mở được khoá (${e.message})`); }
      if (!key) return json(503, { error: 'Bài này không mở được – báo admin' });
      await log(this.env, tid, `${row.title} / ${row.room} nhận khoá`);
      return json(200, { key });
    }
    if (a === 'report' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      await this.report(tid, row, row.room, b, ip, this.status.get(row.id + '|' + row.room));
      return json(200, this.stateFor(row, row.room));
    }
    if (a === 'ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return json(426, { error: 'Cần WebSocket' });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, [row.id]);
      server.serializeAttachment({ tid, id: row.id, room: row.room, title: row.title, t0: row.t0, ip, s: { status: 'đã kết nối', pos: 0, dur: 0, activated: false, lastSeen: Date.now() } });
      server.send(JSON.stringify(this.stateFor(row, row.room)));
      return new Response(null, { status: 101, webSocket: client });
    }
    return json(404, { error: 'Không tìm thấy' });
  }
  async report(tid, row, room, b, ip, prev) {
    const st = String(b.status || '').slice(0, 60);
    if (!prev || prev.status !== st) await log(this.env, tid, `${row.title} / ${room}: ${st}`);
    const s = { status: st, pos: +b.pos || 0, dur: +b.dur || 0, activated: !!b.activated, lastSeen: Date.now(), ip };
    this.status.set(row.id + '|' + room, s);
    return s;
  }
  async webSocketMessage(ws, msg) {
    await this.ready;
    const at = ws.deserializeAttachment();
    let b; try { b = JSON.parse(msg); } catch { return; }
    at.s = await this.report(at.tid, { id: at.id, title: at.title }, at.room, b, at.ip, at.s);
    ws.serializeAttachment(at);
    ws.send(JSON.stringify(this.stateFor({ id: at.id, title: at.title, t0: at.t0 }, at.room)));
  }
  webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code); } catch {} }
  broadcast(id) {
    for (const ws of this.ctx.getWebSockets(id)) {
      const at = ws.deserializeAttachment();
      try { ws.send(JSON.stringify(this.stateFor({ id: at.id, title: at.title, t0: at.t0 }, at.room))); } catch {}
    }
  }

  // ---------- Gọi từ Worker (RPC) ----------
  async liveState() {
    await this.ready;
    const rooms = {};
    for (const [k, s] of this.status) { const [id, room] = k.split('|'); (rooms[id] ||= {})[room] = s; }
    for (const ws of this.ctx.getWebSockets()) { const at = ws.deserializeAttachment(); (rooms[at.id] ||= {})[at.room] = { ...at.s, ws: true }; }
    return { live: this.live, rooms };
  }
  // Bài đổi lịch / bị xoá: xoá trạng thái, đóng WebSocket để máy phòng đăng nhập lại với lịch mới
  async reset(id, keepLive = false) {
    await this.ready;
    if (!keepLive) { delete this.live[id]; await this.saveLive(); }
    this.keys.delete(id);
    for (const k of [...this.status.keys()]) if (k.startsWith(id + '|')) this.status.delete(k);
    for (const ws of this.ctx.getWebSockets(id)) try { ws.close(4000, 'Lịch thay đổi'); } catch {}
  }
  async release(tid, id, who) {
    await this.ready;
    this.liveOf(id).force = true; await this.saveLive();
    await log(this.env, tid, `${who}: MỞ KHOÁ KHẨN CẤP bài ${id}`);
    this.broadcast(id);
  }
  // Phát đồng loạt: một lệnh cho nhiều bài, phòng sát vách chia 2 đợt xen kẽ
  async play(tid, ids, who, map) {
    await this.ready;
    if (!ids.length) return { error: 'Chưa chọn bài' };
    const rows = (await this.env.DB.prepare(`SELECT id, truong_id, title, dur, t0, verified FROM bai WHERE truong_id = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(tid, ...ids).all()).results;
    const ready = rows.filter(r => this.released(r) && r.verified > 0);
    if (!ready.length) return { error: 'Chưa có bài nào đến giờ' };
    const roomsOf = {};
    for (const r of ready) roomsOf[r.id] = (await this.env.DB.prepare('SELECT room FROM phong WHERE bai_id = ?').bind(r.id).all()).results.map(x => x.room);
    const live = await this.liveState();
    const durOf = r => Math.max(r.dur || 0, ...Object.values(live.rooms[r.id] || {}).map(s => s.dur || 0));
    const at = Date.now() + 5000, wave2 = splitWaves(map, new Set(ready.flatMap(r => roomsOf[r.id])));
    let at2 = null;
    if (wave2.size) {
      const first = ready.filter(r => roomsOf[r.id].some(x => !wave2.has(x))), unknown = first.find(r => !durOf(r));
      if (unknown) return { error: `Chưa biết độ dài bài "${unknown.title}" nên chưa tính được giờ phát đợt 2. Chờ các phòng báo "sẵn sàng phát" rồi bấm lại.` };
      at2 = at + Math.max(...first.map(durOf)) * 1000 + WAVE_GAP;
    }
    for (const r of ready) {
      const l = this.liveOf(r.id);
      l.wave2 = roomsOf[r.id].filter(x => wave2.has(x));
      l.playAt = at; l.playAt2 = l.wave2.length ? at2 : null;
    }
    await this.saveLive();
    for (const r of ready) this.broadcast(r.id);
    await log(this.env, tid, `${who}: lệnh phát đồng loạt ${ready.map(r => `"${r.title}"`).join(', ')}` +
      (at2 ? `; đợt 2: ${[...wave2].sort().map(x => 'P.' + x.slice(1)).join(', ')}` : ''));
    return { playAt: at, playAt2: at2, count: ready.length, wave2: wave2.size };
  }
  async cancel(tid, ids, who) {
    await this.ready;
    for (const id of ids) { Object.assign(this.liveOf(id), { playAt: null, playAt2: null, wave2: [] }); this.broadcast(id); }
    await this.saveLive();
    await log(this.env, tid, `${who}: huỷ lệnh phát ${ids.length} bài`);
  }
  // Ngay sau khi giáo viên đăng: thử mở khoá và giải mã để chắc bài mở được vào ngày thi. Khoá không được trả ra.
  async verify(id) {
    const row = await this.env.DB.prepare('SELECT b.*, t.wrapped_private FROM bai b JOIN truong t ON t.id = b.truong_id WHERE b.id = ?').bind(id).first();
    let v = -1;
    try {
      const key = await unwrapExamKey(this.env, row.wrapped_private, row.wrapped_key);
      if (key.length === 32) {
        if (row.size > VERIFY_MAX) v = 2;
        else {
          const obj = await this.env.R2.get(`t/${row.truong_id}/bai/${id}.enc`);
          const enc = new Uint8Array(await obj.arrayBuffer());
          const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
          await crypto.subtle.decrypt({ name: 'AES-GCM', iv: enc.subarray(0, 12) }, k, enc.subarray(12));
          v = 1;
        }
      }
    } catch {}
    await this.env.DB.prepare('UPDATE bai SET verified = ? WHERE id = ?').bind(v, id).run();
    return v;
  }
}
