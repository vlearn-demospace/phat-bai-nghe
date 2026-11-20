-- Bài bọc khoá LAN nào: chỉ bài có lan_key_id trùng khoá LAN hiện tại mới đưa vào gói dự phòng.
ALTER TABLE bai ADD COLUMN lan_key_id TEXT;
