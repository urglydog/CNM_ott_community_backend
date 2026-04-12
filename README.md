# OTT Community Backend

Backend phục vụ ứng dụng OTT Community, được xây dựng trên Node.js, Express và Socket.io. Hệ thống sử dụng kiến trúc mô-đun (Modular Architecture) để dễ dàng mở rộng và bảo trì.

## 🚀 Công nghệ sử dụng

- **Runtime**: Node.js
- **Framework**: Express.js
- **Real-time**: Socket.io (Hỗ trợ Chat, Call, Presence)
- **Database**: 
  - **DynamoDB**: Lưu trữ Users, Messages, Groups, Channels, Friendships.
  - **MySQL**: (Tùy chọn) Phục vụ các dữ liệu quan hệ phức tạp.
  - **Redis**: Quản lý trạng thái Presence (Online/Offline) và Caching.
- **Storage**: AWS S3 (Lưu trữ Media/Files).
- **Auth**: JWT (AccessToken & RefreshToken).

## 📂 Cấu trúc dự án

Dự án được tổ chức theo mô hình mô-đun:

```text
├── /src
│   ├── /modules
│   │   ├── /auth          # Đăng ký, đăng nhập, JWT, Refresh Token
│   │   ├── /users         # Quản lý Profile, Danh bạ (Friends), Tìm kiếm
│   │   ├── /chat          # Tin nhắn, Nhóm (Groups), Kênh (Channels), Call (Zego)
│   │   ├── /presence      # Trạng thái Online/Offline (Real-time)
│   │   └── /media         # Xử lý Upload Media qua S3 Presigned URL
│   ├── /common            # Middlewares & Utils dùng chung (JWT, Auth Check)
│   ├── /config            # Cấu hình AWS, Redis, Database
│   ├── /socket            # Logic xử lý WebSocket tập trung (socketHandler)
│   └── app.js             # Entry point của Server
├── /uploads               # Thư mục lưu trữ file tạm thời
├── .env                  # Biến môi trường
└── docker-compose.yml     # Chạy MySQL & Redis nhanh chóng
```

## 🛠 Cài đặt & Chạy dự án

### 1. Cài đặt Dependencies
```bash
npm install
```

### 2. Cấu hình Biến môi trường
Tạo file `.env` từ các thông tin cần thiết:
- `PORT`: Cổng chạy server (mặc định 4000).
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`: Cấu hình AWS.
- `JWT_SECRET`, `JWT_REFRESH_SECRET`: Khóa bảo mật JWT.
- `MYSQL_HOST`, `REDIS_HOST`, v.v.

### 3. Khởi chạy Infrastructure (Docker)
Để chạy MySQL và Redis nhanh chóng:
```bash
docker-compose up -d
```

### 4. Chạy Server
**Chế độ Development (với nodemon):**
```bash
npm run dev
```

**Chế độ Production:**
```bash
npm start
```

## 📡 API Endpoints (Sơ lược)

### Auth
- `POST /api/auth/register`: Đăng ký tài khoản.
- `POST /api/auth/login`: Đăng nhập.
- `POST /api/auth/refresh`: Làm mới token.

### Users & Friends
- `GET /api/users/me`: Lấy thông tin cá nhân.
- `GET /api/friends`: Lấy danh sách bạn bè.
- `POST /api/friends/request`: Gửi lời mời kết bạn.

### Chat & Media
- `GET /api/messages/conversations/:id`: Lấy lịch sử tin nhắn.
- `POST /api/uploads/presigned-url`: Lấy URL upload ảnh/video.

## 🔌 Socket Events

Server sử dụng Socket.io để xử lý các sự kiện thời gian thực:
- `join_room`: Tham gia phòng chat.
- `send_message`: Gửi tin nhắn real-time.
- `typing_start` / `typing_stop`: Hiệu ứng đang soạn tin.
- `call-request` / `call-accepted`: Xử lý tín hiệu cuộc gọi.

---
© 2024 OTT Community Team
