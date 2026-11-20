# Thiết kế: Phát bài nghe – phiên bản dịch vụ trên Cloudflare (R2 + Workers)

*Bản nháp để duyệt – 20/11/2026. Chưa có mã. Các quyết định đã chốt ở mục 9.*

## 1. Mục tiêu và nguyên tắc giữ nguyên

Mục tiêu: nhiều trường dùng chung một dịch vụ, không còn cần một máy giáo viên chạy `server.js` + cloudflared suốt buổi thi.

Giữ nguyên từ bản hiện tại:
- File nghe được mã hoá **trong trình duyệt giáo viên** (AES-256-GCM, khoá ngẫu nhiên cho từng bài). Máy chủ và R2 chỉ thấy bản mã.
- Các phòng tải bản mã **sớm**, kiểm tra SHA-256, lưu IndexedDB.
- Khoá của bài **chỉ phát ra khi đến giờ theo đồng hồ máy chủ** (hoặc admin mở khoá khẩn cấp).
- 3 vai: Admin trường (`/a`), Giáo viên (`/g`), Kỹ thuật viên nhập mã 4 ký tự (không tài khoản), thẻ phòng dài cấp sau khi nhập đúng mã.
- Phát đồng loạt, tự chia 2 đợt xen kẽ cho phòng sát vách theo sơ đồ trường.
- Định dạng bản mã không đổi (`iv(12) || ciphertext || tag(16)`), để file có thể chuyển qua lại với bản chạy LAN.

## 2. Kiến trúc

```
Trình duyệt (admin / giáo viên / máy phòng)
        │  HTTPS (+ WebSocket cho máy phòng và trang admin)
        ▼
Cloudflare Worker "phat-bai-nghe"  ── phục vụ trang tĩnh (Static Assets, miễn phí) + API
   │            │                         │
   ▼            ▼                         ▼
  D1          R2 bucket                 Durable Object "Truong" (1 đối tượng / trường)
 (dữ liệu     (bản mã:                   - đồng hồ mở khoá, khoá bài đã mở (đến hết bài)
  lâu dài)    t/<trường>/<bài>.enc)      - lệnh phát, đợt 1/đợt 2, trạng thái các phòng
                                         - WebSocket máy phòng & admin (Hibernation API)
                                         - đếm nhập sai mã, chặn dò
```

| Thành phần | Giữ gì | Vì sao |
|---|---|---|
| **R2** | Bản mã các bài nghe | Không tính phí tải xuống; bản mã an toàn kể cả khi lộ. |
| **D1** (SQLite) | Trường, tài khoản (băm mật khẩu), bài nghe (siêu dữ liệu, `wrappedKey`), lịch, phân phòng, mã phòng, KTV, sơ đồ trường, nhật ký | Dữ liệu quan hệ, truy vấn chéo cho siêu admin. |
| **Durable Object `Truong`** | Trạng thái "sống" của một trường: khoá bài đã mở, lệnh phát, trạng thái phòng, phiên WebSocket | Một luồng xử lý duy nhất cho mỗi trường → một đồng hồ, không tranh chấp; thay cho các biến `live`, `masterKey` trong RAM của `server.js`. Có `alarm()` để xoá khoá bài khỏi bộ nhớ sau buổi thi. |
| **Worker** | Định tuyến, đăng nhập, nhận file tải lên (chuyển thẳng sang R2), cấp file cho phòng | Không trạng thái. |

Không dùng KV (D1 + DO đủ; KV nhất quán chậm, không hợp cho đồng hồ mở khoá).

### Tải lên và tải xuống
- **Tải lên**: giữ cách chia phần hiện tại (8 MB/phần), Worker ghi vào **R2 multipart upload** (`createMultipartUpload` → `uploadPart` → `complete`). Giới hạn thân yêu cầu của Cloudflare là 100 MB (gói tên miền Free/Pro), nên bắt buộc chia phần. Kiểm tra SHA-256 sau khi ghép xong như hiện nay.
- **Tải xuống**: máy phòng gọi `/api/audio?token=…`, Worker kiểm tra thẻ rồi stream từ R2 (hỗ trợ `Range` để tải tiếp khi rớt mạng). Không mở bucket công khai: bản mã an toàn nhưng vẫn không nên để người ngoài tải đề về để dò sau này.

## 3. Luồng khoá theo giờ trên Workers

