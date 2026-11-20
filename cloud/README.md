# Phát bài nghe – bản dịch vụ (Cloudflare)

Bản nhiều trường dùng chung của "Phát bài nghe có khoá theo giờ", chạy trên Cloudflare Workers + D1 + R2 + Durable Objects.
Thiết kế: [`../docs/THIET-KE-DICH-VU-R2.md`](../docs/THIET-KE-DICH-VU-R2.md). Bản LAN (`../server.js`) vẫn giữ nguyên làm dự phòng.

> Đây là bản MVP. **Không** dùng tài khoản Cloudflare đang chạy `lvcnghe.pages.dev`; triển khai lên một tài khoản thử riêng.

## Cấu trúc
```
src/index.js        Worker: định tuyến, đăng nhập, giáo viên, admin trường, siêu admin, tải bản mã từ R2
src/truong.js       Durable Object "Truong" (1 đối tượng / trường): đồng hồ mở khoá, trả khoá ĐÚNG GIỜ,
                    lệnh phát đồng loạt + chia đợt, trạng thái phòng, WebSocket máy phòng, chặn dò mã
src/lib.js          mật khẩu PBKDF2, khoá trường (bọc bằng MASTER_KEY), sơ đồ và chia đợt
migrations/         lược đồ D1
public/             trang admin (/<trường>/a), giáo viên (/<trường>/g), máy phòng (/<trường>/ hoặc /<trường>/K7M2),
                    trang chọn trường (/), vlearn.css (hệ thiết kế VLearn), logo
test/               kiểm thử tự động chạy bằng wrangler dev --local (giả lập, không cần tài khoản)
```

## Chạy trên máy
```powershell
cd cloud
npm install
```
Tạo file `cloud/.dev.vars` (không lên git):
```
MASTER_KEY=<32 byte ngẫu nhiên, base64>
SUPER_TOKEN=<mã siêu admin bất kỳ, dài>
```
Tạo nhanh: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

```powershell
npm run dev
```
Mở `http://localhost:8787`. Tạo trường đầu tiên (siêu admin) bằng `POST /api/truong`:
```powershell
$body = @{ slug='lvc'; ten='THPT Chuyên Lương Văn Chánh'; ban_do=@(...); admin=@{ name='Admin'; username='admin' } } | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Post -Uri http://localhost:8787/api/truong -Headers @{ Authorization = "Bearer <SUPER_TOKEN>" } -ContentType 'application/json' -Body $body
```
Kết quả trả về mật khẩu admin trường (chỉ hiện một lần). `ban_do` có cùng dạng `SCHOOL_MAP` trong `server.js`.

## Kiểm thử
```powershell
npm test
```
Chạy luồng đầy đủ trên giả lập: tạo trường → đăng bài (mã hoá như trình duyệt, file nhiều phần) → kiểm tra giải mã lúc đăng →
xếp giờ → máy phòng tải sớm → xin khoá trước giờ bị từ chối → đúng giờ nhận khoá, giải mã ra đúng file gốc →
phát đồng loạt, phòng sát vách sang đợt 2, WebSocket nhận lệnh → mở khoá khẩn cấp → chặn dò mã → tách dữ liệu giữa các trường.

## Triển khai lên tài khoản Cloudflare THỬ
1. Đăng nhập: `npx wrangler login` (tài khoản thử, không phải tài khoản đang chạy kỳ thi).
2. Tạo tài nguyên:
   ```powershell
   npx wrangler d1 create phat-bai-nghe
   npx wrangler r2 bucket create phat-bai-nghe
   ```
   Chép `database_id` vào `wrangler.jsonc`.
3. Đặt bí mật (mỗi lệnh hỏi giá trị, không lưu vào file):
   ```powershell
   npx wrangler secret put MASTER_KEY
   npx wrangler secret put SUPER_TOKEN
   ```
   **Mất MASTER_KEY = mọi bài chưa thi phải đăng lại.** Cất một bản ở nơi an toàn ngoài máy.
4. `npm run deploy` → địa chỉ dạng `https://phat-bai-nghe.<tài-khoản>.workers.dev`.

### Bản thử đang chạy
- Địa chỉ: `https://phat-bai-nghe.phat-bai-nghe-cloud.workers.dev` (tài khoản Cloudflare thử, gói Free). Trường thử: `/lvc/a` (admin), `/lvc/g` (giáo viên), `/lvc/` (máy phòng).
- Đăng nhập wrangler cho tài khoản thử được tách riêng để không đụng tài khoản đang chạy kỳ thi:
  ```powershell
  $env:XDG_CONFIG_HOME = "$PWD\.wrangler-account"; npx wrangler login
  ```
  (thư mục `.wrangler-account/` không lên git; mọi lệnh `wrangler` cho bản thử chạy trong cùng cửa sổ có biến này).
- Tài khoản mới phải **bật R2 trong dashboard** (R2 → Enable) trước khi `r2 bucket create`, nếu không sẽ báo lỗi 10042.
- Kiểm thử nhanh trên bản đã triển khai (tạo trường `SLUG`, đi hết luồng, xoá bài thử):
  ```powershell
  $env:BASE='https://phat-bai-nghe.phat-bai-nghe-cloud.workers.dev'; $env:SUPER_TOKEN='<mã>'; $env:SLUG='kt1'; node test/smoke-remote.mjs
  ```

Gói Workers Free đủ để thử (giới hạn 10 ms CPU/yêu cầu có thể làm chậm đăng nhập, đăng bài lớn). Chạy thật nên dùng gói Paid ($5/tháng).

## Chưa làm trong MVP
- Trang siêu admin (hiện tạo trường bằng API), công cụ vẽ sơ đồ phòng, gói cước/thanh toán.
- Tải "gói dự phòng" để chạy bằng bản LAN (khoá LAN đã có, bài đã được bọc thêm khoá LAN).
- Xác thực 2 lớp cho admin, luật Rate Limiting của Cloudflare, mã phòng chỉ hiệu lực quanh giờ thi.
