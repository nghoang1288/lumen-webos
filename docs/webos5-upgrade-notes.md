# Ghi chú Nâng cấp & Tương thích webOS 5 (Chromium 68)

Tài liệu này tổng hợp toàn bộ các vấn đề kỹ thuật, nguyên nhân gốc rễ (Root Cause), giải pháp khắc phục và những lưu ý quan trọng đã được ghi nhận trong quá trình thử nghiệm, sửa lỗi và tối ưu Lumen trên nền tảng **LG webOS 5.x** (cụ thể là dòng webOS 5.6.2 trên TV LG OLED BX / CX với Chromium 68 và Linux kernel 4.x).

---

## 1. Màn hình đen khi cài đè `.ipk` trực tiếp (`dev/install`) lúc Lumen đang mở ở Foreground

### Triệu chứng
- Khi triển khai build mới bằng `tools/deploy.sh` hoặc qua `ares-install` / Dev Manager: tiến trình cài đặt có thể báo thành công (`SUCCESS`) hoặc treo ở trạng thái đóng app.
- Màn hình TV chuyển sang màu đen hoàn toàn, chỉ còn hiển thị và di chuyển được con trỏ chuột Magic Remote.
- Các lệnh gọi khởi chạy ứng dụng qua Luna bus (`luna-send .../launch`) đều bị treo không trả về kết quả.
- Endpoint Chrome Remote DevTools (`http://127.0.0.1:9998/json`) trả về mảng rỗng `[ ]` (không còn target nào lắng nghe).

### Nguyên nhân gốc rễ (Root Cause)
- Trên **webOS 5** (sử dụng Linux kernel 4.x và định dạng hệ thống tập tin flash `tfat` tại vùng nhớ `/media/developer/apps/`):
  Dịch vụ cài đặt `com.webos.appInstallService/dev/install` khi xử lý gói cài đặt sẽ vừa cố gắng gửi tín hiệu đóng ứng dụng đang hiển thị ở foreground, vừa đồng thời xóa và ghi đè dữ liệu tệp tin ứng dụng trong thư mục đích.
- Quá trình này dẫn đến xung đột tài nguyên I/O giữa tiến trình quản lý ứng dụng hệ thống (`/usr/sbin/sam`) và luồng nhân `tfat12d`. Tiến trình `/usr/sbin/sam` rơi vào trạng thái **`D` (uninterruptible disk sleep)** tại hàm nhân `walk_component`.
- Khi ở trạng thái `D`, tiến trình không thể nhận bất kỳ tín hiệu nào (kể cả `kill -9` hay lệnh khởi động lại service qua `systemctl restart sam`), làm tê liệt toàn bộ hệ thống quản lý ứng dụng của webOS.

### Cách xử lý & Phòng tránh
- **Nếu TV đã bị kẹt trạng thái `D`:** Buộc phải reboot TV sạch qua Luna bus bằng lệnh:
  ```sh
  luna-send -n 1 luna://com.webos.service.tvpower/power/reboot '{"reason":"swDownload"}'
  ```
- **Biện pháp phòng tránh khi cập nhật (Đã tích hợp vào `tools/deploy.sh`):**
  Trước khi gọi `dev/install`, luôn chủ động chuyển foreground sang ứng dụng mặc định của LG (như `com.webos.app.home`) hoặc đóng Lumen bằng `closeByAppId`, kèm theo khoảng nghỉ `sleep 2` để giải phóng hoàn toàn tài nguyên và tệp đang mở:
  ```sh
  echo "Closing $APP_ID before install to prevent webOS 5 SAM deadlock..."
  ssh -tt "$LUMEN_TV_HOST" "touch /tmp/allow_lg_home; luna-send -n 1 luna://com.webos.applicationManager/launch '{\"id\":\"com.webos.app.home\"}' >/dev/null 2>&1 || true; luna-send -n 1 luna://com.webos.applicationManager/closeByAppId '{\"id\":\"$APP_ID\"}' >/dev/null 2>&1 || true; sleep 2" | tr -d '\r'
  ```
- **Phương án cập nhật nhanh (Hot-reload giao diện):** Khi chỉ thay đổi giao diện web (`app.js`, `app.css`, `index.html`), thay vì đóng gói và cài lại `.ipk`, hãy sao chép trực tiếp qua `scp` vào `/media/developer/apps/usr/palm/applications/com.samrenfrew.lumen/` rồi relaunch app:
  ```sh
  scp -q app/dist/index.html app/dist/assets/* root@<tv-ip>:/media/developer/apps/usr/palm/applications/com.samrenfrew.lumen/
  ssh root@<tv-ip> "luna-send -n 1 luna://com.webos.applicationManager/launch '{\"id\":\"com.samrenfrew.lumen\"}'"
  ```

