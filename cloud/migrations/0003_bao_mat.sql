-- Xác thực 2 lớp (TOTP) và đếm đăng nhập sai bền vững (không mất khi Worker khởi động lại).
ALTER TABLE users ADD COLUMN totp_secret TEXT;            -- khoá TOTP, bọc bằng MASTER_KEY
ALTER TABLE users ADD COLUMN totp_on INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_last INTEGER NOT NULL DEFAULT 0;   -- bước thời gian đã dùng, chống dùng lại mã
CREATE TABLE dang_nhap_sai (
  k TEXT PRIMARY KEY,               -- 'ip:<ip>' hoặc 'u:<trường>:<tên đăng nhập>'
  n INTEGER NOT NULL,
  t INTEGER NOT NULL                -- lần sai đầu tiên trong cửa sổ
);
