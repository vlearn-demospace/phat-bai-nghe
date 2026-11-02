# Phát bài nghe có khoá theo giờ

Hệ thống phát bài thi nghe đồng loạt cho nhiều phòng thi. File nghe được mã hoá trước, các phòng tải về sớm, nhưng chỉ giải mã được khi đến giờ thi theo đồng hồ máy chủ.

## Yêu cầu
- Windows + [Node.js LTS](https://nodejs.org) trên máy làm máy chủ (không cần cài thêm thư viện)
- Để các phòng truy cập từ xa: `winget install Cloudflare.cloudflared`

## Sử dụng
Bấm đúp `MO-CHUONG-TRINH.bat` → trình duyệt mở Bảng điều khiển (`http://localhost:8080/admin`), làm theo 4 bước:

1. **Chuẩn bị đề** – kéo thả file nghe, chọn giờ mở khoá, số phòng → nhận *file khoá*, cất vào USB.
2. **Mã phòng** – in phiếu mã cho từng phòng.
3. **Truy cập từ xa** – bật đường hầm HTTPS Cloudflare, lấy địa chỉ cho các phòng.
4. **Ngày thi** – nạp file khoá từ USB, theo dõi các phòng, bấm *Phát đồng loạt*.

Máy phòng thi: mở link trên phiếu, bấm *Thử loa*, chờ lệnh.

## Bảo mật
- File nghe gốc được mã hoá AES-256-GCM **ngay trong trình duyệt**; máy chủ chỉ lưu bản mã hoá.
- Khoá giải mã chỉ nằm trong bộ nhớ máy chủ (không ghi đĩa), chỉ cấp cho phòng khi đã đến giờ.
- Thao tác chuẩn bị đề, bật/tắt truy cập từ xa chỉ làm được trên chính máy chủ; truy cập từ máy khác phải có mã quản trị.
- Mọi diễn biến ghi vào `log.txt`. Thư mục `data/`, `log.txt` và file khoá đã được loại khỏi git.

## Cấu trúc
```
server.js            máy chủ (Node.js thuần)
public/admin.html    bảng điều khiển hội đồng
public/room.html     trang máy phòng thi
MO-CHUONG-TRINH.bat  file khởi chạy trên Windows
HUONG-DAN.txt        hướng dẫn nhanh
```

Tác giả: Vinh Nguyen – VLearn Education
