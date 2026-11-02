# Phát bài nghe có khoá theo giờ

Hệ thống phát bài thi nghe đồng loạt cho nhiều phòng thi, nhiều bài thi cùng lúc. File nghe được mã hoá ngay trên máy giáo viên, các phòng tải về sớm, nhưng chỉ giải mã được khi đến giờ thi theo đồng hồ máy chủ.

## Ba vai
| Vai | Địa chỉ | Việc làm |
|---|---|---|
| Admin | `/a` | Tạo tài khoản, xem ai đã đăng bài, xếp giờ, phân phòng cho kỹ thuật viên trên sơ đồ, in phiếu mã, nạp khoá, phát đồng loạt |
| Giáo viên | `/g` | Đăng nhập, đăng bài nghe của mình, xoá bài chưa xếp lịch |
| Kỹ thuật viên | `/` hoặc `/K7M2` | Không cần tài khoản: nhập mã 4 ký tự trên phiếu hoặc mở link in sẵn |

## Yêu cầu
- Windows + [Node.js LTS](https://nodejs.org) trên máy làm máy chủ (không cần cài thêm thư viện)
- Để các phòng truy cập từ xa: `winget install Cloudflare.cloudflared`

## Cài trên máy mới
1. Lấy file `CAI-DAT-MAY-MOI.bat` (trong repo này, hoặc chép bằng USB) về máy mới.
2. Bấm đúp. File sẽ tự cài Node.js, Git, cloudflared, tải chương trình về `%USERPROFILE%\phat-bai-nghe` và tạo 2 lối tắt trên Desktop:
   **Phát bài nghe** (mở chương trình) và **Cập nhật Phát bài nghe** (lấy bản mới nhất).
3. Lần đầu tải sẽ hiện cửa sổ đăng nhập GitHub – đăng nhập tài khoản có quyền vào repo.
4. Nếu vừa cài Node.js lần đầu, khởi động lại máy.

## Cập nhật
Bấm đúp `CAP-NHAT.bat` (hoặc lối tắt *Cập nhật Phát bài nghe*). Dữ liệu kỳ thi (`data/`, `log.txt`) được giữ nguyên.
Không cập nhật vào sáng ngày thi – cập nhật và diễn tập trước ít nhất một ngày.

Đề tạo ở bản cũ (một đề, `data/config.json`) không dùng được ở bản này: đăng lại qua trang giáo viên.

## Sử dụng
Bấm đúp `MO-CHUONG-TRINH.bat` → trình duyệt mở trang admin (`http://localhost:8080/a`). Trên chính máy chủ không cần đăng nhập.

Chuẩn bị (một lần):
1. **Bài nghe** – bấm *Tạo khoá trường*, chép file khoá vào USB.
2. **Giáo viên & KTV** – tạo tài khoản cho từng giáo viên, gửi tên đăng nhập và mật khẩu; thêm tên các kỹ thuật viên.
3. **Truy cập từ xa** – bật đường hầm HTTPS, gửi địa chỉ `/g` cho giáo viên.

Mỗi kỳ thi:
1. Giáo viên đăng bài ở `/g`.
2. Admin vào **Bài nghe**, xếp giờ cho từng bài, chọn một kỹ thuật viên rồi bấm các ô phòng trên sơ đồ, in phiếu mã (xếp theo kỹ thuật viên).
3. Sáng ngày thi, vào **Ngày thi**, nạp file khoá từ USB (một lần cho mọi bài).
4. Đến giờ, phát từng bài hoặc tích nhiều bài rồi phát cùng lúc.

Máy phòng thi: mở link trên phiếu, bấm *Thử loa*, chờ lệnh.

## Link ngắn cố định
`https://lvcnghe.pages.dev` chuyển mọi đường dẫn về địa chỉ đường hầm hiện tại, ví dụ `lvcnghe.pages.dev/K7M2`, `lvcnghe.pages.dev/g`. Mỗi lần bật hoặc tắt truy cập từ xa, máy chủ tự báo địa chỉ mới; link có thể mất khoảng một phút mới trỏ đúng.

- Mã code của trang chuyển hướng nằm ở `link/` (Cloudflare Pages, lưu địa chỉ trong KV). Triển khai: `wrangler pages deploy public --project-name lvcnghe --branch main` trong thư mục `link/`.
- Máy chủ cần `data/link.json` (địa chỉ và mã link), file này không lên GitHub. Máy mới: chép file này sang, hoặc nhập ở thẻ *Truy cập từ xa* trên trang admin. Không có file này thì phiếu in dùng địa chỉ trycloudflare dài.

## Bảo mật
- File nghe gốc được mã hoá AES-256-GCM **ngay trong trình duyệt giáo viên**; máy chủ chỉ lưu bản mã hoá.
- Khoá của từng bài được bọc bằng khoá công khai của trường (RSA-OAEP). Máy chủ chỉ giữ khoá riêng của trường trong bộ nhớ sau khi admin nạp, không ghi đĩa, và chỉ cấp khoá của bài cho phòng khi đã đến giờ.
- Mất file khoá trường thì các bài chưa thi phải đăng lại. Tạo khoá mới cũng vậy.
- Mật khẩu lưu dạng băm scrypt. Giáo viên chỉ thấy bài của mình và không thấy mã phòng.
- Bật/tắt truy cập từ xa chỉ làm được trên chính máy chủ; admin từ máy khác phải đăng nhập tài khoản admin.
- Mọi diễn biến ghi vào `log.txt`. Thư mục `data/`, `log.txt` và file khoá đã được loại khỏi git.

## Cấu trúc
```
server.js            máy chủ (Node.js thuần)
public/admin.html    trang admin (/a)
public/teacher.html  trang giáo viên (/g)
public/room.html     trang máy phòng thi (/ và /<mã>)
link/                trang chuyển hướng lvcnghe.pages.dev
MO-CHUONG-TRINH.bat  file khởi chạy trên Windows
CAP-NHAT.bat         lấy bản mới nhất từ GitHub
CAI-DAT-MAY-MOI.bat  cài đặt trọn gói trên máy mới
HUONG-DAN.txt        hướng dẫn nhanh
```

Tác giả: Vinh Nguyen – VLearn Education