Vấn đề: bản hiện tại giữ **khoá riêng của trường trong RAM** máy chủ. Worker không có RAM lâu dài, và đưa khoá riêng của trường lên Cloudflare thì nhà cung cấp dịch vụ (VLearn) đọc được mọi bài của mọi kỳ.

### Đã chọn: phương án B – "tự động" (không USB, không nạp khoá)
1. Mỗi trường có **một cặp khoá RSA-OAEP 3072 do dịch vụ tạo** khi tạo trường. Khoá công khai lưu D1; khoá riêng được bọc (AES-GCM) bằng **khoá chủ của dịch vụ** nằm trong Workers Secret, bản bọc lưu D1. Khoá chủ không bao giờ trả ra ngoài, không ghi nhật ký.
2. *Giáo viên đăng bài*: trình duyệt mã hoá file bằng khoá AES ngẫu nhiên, bọc khoá AES bằng khoá công khai của trường (`wrappedKey`), tải bản mã lên R2 – giống hiện nay, chỉ khác khoá công khai do dịch vụ cấp.
3. *Admin xếp lịch, phân phòng, in phiếu* – như bây giờ. **Bỏ bước "Tạo khoá trường" và "Nạp khoá" sáng ngày thi.**
4. *Máy phòng xin khoá*: yêu cầu đi vào DO `Truong`. DO so `Date.now()` (giờ Cloudflare) với `t0`; chưa đến giờ → từ chối, ghi nhật ký. Đến giờ → DO mới mở khoá chủ → khoá riêng trường → khoá bài, giữ khoá bài trong bộ nhớ DO đến hết bài để trả cho các phòng còn lại, rồi xoá. Admin trường vẫn có nút mở khoá khẩn cấp.
5. **Chỉ một chỗ trong mã** được phép mở khoá bài (hàm trong DO, có kiểm tra giờ); kiểm thử tự động chứng minh không có đường API nào trả khoá trước giờ. Mọi lần mở khoá ghi nhật ký kèm giờ, phòng, IP – admin trường xem được.
6. Xác minh bài mở được: ngay khi giáo viên đăng xong, DO thử mở khoá + giải mã thử (thay cho bước "kiểm tra khi nạp khoá" hiện nay) rồi xoá khoá khỏi bộ nhớ – lỗi thì báo giáo viên đăng lại ngay, không đợi đến ngày thi.

Đánh đổi đã chấp nhận: VLearn (người có quyền vào tài khoản Cloudflare và khoá chủ) **về kỹ thuật** mở được mọi bài trước giờ. Giảm thiểu:
- Tài khoản Cloudflare chạy dịch vụ chỉ một người giữ, bật xác thực 2 lớp; không ai khác có quyền đọc Secret (Cloudflare không cho đọc lại Secret sau khi đặt).
- Mỗi trường một khoá riêng → lộ một trường không kéo theo trường khác; đổi khoá trường được (bài chưa thi phải đăng lại, như hiện nay).
- Điều khoản dịch vụ ghi rõ cam kết và cơ chế này cho trường biết trước khi đăng ký.
- Giai đoạn sau có thể thêm **chế độ tăng cường** cho trường nào cần (phương án A dưới đây).

### Khoá dự phòng cho bản LAN
Vì vẫn giữ bản LAN làm dự phòng: trường có thể (không bắt buộc) tạo một **khoá LAN** như hiện nay (tải file khoá về USB, chỉ khoá công khai lên dịch vụ). Khi đó trình duyệt giáo viên bọc khoá bài **hai lần**: một cho dịch vụ, một cho khoá LAN. Ngày thi nếu mất mạng/Cloudflare sự cố: admin tải "gói dự phòng" (bản mã + `wrappedKey` LAN, không chứa khoá) từ hôm trước, mở `server.js`, nạp file khoá LAN từ USB – đúng quy trình hiện nay.

