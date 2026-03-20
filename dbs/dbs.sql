-- Tạo Database
CREATE DATABASE IF NOT EXISTS ott_community_db;
USE ott_community_db;

-- 1. Bảng Users
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    phone_number VARCHAR(20) UNIQUE,
    display_name VARCHAR(100) NOT NULL,
    avatar_url VARCHAR(255),
    status ENUM('online', 'offline') DEFAULT 'offline',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Bảng Relationships (Kết bạn)
CREATE TABLE relationships (
    id INT AUTO_INCREMENT PRIMARY KEY,
    requester_id INT NOT NULL,
    recipient_id INT NOT NULL,
    status ENUM('pending', 'accepted', 'blocked') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_relationship (requester_id, recipient_id)
);

-- 3. Bảng Groups
CREATE TABLE `groups` (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    avatar_url VARCHAR(255),
    type ENUM('private_group', 'public_community') DEFAULT 'public_community',
    join_setting VARCHAR(50),
    member_count INT DEFAULT 1,
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- 4. Bảng Group Members
CREATE TABLE group_members (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_id INT NOT NULL,
    user_id INT NOT NULL,
    role ENUM('owner', 'admin', 'member') DEFAULT 'member',
    status ENUM('active', 'muted', 'banned') DEFAULT 'active',
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_group_member (group_id, user_id)
);

-- 5. Bảng Direct Chats (Chat 1-1)
CREATE TABLE direct_chats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    last_message_id INT NULL, 
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Bảng trung gian lưu 2 người tham gia Chat 1-1
CREATE TABLE direct_chat_participants (
    direct_chat_id INT NOT NULL,
    user_id INT NOT NULL,
    PRIMARY KEY (direct_chat_id, user_id),
    FOREIGN KEY (direct_chat_id) REFERENCES direct_chats(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 6. Bảng Channels (Các kênh trong Group)
CREATE TABLE channels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    type ENUM('text_chat', 'voice_room') DEFAULT 'text_chat',
    last_message_id INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE
);

-- 7. Bảng Messages (Tâm điểm của OTT)
CREATE TABLE messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sender_id INT NOT NULL,
    channel_id INT DEFAULT NULL,
    direct_chat_id INT DEFAULT NULL,
    type ENUM('text', 'image', 'video', 'document', 'system') DEFAULT 'text',
    content TEXT,
    attachments JSON, -- Lưu mảng các file đính kèm
    reactions JSON, -- Lưu mảng cảm xúc (icon)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY (direct_chat_id) REFERENCES direct_chats(id) ON DELETE CASCADE
);

-- Cập nhật Khóa ngoại cho last_message_id sau khi đã tạo bảng Messages
ALTER TABLE direct_chats ADD FOREIGN KEY (last_message_id) REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE channels ADD FOREIGN KEY (last_message_id) REFERENCES messages(id) ON DELETE SET NULL;

-- 8. Bảng User Read Receipts (Trạng thái đã đọc)
CREATE TABLE user_read_receipts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    channel_id INT DEFAULT NULL,
    direct_chat_id INT DEFAULT NULL,
    last_read_message_id INT,
    unread_count INT DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY (direct_chat_id) REFERENCES direct_chats(id) ON DELETE CASCADE,
    FOREIGN KEY (last_read_message_id) REFERENCES messages(id) ON DELETE SET NULL
);

-- 9. Bảng Calls
CREATE TABLE calls (
    id INT AUTO_INCREMENT PRIMARY KEY,
    caller_id INT NOT NULL,
    channel_id INT DEFAULT NULL,
    direct_chat_id INT DEFAULT NULL,
    call_type ENUM('audio', 'video') NOT NULL,
    status ENUM('ongoing', 'ended', 'missed') DEFAULT 'ongoing',
    participants JSON, 
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP NULL,
    FOREIGN KEY (caller_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY (direct_chat_id) REFERENCES direct_chats(id) ON DELETE CASCADE
);

-- 10. Bảng Group Stats (Thống kê)
CREATE TABLE group_stats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_id INT NOT NULL,
    `date` DATE NOT NULL,
    total_messages INT DEFAULT 0,
    active_members_count INT DEFAULT 0,
    media_shared_count INT DEFAULT 0,
    FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE
);

-- Thêm Users
INSERT INTO users (username, password_hash, email, display_name, status) VALUES 
('thien_nguyen', 'hashed_pw_1', 'thien@example.com', 'Thiện Nguyễn', 'online'),
('tuan_anh', 'hashed_pw_2', 'tuananh@example.com', 'Tuấn Anh', 'offline'),
('hoang_nam', 'hashed_pw_3', 'nam@example.com', 'Hoàng Nam', 'online');

-- Kết bạn (Thiện và Tuấn Anh)
INSERT INTO relationships (requester_id, recipient_id, status) VALUES 
(1, 2, 'accepted');

-- Tạo Group "Kho tài liệu IT"
INSERT INTO `groups` (name, description, type, created_by) VALUES 
('Kho tài liệu Công nghệ', 'Nơi chia sẻ slide, bài giảng, và tài liệu học tập', 'public_community', 1);

-- Thêm thành viên vào Group
INSERT INTO group_members (group_id, user_id, role) VALUES 
(1, 1, 'owner'),
(1, 2, 'admin'),
(1, 3, 'member');

-- Tạo 2 Channel trong Group (1 text, 1 voice)
INSERT INTO channels (group_id, name, type) VALUES 
(1, 'tai-lieu-mon-hoc', 'text_chat'),
(1, 'thao-luan-nhom', 'voice_room');

-- Tạo 1 phiên Direct Chat (Chat 1-1 giữa Thiện và Nam)
INSERT INTO direct_chats (updated_at) VALUES (NOW());
INSERT INTO direct_chat_participants (direct_chat_id, user_id) VALUES 
(1, 1), (1, 3);

-- Chèn Messages
-- 1. Tin nhắn trong Group (Chia sẻ tài liệu)
INSERT INTO messages (sender_id, channel_id, type, content, attachments) VALUES 
(1, 1, 'document', 'Mình gửi slide bài giảng hôm nay nhé.', 
'[{"file_name": "Slide_Kien_Truc_PM.pdf", "url": "https://s3.aws.com/.../slide.pdf", "size": 2048}]');

-- 2. Tin nhắn trong Chat 1-1
INSERT INTO messages (sender_id, direct_chat_id, type, content, reactions) VALUES 
(3, 1, 'text', 'Thiện ơi check hộ mình đoạn code Node.js này với', 
'[{"user_id": 1, "emoji": "👍"}]');

-- Cập nhật last_message_id cho Channel và Direct Chat
UPDATE channels SET last_message_id = 1 WHERE id = 1;
UPDATE direct_chats SET last_message_id = 2 WHERE id = 1;