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
                    trang chọn trường (/), trang siêu admin VLearn (/_), hướng dẫn sử dụng (/huong-dan, ?t=<trường>
                    để điền sẵn địa chỉ của trường), ban-do.js (sơ đồ dạng chữ), vlearn.css, logo
test/               kiểm thử tự động chạy bằng wrangler dev --local (giả lập, không cần tài khoản);
                    lan.test.mjs chạy gói dự phòng bằng chính ../server.js; smoke-remote.mjs chạy trên bản đã triển khai
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

Quyết định hiện tại (21/11/2026): giữ tài khoản Cloudflare này, gói Free, chưa dùng tên miền riêng.
Bản sao MASTER_KEY và SUPER_TOKEN (file `.wrangler-account/bi-mat-moi-truong-thu.txt`) cất trong Google Drive của người quản lý – không đưa vào git.

Gói Workers Free đủ để thử (giới hạn 10 ms CPU/yêu cầu có thể làm chậm đăng nhập, đăng bài lớn). Chạy thật nên dùng gói Paid ($5/tháng).

## Quản lý trường (siêu admin)
Mở `/_`, nhập SUPER_TOKEN (chỉ giữ trong tab). Xem các trường (số bài, dung lượng, số giáo viên, hoạt động gần nhất),
tạo trường, sửa tên / gói / hạn dùng / tạm khoá / sơ đồ, cấp lại mật khẩu admin trường.
Hết hạn dùng: trường vẫn xem và thi các bài đã xếp lịch, chỉ không đăng được bài mới. Tạm khoá: chặn cả trường – không dùng giữa buổi thi.

## Sơ đồ phòng
Admin trường tự sửa ở tab "Cài đặt trường". Dạng chữ, mỗi khu một dòng `# Tên khu`, mỗi tầng một dòng:
```
# KHU 20 PHÒNG (DÃY TRƯỚC SẢNH)
Tầng 4 [PHÒNG ĐỢI]: 409 12 SINH; 408 12 HOÁ; |; 407 12 LÝ
```
`|` là cầu thang (hai phòng hai bên không tính là sát vách khi chia đợt phát). Không xoá được phòng còn lịch thi.

## Gói dự phòng LAN
Admin tạo khoá LAN (tab "Cài đặt trường", file khoá cất USB) → bài đăng sau đó được bọc thêm khoá LAN →
sau khi xếp lịch, bấm "Tải gói dự phòng LAN": file .zip (đóng ngay trong trình duyệt) gồm `data/` đúng dạng của `server.js`
(bài đã mã hoá, lịch, mã phòng, kỹ thuật viên) và `DOC-TRUOC.txt`. Mất Internet: giải nén vào một bản sao MỚI của bản LAN,
chạy MO-CHUONG-TRINH.bat, nạp file khoá LAN, máy phòng nhập đúng mã đã in. Gói không chứa khoá.
Gói có `data/ban-do.json` (sơ đồ của trường): bản LAN dùng sơ đồ này để hiện sơ đồ, kiểm tra phòng và chia đợt phòng sát vách.
Không có file hoặc file lỗi thì bản LAN dùng sơ đồ LVC cài sẵn trong `server.js` (như trước) và ghi lý do vào `log.txt`.

## Bảo mật tài khoản và mã phòng
- **Xác thực 2 lớp** (TOTP, dùng Google/Microsoft Authenticator): mỗi admin tự bật ở tab "Cài đặt trường" bằng mã QR.
  Mỗi mã 6 số chỉ dùng được một lần. Mất điện thoại: admin khác đặt lại mật khẩu, hoặc VLearn cấp lại ở `/_` – việc này gỡ luôn 2 lớp.
  Danh sách tài khoản ghi rõ admin nào chưa bật.
- **Bắt buộc 2 lớp cho admin** (tuỳ chọn theo trường; admin trường bật ở tab "Cài đặt trường" sau khi chính mình đã bật 2 lớp,
  hoặc VLearn bật ở `/_`): admin chưa có 2 lớp nhập đúng mật khẩu xong chỉ thấy màn hình bật 2 lớp, mọi việc khác bị chặn đến khi bật xong;
  không ai tắt được 2 lớp khi đang bắt buộc. Giáo viên không bị ảnh hưởng.
- **Đăng nhập sai**: 10 lần/tài khoản hoặc 20 lần/IP trong 15 phút thì khoá 15 phút (đếm trên D1). Đặt lại mật khẩu thì mở khoá.
  Thêm Rate Limiting của Cloudflare: 30 lần đăng nhập/phút/IP. Phiên admin 7 ngày, giáo viên 30 ngày.
- **Mã phòng** chỉ dùng được từ 24 giờ trước giờ thi đến 3 giờ sau khi bài thi xong. Mã sai và mã ngoài giờ trả cùng một câu,
  nên không dò trước được mã đúng. Máy đã vào bằng mã (có thẻ) không bị ảnh hưởng.

## Chưa làm
- Thu tiền (gói cước đã có trường `goi`, `het_han`; siêu admin gia hạn bằng tay).
- 2 lớp cho siêu admin (hiện chỉ có SUPER_TOKEN).