### Phương án A – "nạp khoá trong trình duyệt" (để dành cho chế độ tăng cường)
1. *Tạo khoá trường*: trình duyệt admin tạo cặp RSA-OAEP 3072; khoá công khai lên D1, khoá riêng tải về thành file (USB) – như bây giờ.
2. *Giáo viên đăng bài*: mã hoá file bằng khoá AES ngẫu nhiên, bọc khoá AES bằng khoá công khai trường (`wrappedKey`), tải bản mã lên R2 – như bây giờ.
3. *Admin xếp lịch, phân phòng, in phiếu* – như bây giờ (dữ liệu ở D1).
4. *Sáng ngày thi, "Nạp khoá"*: admin kéo file khoá vào trang `/a`. **Khoá riêng không rời trình duyệt.** Trang tự mở (`unwrap`) khoá AES của các bài xếp lịch trong ngày (hoặc 24 giờ tới), gửi từng khoá AES lên DO `Truong`, kèm SHA-256 bản mã để DO kiểm tra khớp bài.
5. DO lưu khoá bài trong bộ nhớ SQLite của nó, **mã hoá thêm một lớp bằng khoá bí mật của Worker** (Workers Secret), đặt `alarm` xoá khoá khi bài thi kết thúc + 2 giờ.
6. Máy phòng xin khoá: DO so `Date.now()` (giờ Cloudflare) với `t0` của bài; chưa đến giờ → từ chối và ghi nhật ký; đến giờ → trả khoá. Admin có nút mở khoá khẩn cấp.
7. Admin có nút "Gỡ khoá khỏi máy chủ" (xoá ngay khỏi DO).

Kết quả: Cloudflare/VLearn chỉ có thể đọc **các bài của đúng ngày thi đó, từ lúc admin nạp khoá đến khi tự xoá**. Đổi lại vẫn cần thao tác USB mỗi sáng thi. Không làm trong MVP.

*Hướng nghiên cứu sau (không làm trong MVP):* mã hoá khoá bài theo mốc thời gian của mạng drand (timelock, "tlock") – không ai giữ khoá trước giờ, kể cả VLearn; nhưng không mở khoá khẩn cấp sớm được và phụ thuộc mạng drand.

### Đồng bộ phát
- Máy phòng giữ **một WebSocket** tới DO `Truong` (Hibernation API: không tính thời gian chạy khi kết nối im lặng). DO đẩy lệnh phát (`playAt`, đợt 1/2) tức thì, máy phòng gửi trạng thái mỗi 5 giây; trang admin nhận cập nhật qua WebSocket thay cho hỏi mỗi giây.
- Nếu WebSocket rớt: máy phòng quay về hỏi `/api/report` mỗi 3 giây (giống hiện tại), rồi thử nối lại.
- Đồng bộ giờ giữ cách cũ (`/api/time`, lấy trung điểm thời gian khứ hồi), lệnh phát vẫn hẹn trước 5 giây.
- `splitWaves` dùng **sơ đồ của từng trường** (lưu trong D1, admin vẽ bằng bảng ô) thay cho `SCHOOL_MAP` cố định.

## 4. Mô hình nhiều trường (tenant)

- Mỗi trường có `slug` (ví dụ `lvc`). Đường dẫn: `<tên-miền>/lvc/a`, `/lvc/g`, `/lvc/K7M2`. (Giai đoạn sau có thể đổi sang tên miền con `lvc.<tên-miền>`.)
- Mã phòng 4 ký tự chỉ duy nhất **trong một trường**; slug trong đường dẫn phân biệt trường. Trang `/` chung: chọn trường rồi nhập mã (hoặc mở link in sẵn).
- Mọi bảng D1 có cột `truong_id`; mọi truy vấn lọc theo trường lấy từ phiên đăng nhập hoặc thẻ phòng, không lấy từ tham số người dùng gửi. R2 key có tiền tố `t/<truong_id>/`. Mỗi trường một DO (`idFromName(truong_id)`).
- Giới hạn theo trường: dung lượng (ví dụ 2 GB), số bài, số phòng – để một trường không làm tốn tài nguyên của trường khác.

## 5. Phân quyền

| Vai | Phạm vi | Làm được |
|---|---|---|
| Siêu admin (VLearn) | Toàn dịch vụ | Tạo/khoá trường, gói cước, tạo admin đầu tiên của trường, xem dung lượng & nhật ký vận hành. Giao diện **không** có chức năng xem mã phòng, mở khoá hay phát. |
| Admin trường | Một trường | Như `/a` hiện nay: tài khoản GV, KTV, sơ đồ, xếp lịch, phiếu mã, phát, mở khoá khẩn cấp, khoá LAN dự phòng. |
| Giáo viên | Bài của mình | Đăng, xem, xoá bài chưa xếp lịch, đổi mật khẩu. |
| KTV (máy phòng) | Một phòng của một bài | Nhập mã → thẻ phòng → tải bản mã, xin khoá, báo trạng thái. |

