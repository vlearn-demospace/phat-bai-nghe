-- Mọi bảng có truong_id: dữ liệu các trường tách riêng.
CREATE TABLE truong (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  ten TEXT NOT NULL,
  ban_do TEXT NOT NULL,              -- sơ đồ phòng (JSON), dùng để chia đợt phát
  public_key TEXT NOT NULL,          -- khoá công khai RSA-OAEP của trường (PEM)
  wrapped_private TEXT NOT NULL,     -- khoá riêng của trường, bọc bằng MASTER_KEY
  lan_public_key TEXT,               -- khoá LAN dự phòng (tuỳ chọn, trường tự giữ khoá riêng)
  goi TEXT NOT NULL DEFAULT 'thu',   -- gói cước
  het_han INTEGER,                   -- hạn dùng (ms), NULL = không hạn
  khoa INTEGER NOT NULL DEFAULT 0,   -- 1 = siêu admin tạm khoá trường
  created_at INTEGER NOT NULL
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  truong_id TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  role TEXT NOT NULL,                -- admin | teacher
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (truong_id, username)
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  truong_id TEXT NOT NULL,
  exp INTEGER NOT NULL
);
CREATE TABLE ktv (
  id TEXT PRIMARY KEY,
  truong_id TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE bai (
  id TEXT PRIMARY KEY,
  truong_id TEXT NOT NULL,
  title TEXT NOT NULL,
  teacher_id TEXT NOT NULL,
  teacher_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  dur REAL NOT NULL DEFAULT 0,
  wrapped_key TEXT NOT NULL,
  lan_wrapped_key TEXT,
  key_id TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0, -- 1 = đã thử giải mã được, 2 = file lớn, chỉ kiểm tra khoá
  uploaded_at INTEGER NOT NULL,
  t0 INTEGER
);
CREATE INDEX bai_truong ON bai (truong_id);
CREATE TABLE phong (
  bai_id TEXT NOT NULL,
  truong_id TEXT NOT NULL,
  room TEXT NOT NULL,
  code TEXT NOT NULL,
  ktv_id TEXT,
  token TEXT,
  PRIMARY KEY (bai_id, room)
);
CREATE INDEX phong_code ON phong (truong_id, code);
CREATE INDEX phong_token ON phong (token);
CREATE TABLE nhat_ky (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  truong_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  msg TEXT NOT NULL
);
CREATE INDEX nhat_ky_truong ON nhat_ky (truong_id, at);
CREATE TABLE tai_len (               -- file đang tải lên (R2 multipart)
  id TEXT PRIMARY KEY,               -- mã bài sẽ dùng khi đăng xong
  truong_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