---

## 2. Tương thích trình duyệt webOS 5 (Chromium 68 / V8 6.8)

### Triệu chứng
- Ứng dụng mở lên chỉ thấy màn hình đen/trắng, không hiển thị bất kỳ giao diện nào.
- DevTools Console báo lỗi `SyntaxError` hoặc bundle JS ngừng thực thi ngay từ đầu.

### Nguyên nhân gốc rễ (Root Cause)
- Bản gốc Lumen thiết lập build target là `chrome79` (tương thích webOS 6.x trở lên).
- Tuy nhiên, webOS 5.6.2 tích hợp **Chromium 68** (`Chrome/68.0.3440.106`, engine V8 6.8). Phiên bản này chưa hỗ trợ các cú pháp JavaScript hiện đại thuộc chuẩn ES2019 và ES2020:
  - Optional catch binding: `try { ... } catch { ... }` (không có biến bắt lỗi).
  - Optional chaining: `obj?.prop`, `func?.()`.
  - Nullish coalescing: `a ?? b`.
  - Một số cú pháp object rest/spread phức tạp.

### Cách xử lý & Lưu ý
- Trong `app/vite.config.ts`, đặt cấu hình:
  ```ts
  const BROWSER_TARGET = 'chrome60';
  ```
- Với `target: 'chrome60'`, Vite và esbuild sẽ tự động chuyển đổi toàn bộ mã nguồn ứng dụng cũng như các thư viện phụ thuộc (`node_modules`) về cú pháp ES2017/ES2018 tương thích 100% với Chromium 68.
- **Kiểm tra nhanh cú pháp trên TV:** Có thể dùng Node runtime trên TV để xác minh tính tương thích của bundle JS trước khi mở app:
  ```sh
  node --check /media/developer/apps/usr/palm/applications/com.samrenfrew.lumen/assets/app.js
  ```

---

## 3. Ký tự xuống dòng Windows (`CRLF` - `\r\n`) làm hỏng script trên TV

### Triệu chứng
- Script chạy ngầm trên TV `/var/lib/homehook/watch.sh` không tự động khởi chạy sau khi boot TV.
- Khi chạy script thủ công qua SSH, shell báo lỗi:
  ```text
  /bin/sh: /var/lib/homehook/watch.sh: not found
  ```
  hoặc:
  ```text
  /var/lib/homehook/watch.sh: line 1: #!/bin/sh^M: not found
  ```

### Nguyên nhân gốc rễ (Root Cause)
- Trên môi trường Windows, trình soạn thảo hoặc git thường mặc định lưu tệp với định dạng xuống dòng `CRLF` (`\r\n`).
- Shell BusyBox `/bin/sh` trên hệ điều hành Linux của webOS đọc dòng shebang `#!/bin/sh\r`, hiểu nhầm đường dẫn trình thông dịch là `/bin/sh\r` (với ký tự điều khiển carriage return `\r`) và báo không tìm thấy tệp.

### Cách xử lý & Lưu ý
- **Thiết lập `.gitattributes` ở gốc repository:**
  Ép chuẩn `LF` cho toàn bộ mã nguồn, đặc biệt là các script `.sh` và thư mục `tools/tv/`:
  ```gitattributes
  * text=auto eol=lf
  *.sh text eol=lf
  tools/tv/* text eol=lf
  ```
- **Xử lý nhanh trên TV khi tệp bị dính CRLF:**
  ```sh
  sed -i 's/\r$//' /var/lib/homehook/watch.sh && chmod +x /var/lib/homehook/watch.sh
  ```

---

## 4. Mất hiệu ứng khởi động tức thì (Instant Boot UI Skeleton)

### Triệu chứng
- Khi mở Lumen, màn hình xuất hiện một khoảng đen hoặc giật nhẹ trước khi các ô ứng dụng và đồng hồ hiện lên.
- Giao diện khung xương (Instant Boot Skeleton) không xuất hiện ngay ở frame đầu tiên.

### Nguyên nhân gốc rễ (Root Cause)
1. **Lệnh thoát sớm (`return`) trong `app/index.html`:**
   Đoạn mã khởi tạo sớm có câu lệnh:
   ```js
   if (!boot || !(boot.url || boot.bg)) return;
   ```
   Nếu người dùng chưa lưu hình nền cache (`lumen-boot-wallpaper-v1`), lệnh `return` này lập tức kết thúc hàm IIFE, khiến khối mã dựng giao diện Instant Boot UI Skeleton (vẽ đồng hồ, thời tiết, các ô app từ cache) nằm phía dưới không được chạy.