- Bỏ đặc quyền "mở trên chính máy chủ thì không cần đăng nhập": trên dịch vụ, admin luôn đăng nhập. Nên có xác thực 2 lớp (TOTP) cho admin trường và siêu admin (giai đoạn 2).
- Mật khẩu: PBKDF2-SHA256 qua WebCrypto (Workers không có scrypt); phiên lưu ở D1, cookie `HttpOnly; Secure; SameSite=Lax`.
- Chống dò mã phòng: đếm sai trong DO theo IP + theo trường (như hiện nay: 20 lần / 10 phút), thêm luật Rate Limiting của Cloudflare cho `/api/login`.
- Nhật ký (`log.txt` hiện nay) chuyển vào D1, mỗi trường xem nhật ký của mình, xuất được ra file.

## 6. Chi phí ước tính

Bảng giá tra ngày 20/11/2026 tại developers.cloudflare.com (trang R2 cập nhật 30/10/2026, Workers 18/11/2026, giới hạn 19/11/2026):

| Dịch vụ | Miễn phí | Gói Workers Paid ($5/tháng/tài khoản) |
|---|---|---|
| R2 (Standard) | 10 GB-tháng; 1 triệu thao tác loại A; 10 triệu loại B; **tải xuống miễn phí** | $0,015/GB-tháng; A $4,50/triệu; B $0,36/triệu |
| Workers | 100.000 yêu cầu/ngày; 10 ms CPU/yêu cầu | 10 triệu yêu cầu/tháng, sau đó $0,30/triệu; 30 triệu ms CPU, sau đó $0,02/triệu ms |
| Durable Objects (SQLite) | 100.000 yêu cầu/ngày; 13.000 GB-s/ngày; 5 GB | 1 triệu yêu cầu, sau đó $0,15/triệu; 400.000 GB-s, sau đó $12,50/triệu GB-s. Tin nhắn WebSocket đến được tính theo tỉ lệ 20:1 |
| D1 | 5 triệu dòng đọc/ngày; 100.000 dòng ghi/ngày; 5 GB | 25 tỉ dòng đọc, 50 triệu dòng ghi, 5 GB đã gồm |

Ví dụ một buổi thi cỡ LVC: 2 bài × 10 MB, 36 phòng, 3 giờ.
- R2: 72 lượt tải (loại B) – không đáng kể; lưu trữ vài chục MB.
- Nếu giữ cách hỏi mỗi 2 giây như hiện nay: 36 phòng × 1.800 lần/giờ × 3 giờ ≈ **194.000 yêu cầu → vượt mức miễn phí 100.000/ngày**. Vì vậy thiết kế dùng WebSocket: khoảng 36 kết nối + tin báo trạng thái 5 giây/lần ≈ 78.000 tin đến, tính phí như ~3.900 yêu cầu DO.
- Ước tính 20 trường × 10 buổi thi/tháng × 40 phòng: R2 ~5 GB (trong mức miễn phí), yêu cầu dưới 10 triệu → **khoảng $5/tháng tổng cộng** (chỉ phí tối thiểu gói Paid). Chi phí tăng chủ yếu khi số trường lên hàng trăm.
- Gói Free đủ để **thử nghiệm**, nhưng chạy thật nên dùng gói Paid: giới hạn 10 ms CPU/yêu cầu của gói Free không đủ cho băm mật khẩu PBKDF2 và kiểm tra SHA-256 file tải lên.
- Tên miền riêng (nếu chọn): khoảng 10–15 USD/năm tuỳ đuôi; dùng `*.workers.dev` thì miễn phí.

## 7. Rủi ro và cách giảm

