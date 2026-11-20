// Hàm dùng chung cho Worker và Durable Object.
const enc = new TextEncoder();

export const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});

export const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // bỏ I, O, 0, 1 cho dễ đọc
export const CODE_LEN = 4;
export const genCode = n => [...crypto.getRandomValues(new Uint8Array(n))].map(x => ALPHA[x % 32]).join('');
export const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const hex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
export const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
export const b64 = buf => { let s = ''; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s); };
export const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? enc.encode(s) : s));

export function same(a, b) {
  const x = enc.encode(String(a ?? '')), y = enc.encode(String(b ?? ''));
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

// Mật khẩu: PBKDF2-SHA256 (Workers không có scrypt). 100.000 vòng là mức tối đa Workers cho phép.
export async function hashPw(pw, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(String(pw)), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, k, 256));
}

// ---------- Khoá trường (phương án B: dịch vụ giữ khoá, bọc bằng MASTER_KEY) ----------
const toPem = (buf, label) => `-----BEGIN ${label}-----\n${b64(buf).match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
const fromPem = pem => unb64(String(pem).replace(/-----[^-]+-----|\s/g, ''));

async function masterKey(env) {
  const raw = unb64(env.MASTER_KEY || '');
  if (raw.length !== 32) throw new Error('MASTER_KEY chưa đặt hoặc sai độ dài');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function newSchoolKeys(env) {
  const kp = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const pub = toPem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY');
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await masterKey(env), pkcs8);
  return { publicKey: pub, wrappedPrivate: b64(iv) + '.' + b64(ct), keyId: (await sha256(pub)).slice(0, 16) };
}
export const keyIdOf = async pub => (await sha256(pub)).slice(0, 16);

// CHỈ Durable Object gọi hàm này, sau khi đã kiểm tra giờ (xem Truong.#unwrapExamKey).
export async function unwrapExamKey(env, wrappedPrivate, wrappedKey) {
  const [iv, ct] = wrappedPrivate.split('.');
  const pkcs8 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await masterKey(env), unb64(ct));
  const priv = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, unb64(wrappedKey)));
}
export function checkPublicKeyPem(pem) { try { return fromPem(pem).length > 200; } catch { return false; } }

// ---------- Sơ đồ trường và chia đợt phát ----------
// ban_do: [{ title, floors: [{ n, rooms: [['101','10 ANH'], null, ...] }] }] – null = cầu thang, ngắt dãy phòng.
// Kiểm tra và làm sạch sơ đồ gửi lên. Trả về { map } hoặc { error }.
export function cleanMap(map) {
  if (!Array.isArray(map) || !map.length || map.length > 20) return { error: 'Sơ đồ cần 1–20 khu' };
  const seen = new Set(), out = [];
  for (const z of map) {
    if (!z || !Array.isArray(z.floors) || !z.floors.length || z.floors.length > 30) return { error: 'Mỗi khu cần 1–30 tầng' };
    const zone = { title: String(z.title || '').trim().slice(0, 80) || 'KHU', floors: [] };
    for (const f of z.floors) {
      if (!f || !Array.isArray(f.rooms) || f.rooms.length > 40) return { error: 'Mỗi tầng tối đa 40 ô' };
      const floor = { n: String(f.n ?? '').trim().slice(0, 10), rooms: [] };
      if (f.wait) floor.wait = String(f.wait).trim().slice(0, 40);
      for (const r of f.rooms) {
        if (r === null) { floor.rooms.push(null); continue; }
        const id = String(Array.isArray(r) ? r[0] : '').trim(), label = String(Array.isArray(r) ? r[1] ?? '' : '').trim().slice(0, 40);
        if (!/^[A-Za-z0-9-]{1,10}$/.test(id)) return { error: `Số phòng "${id}" không hợp lệ (chỉ chữ, số, dấu -, tối đa 10 ký tự)` };
        if (seen.has(id)) return { error: `Phòng ${id} bị lặp trên sơ đồ` };
        seen.add(id); floor.rooms.push([id, label]);
      }
      zone.floors.push(floor);
    }
    out.push(zone);
  }
  if (!seen.size) return { error: 'Sơ đồ chưa có phòng nào' };
  if (seen.size > 300) return { error: 'Sơ đồ tối đa 300 phòng' };
  return { map: out };
}
export const roomIds = map => new Set(map.flatMap(k => k.floors.flatMap(f => f.rooms.filter(Boolean).map(r => 'P' + r[0]))));
export function splitWaves(map, rooms) {
  const wave2 = new Set();
  for (const k of map) for (const f of k.floors) {
    let run = 0;
    for (const r of f.rooms) {
      const id = r && 'P' + r[0];
      if (!id || !rooms.has(id)) { run = 0; continue; }
      if (run++ % 2) wave2.add(id);
    }
  }
  return wave2;
}

export async function log(env, truongId, msg) {
  await env.DB.prepare('INSERT INTO nhat_ky (truong_id, at, msg) VALUES (?, ?, ?)').bind(truongId, Date.now(), String(msg).slice(0, 500)).run();
}