2. **Thiếu tệp CSS ngoài (`dist/assets/app.css`):**
   Nếu cấu hình Vite gom (inline) CSS vào `app.js` bằng JavaScript DOM injection (`document.createElement('style')`), thì tại thời điểm `index.html` thực thi script inline, `app.js` chưa tải và chạy xong. Do đó HTML của skeleton được render nhưng không có style, gây vỡ giao diện hoặc không hiển thị được.

### Cách xử lý & Lưu ý
- **Tách riêng điều kiện kiểm tra wallpaper:**
  Đưa việc gán hình nền vào khối điều kiện `if (...)` riêng biệt, không dùng `return` sớm để script luôn chạy tiếp tới phần dựng skeleton:
  ```js
  var boot = JSON.parse(localStorage.getItem('lumen-boot-wallpaper-v1') || 'null');
  if (boot && (boot.url || boot.bg) && (!boot.sel || !config.wallpaper || boot.sel === config.wallpaper)) {
    root.classList.add('wp-image');
    // ... gán style backgroundImage ...
  }
  // Tiếp tục chạy khối Instant Boot UI Skeleton bên dưới
  ```
- **Xuất CSS ra tệp tĩnh độc lập:**
  Trong `app/vite.config.ts`, đặt `build.cssCodeSplit: false` và cấu hình `assetFileNames` xuất CSS ra `assets/app.css`. Nhờ đó `index.html` có thẻ `<link rel="stylesheet" href="./assets/app.css">`, trình duyệt nạp và áp dụng CSS ngay lập tức trước khi frame đầu tiên được vẽ.
- **Tối ưu thuộc tính `appinfo.json`:**
  Khai báo thêm các cờ tối ưu hóa cửa sổ và khởi chạy:
  ```json
  {
    "noSplashOnLaunch": true,
    "handlesRelaunch": true,
    "defaultWindowType": "card"
  }
  ```

---

## 5. Lưu ý khi truyền chuỗi JSON qua SSH từ PowerShell trên Windows

### Triệu chứng
- Khi thực thi các lệnh Luna từ PowerShell trên Windows, ví dụ:
  ```powershell
  ssh root@<tv-ip> "luna-send -n 1 luna://com.webos.applicationManager/launch '{\"id\":\"com.samrenfrew.lumen\"}'"
  ```
- Lệnh bị treo vô tận hoặc TV trả về lỗi:
  ```json
  {"returnValue":false,"errorCode":-1,"errorText":"invalid parameters"}
  ```

### Nguyên nhân gốc rễ (Root Cause)
- PowerShell tự động phân tích và loại bỏ các ký tự dấu ngoặc kép `"` khi chuyển chuỗi đối số qua lệnh SSH. Kết quả là `luna-send` trên TV nhận tham số rỗng hoặc chuỗi JSON bị biến dạng (mất `"` quanh key/value).

### Cách xử lý
- **Cách 1: Sử dụng Base64 decode trực tiếp trên TV (Khuyên dùng khi chạy từ PowerShell):**
  Mã hóa JSON sang Base64 rồi giải mã ở phía TV trước khi truyền vào `luna-send`:
  ```powershell
  # {"id":"com.samrenfrew.lumen"} -> eyJpZCI6ImNvbS5zYW1yZW5mcmV3Lmx1bWVuIn0=
  ssh root@<tv-ip> 'luna-send -n 1 luna://com.webos.applicationManager/launch "$(echo eyJpZCI6ImNvbS5zYW1yZW5mcmV3Lmx1bWVuIn0= | base64 -d)"'
  ```
- **Cách 2: Escape kép ký tự ngoặc kép trong PowerShell:**
  ```powershell
  ssh root@<tv-ip> 'luna-send -n 1 luna://com.webos.applicationManager/launch '\''{\"id\":\"com.samrenfrew.lumen\"}'\'''
  ```
- **Cách 3: Chạy từ môi trường Git Bash / WSL / Linux shell** để tránh cơ chế parse chuỗi của PowerShell.

---

## 6. Lỗi màn hình đen khi đang xem YouTube (hoặc app đa phương tiện) rồi ấn nút Home

