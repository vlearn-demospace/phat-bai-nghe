-- Trường bắt buộc mọi admin dùng xác thực 2 lớp: admin chưa bật phải bật ngay sau khi nhập đúng mật khẩu.
ALTER TABLE truong ADD COLUMN bat_buoc_2fa INTEGER NOT NULL DEFAULT 0;
