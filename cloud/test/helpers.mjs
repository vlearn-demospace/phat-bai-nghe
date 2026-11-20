// Chạy Worker bằng `wrangler dev --local` (giả lập Cloudflare trên máy, không cần tài khoản) và gọi như trình duyệt.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto as crypto, randomBytes } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
export const SUPER_TOKEN = 'test-super-' + randomBytes(8).toString('hex');
const MASTER_KEY = randomBytes(32).toString('base64');

export async function startWorker() {
  const dir = mkdtempSync(join(tmpdir(), 'pbn-test-'));
  execFileSync(process.execPath, [WRANGLER, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', dir], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, CI: '1' } });
  const port = 18700 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, [WRANGLER, 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', dir, '--show-interactive-dev-session=false',
    '--var', `MASTER_KEY:${MASTER_KEY}`, '--var', `SUPER_TOKEN:${SUPER_TOKEN}`], { cwd: ROOT, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  let out = '';
  proc.stdout.on('data', d => out += d); proc.stderr.on('data', d => out += d);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + '/robots.txt')).ok) break; } catch {}
    if (i > 120 || proc.exitCode !== null) { proc.kill(); throw new Error('wrangler dev không chạy được:\n' + out); }
    await new Promise(r => setTimeout(r, 500));
  }
  return { base, output: () => out, stop: () => { proc.kill(); try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

// Một "trình duyệt" giữ cookie riêng
export function browser(base) {
  let cookie = '';
  const call = async (path, { method, body, headers = {}, raw } = {}) => {
    const h = { ...headers }; if (cookie) h.cookie = cookie;
    let b = body;
    if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== 'string') { b = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const r = await fetch(base + path, { method: method || (body !== undefined ? 'POST' : 'GET'), body: b, headers: h, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    if (raw) return r;
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
  return call;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64 = u => Buffer.from(u).toString('base64');
const fromPem = pem => Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
export const hex = buf => Buffer.from(buf).toString('hex');

// Mã hoá giống hệt trang giáo viên: AES-256-GCM, khoá bọc RSA-OAEP-SHA256 bằng khoá công khai trường
export async function encryptLikeTeacher(plain, publicKeyPem) {
  const raw = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, plain));
  const enc = new Uint8Array(12 + ct.length); enc.set(iv); enc.set(ct, 12);
  const pub = await crypto.subtle.importKey('spki', fromPem(publicKeyPem), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const wrappedKey = b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, raw)));
  const sha256 = hex(await crypto.subtle.digest('SHA-256', enc));
  return { enc, wrappedKey, sha256, raw };
}
// Khoá LAN như trang admin tạo trong trình duyệt: PEM công khai gửi lên, file khoá riêng trường giữ
export async function makeLanKey() {
  const kp = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const pem = (buf, label) => `-----BEGIN ${label}-----\n${b64(new Uint8Array(buf)).match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
  const priv = pem(await crypto.subtle.exportKey('pkcs8', kp.privateKey), 'PRIVATE KEY');
  return { publicKey: pem(await crypto.subtle.exportKey('spki', kp.publicKey), 'PUBLIC KEY'),
    keyFile: `KHOÁ LAN DỰ PHÒNG – PHÁT BÀI NGHE – GIỮ BÍ MẬT\r\nTạo lúc: hôm nay\r\n\r\n${priv}` };
}
export async function decryptLikeRoom(enc, keyB64) {
  const k = await crypto.subtle.importKey('raw', Buffer.from(keyB64, 'base64'), 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: enc.subarray(0, 12) }, k, enc.subarray(12)));
}

// Đăng bài qua API như trang giáo viên (chia phần theo cỡ máy chủ yêu cầu)
export async function uploadExam(g, me, plain, title, extra = {}, slug = 'thu') {
  const { enc, wrappedKey, sha256, raw } = await encryptLikeTeacher(plain, me.publicKey);
  if (me.lanPublicKey) {   // như trang giáo viên: trường có khoá LAN thì bọc thêm khoá bài bằng khoá LAN
    const lan = await crypto.subtle.importKey('spki', fromPem(me.lanPublicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    extra = { lanWrappedKey: b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, lan, raw))), lanKeyId: me.lanKeyId, ...extra };
  }
  const s = await g(`/${slug}/api/t/upload-start`, { body: { size: enc.length } });
  if (s.status !== 200) return s;
  const parts = [];
  for (let off = 0, n = 1; off < enc.length; off += s.data.part, n++) {
    const r = await g(`/${slug}/api/t/upload-part?id=${s.data.id}&n=${n}`, { body: enc.subarray(off, off + s.data.part), headers: { 'content-type': 'application/octet-stream' } });
    if (r.status !== 200) return r;
    parts.push(r.data);
  }
  return g(`/${slug}/api/t/upload-finish`, { body: { id: s.data.id, parts, title, mime: 'audio/mpeg', dur: 3, size: enc.length, sha256, wrappedKey, keyId: me.keyId, ...extra } });
}

// Sơ đồ nhỏ để thử: tầng 1 có 3 phòng liền nhau (101-102-103), cầu thang, rồi 104
export const MAP = [{ title: 'KHU THỬ', floors: [{ n: 1, rooms: [['101', 'A'], ['102', 'B'], ['103', 'C'], null, ['104', 'D']] }] }];