### Triệu chứng
- Đang xem video trên YouTube (`youtube.leanback.v4`), khi bấm nút Home trên Magic Remote thì TV không thoát ra được màn hình Home hoặc màn hình chuyển sang màu đen sì hoàn toàn, chỉ còn hiển thị và di chuyển được con trỏ chuột.
- Khi màn hình bị đen, bấm các nút trên điều khiển không có phản hồi, chỉ khi tắt TV đi bật lại thì mới hiển thị lại bình thường.

### Nguyên nhân gốc rễ (Root Cause)
Sau khi truy vết qua DevTools WebSocket và nhật ký hệ thống của `sam` (System Application Manager) trên webOS 5, đã phát hiện 4 nguyên nhân kết hợp:

1. **Xung đột cờ `handlesRelaunch: true` & `defaultWindowType: "card"` trong `appinfo.json`:**
   - Trên webOS 5, khi một ứng dụng khai báo `handlesRelaunch: true`, SAM sẽ không tự động nâng cửa sổ ứng dụng lên foreground khi nhận lệnh `launch`. Thay vào đó, webOS coi đây là sự kiện `webOSRelaunch` và chờ ứng dụng tự kích hoạt cửa sổ.
   - Khi YouTube đang giữ quyền render toàn màn hình, SAM không nâng cửa sổ Lumen lên được khiến thông tin ứng dụng hiển thị rơi vào trạng thái rỗng: `{"appId": "", "returnValue": true}`. Khi `appId` rỗng, TV không có bề mặt hiển thị nào và chỉ vẽ con trỏ chuột trên nền đen.
2. **Cờ `"appCategory": ["home"]`:**
   - Cờ này được thêm ở các bản webOS 25 gần đây. Trên webOS 5, SAM xử lý đặc biệt đối với danh mục `home`, ngăn chặn các lệnh chuyển ứng dụng trực tiếp từ một ứng dụng có phiên làm việc media/audio độc quyền (như YouTube) sang Lumen.
3. **Hiện tượng "bão lệnh launch" (Launch Storm) từ `watch.sh`:**
   - Trong `tools/tv/watch.sh`, logic phát hiện TV thức giấc dựa trên điều kiện `[ "$gap" -gt 5 ] && woke=1` (nếu khoảng cách giữa 2 chu kỳ kiểm tra lớn hơn 5 giây thì coi như TV vừa bật từ chế độ nghỉ).
   - Khi YouTube tải video nặng hoặc giải mã 4K, CPU TV bị chiếm dụng khiến vòng lặp của `watch.sh` bị trễ quá 5 giây. `watch.sh` tưởng nhầm TV vừa bật nên kích hoạt cửa sổ "wake recovery" kéo dài 30 giây.
   - Trong suốt 30 giây này, cứ mỗi 0.5 giây `watch.sh` lại gọi hàm `wake_open()`. Vì `wake_open()` chạy ngầm `( luna-send ... ) &` mà không có giới hạn tần suất (debounce), nó đã dội liên tục hơn **20 lệnh launch/giây** vào SAM và `WebAppMgr`. Quá tải hàng đợi IPC khiến luồng renderer của Lumen bị kẹt cứng ở trạng thái `Dl` (Disk sleep) của nhân Linux.
4. **`watch.sh` thiếu định danh `com.webos.app.fullhome`:**
   - Trên webOS 5, giao diện Home mặc định của LG mang ID `com.webos.app.fullhome` (thay vì chỉ `com.webos.app.home`). Khi `watch.sh` không nhận diện được ID này, việc hoán đổi giao diện khi ấn Home không hoạt động chính xác.

### Cách xử lý triệt để
1. **Chuẩn hóa `appinfo.json` cho webOS 5:**
   - Loại bỏ hoàn toàn các thuộc tính `handlesRelaunch`, `defaultWindowType`, và `appCategory: ["home"]` khỏi `app/public/appinfo.json`. Để SAM quản lý vòng đời cửa sổ chuẩn theo cơ chế web app thông thường của webOS 5.
2. **Kích hoạt cờ `/var/lib/homehook/no-wake-launch`:**
   - Tạo file cờ rỗng `/var/lib/homehook/no-wake-launch` trên TV để tắt bỏ hoàn toàn vòng lặp ép launch dồn dập khi TV thức giấc.
3. **Bổ sung Debounce và hỗ trợ webOS 5 cho `tools/tv/watch.sh`:**
   - Thêm biến `wakelast` để giới hạn tần suất gọi `wake_open()`, đảm bảo giữa 2 lần gọi tối thiểu phải cách nhau 3 giây.
   - Bổ sung pattern `*'"appId":"com.webos.app.fullhome"'*` vào khối case xử lý chiếm quyền Home của LG.