| Rủi ro | Giảm thiểu |
|---|---|
| Trường **mất Internet** đúng giờ thi | Bản mã đã tải sớm; chỉ cần mạng lúc xin khoá (vài trăm byte). Giữ **bản LAN `server.js`** làm dự phòng; cho xuất bài + `wrappedKey` từ dịch vụ sang bản LAN. |
| Cloudflare gặp sự cố toàn cầu | Như trên: dự phòng LAN; khuyến nghị trường nạp khoá và cho phòng tải bản mã từ hôm trước. |
| Nhà cung cấp (VLearn) bị nghi làm lộ đề – **rủi ro lớn nhất của phương án B** | Khoá chủ chỉ trong Workers Secret, một người giữ tài khoản + 2 lớp; khoá riêng từng trường; nhật ký mọi lần mở khoá; điều khoản nói rõ; sau này có chế độ tăng cường (phương án A). |
| Lộ khoá chủ của dịch vụ | Đổi khoá chủ = bọc lại khoá riêng các trường (không phải đăng lại bài); quy trình đổi khoá viết sẵn. |
| Lỗi phân tách trường (trường A thấy dữ liệu trường B) | `truong_id` lấy từ phiên/thẻ; kiểm thử tự động riêng cho việc truy cập chéo. |
| Dò mã phòng 4 ký tự (32⁴ ≈ 1 triệu tổ hợp) | Đếm sai trong DO + Rate Limiting; mã chỉ hiệu lực trong khung giờ của bài (ví dụ từ 24 giờ trước đến hết bài). |
| Dữ liệu cá nhân (tên, tài khoản giáo viên) | Lưu tối thiểu; có chính sách bảo vệ dữ liệu theo Nghị định 13/2023/NĐ-CP khi có trường ngoài dùng. |
| Mất file khoá trường | Như hiện nay: bài chưa thi phải đăng lại; nhắc admin giữ 2 bản USB. |
| Phụ thuộc Cloudflare | Mã ở mức Web chuẩn (WebCrypto, SQLite); chuyển sang nền khác được nhưng tốn công. |

## 8. Lộ trình

**Giai đoạn 0 – duyệt thiết kế** (bản này) và chốt các quyết định mở.

**Giai đoạn 1 – MVP cho 1 trường (LVC), trên môi trường thử riêng**
- Thư mục mới `cloud/` trong repo (không đụng `server.js`, `public/`, `link/` đang chạy thật).
- Worker + D1 + R2 + DO `Truong`; chuyển 3 trang hiện có sang gọi API mới (giữ giao diện).
- Kiểm thử tự động bằng `@cloudflare/vitest-pool-workers` (chạy giả lập Cloudflare ngay trên máy, không cần tài khoản): đăng bài → xếp giờ → máy phòng tải sớm → xin khoá trước giờ bị từ chối → đúng giờ nhận khoá và giải mã được → phát đồng loạt, đợt 2 đúng giờ.
- Triển khai lên **một tài khoản Cloudflare thử** (không phải tài khoản đang chạy `lvcnghe.pages.dev`), tên `*.workers.dev`; diễn tập song song với bản LAN.

**Giai đoạn 2 – nhiều trường**
- Trang siêu admin, tạo trường, công cụ vẽ sơ đồ phòng, giới hạn theo trường, TOTP cho admin, Rate Limiting, xuất/nhập sang bản LAN, tên miền riêng.
- Thử với 1–2 trường quen trước khi mở rộng.

**Giai đoạn 3 – thu phí và vận hành**
- Gói cước theo năm học, giới hạn theo gói (số phòng, số bài/kỳ, dung lượng, số tài khoản GV); bảng `goi_cuoc` + hạn dùng trên D1, hết hạn thì chỉ xem, không đăng bài mới (không bao giờ khoá giữa buổi thi).
- Thu tiền: giai đoạn đầu chuyển khoản + xuất hoá đơn thủ công, siêu admin gia hạn bằng tay; tích hợp cổng thanh toán sau khi có đủ trường.
- Điều khoản sử dụng, chính sách bảo vệ dữ liệu, cam kết về việc giữ khoá (phương án B).
- Giám sát và cảnh báo, sao lưu D1 (Time Travel) định kỳ, tài liệu cho trường.

## 9. Quyết định đã chốt (20/11/2026)
1. **Giữ khoá: phương án B – tự động** (dịch vụ giữ khoá, mở đúng giờ; trường không cần USB). Phương án A để dành làm chế độ tăng cường.
2. **Tên miền: `*.workers.dev` trước**, mua tên miền riêng khi có trường thứ hai.
3. **Có thu phí** – gói trả phí theo năm học (giai đoạn 3); MVP chưa làm phần thanh toán nhưng dữ liệu có sẵn chỗ cho gói cước.
4. **Giữ bản LAN `server.js` làm dự phòng**, kèm khoá LAN tuỳ chọn và "gói dự phòng".

Còn chờ: người dùng tự tạo **một tài khoản Cloudflare mới (miễn phí)** cho môi trường thử – trong lúc chờ, MVP được phát triển và kiểm thử hoàn toàn trên máy bằng giả lập.
