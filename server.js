const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const crypto = require('crypto');
const xss = require('xss'); // 後端二次 XSS 防護
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// 初始化 Socket.io
const io = new Server(server, {
    cors: {
        // [Security 6] 嚴格限制 Origin 防禦 CSWSH (跨站 WebSocket 劫持)
        // 為了讓你在區網內可以用手機測試，我們在開發環境下把它改成允許所有來源 '*'
        origin: process.env.NODE_ENV === 'production'
            ? ["https://your-domain.com"] // 正式環境請換成你未來的網域
            : "*", // 開發環境允許區網其他裝置連線
        methods: ["GET", "POST"]
    }
});

// =========== 資安實作區 ===========

// [Security 4] Content Security Policy (CSP)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"], // 若有獨立打包，建議移除 unsafe-inline
            styleSrc: ["'self'", "'unsafe-inline'"],
            connectSrc: ["'self'", "wss:", "ws:", "http://localhost:3000"], // 允許 WSS 連線
            imgSrc: ["'self'", "data:"],
        },
    },
}));

// [Security 2: REST API] Rate Limiting
const httpRateLimiter = new RateLimiterMemory({
    keyPrefix: 'http_limit',
    points: 10,  // 每秒最多 10 個請求
    duration: 1, // 1秒
});

app.use((req, res, next) => {
    // [Security 3] 隱私保護: 將 IP 進行 Hash 後存入 Rate Limiter，不直接保存本機真實 IP
    const ipHash = crypto.createHash('sha256').update(req.ip).digest('hex');
    httpRateLimiter.consume(ipHash)
        .then(() => next())
        .catch(() => res.status(429).send('Too Many Requests'));
});

// [Security 2: Socket.io] 訊息發送頻率限制
const socketRateLimiter = new RateLimiterMemory({
    keyPrefix: 'socket_msg_limit',
    points: 5,   // 每個連線每秒最多 5 則訊息
    duration: 1,
});

// [Security 5] 配對頻率限制 (防殭屍連線轟炸)
const matchRateLimiter = new RateLimiterMemory({
    keyPrefix: 'match_limit',
    points: 30,  // 一分鐘內最多 30 次配對請求
    duration: 60,
});

// =========== 核心邏輯區 ===========

const waitingQueue = new Map();
const userMap = new Map();
const roomMap = new Map();

// 讓 Express 提供 Vite build 出來的靜態檔案
app.use(express.static(path.join(__dirname, 'frontend/dist')));

// =========== 輔助函式區 ===========
const saveChatLog = (roomId, room) => {
    if (!room || !room.messages || room.messages.length === 0) return;

    // 儲存成最極簡的純文字格式，方便你未來利用
    const logFilePath = path.join(__dirname, 'chat_logs.txt');
    const logData = `=== 房間 ID: ${roomId} ===\n結束時間: ${new Date().toLocaleString()}\n` +
        room.messages.map(m => `[${new Date(m.timestamp).toLocaleTimeString()}] 使用者 ${m.senderId.slice(0, 6)}...: ${m.message}`).join('\n') +
        `\n===================================\n\n`;

    fs.appendFile(logFilePath, logData, (err) => {
        // 不阻斷主執行緒
        if (err) console.error('儲存對話紀錄失敗:', err);
    });
};

io.on('connection', (socket) => {
    // 註冊與狀態還原
    socket.on('register', (userId) => {
        socket.userId = userId;
        const user = userMap.get(userId);
        if (user) {
            if (user.timer) {
                clearTimeout(user.timer);
                user.timer = null;
            }
            user.socket = socket;
            if (user.roomId) {
                socket.roomId = user.roomId;
                socket.join(user.roomId);
                socket.emit('matched', { roomId: user.roomId, reconnected: true });
                // 若房間有歷史紀錄，可以送過去
                const room = roomMap.get(user.roomId);
                if (room && room.messages) {
                    socket.emit('chat_history', room.messages);
                }
            }
        } else {
            userMap.set(userId, { socket: socket, roomId: null, timer: null });
        }
    });

    // 處理重連已存在房間的邏輯 (Silent Reconnect)
    socket.on('rejoin_room', (data) => {
        const { userId, roomId } = data;
        const room = roomMap.get(roomId);
        if (room && room.users.has(userId)) {
            socket.userId = userId;
            socket.roomId = roomId;
            socket.join(roomId);

            let user = userMap.get(userId);
            if (!user) {
                user = { socket: socket, roomId: roomId, timer: null };
                userMap.set(userId, user);
            } else {
                user.socket = socket;
                if (user.timer) {
                    clearTimeout(user.timer);
                    user.timer = null;
                }
            }
            socket.emit('matched', { roomId, reconnected: true });

            // 將歷史紀錄送給前端
            if (room.messages) {
                socket.emit('chat_history', room.messages);
            }
        } else {
            // 房間可能已經被清掉
            socket.emit('rejoin_failed');
        }
    });

    socket.on('join_queue', async (data) => {
        try {
            await matchRateLimiter.consume(socket.handshake.address || socket.id);
        } catch (rejRes) {
            socket.emit('error', '配對請求過於頻繁，請稍後再試。');
            return;
        }

        if (!data || typeof data !== 'object') return;
        const { keyword, userId } = data;
        if (!userId || typeof userId !== 'string') return;
        if (keyword !== undefined && typeof keyword !== 'string') return;

        socket.userId = userId;
        let user = userMap.get(userId);
        if (!user) {
            user = { socket: socket, roomId: null, timer: null };
            userMap.set(userId, user);
        } else {
            user.socket = socket;
        }

        const queueKey = keyword ? keyword.trim().toLowerCase() : 'general';
        let queue = waitingQueue.get(queueKey) || [];

        // 避免重複加入
        queue = queue.filter(id => id !== userId);

        if (queue.length > 0) {
            const partnerId = queue.shift();
            waitingQueue.set(queueKey, queue);

            const partner = userMap.get(partnerId);
            if (partner && partner.socket) {
                const roomId = uuidv4();
                roomMap.set(roomId, {
                    users: new Set([userId, partnerId]),
                    messages: [],
                    lastActivity: Date.now()
                });

                user.roomId = roomId;
                partner.roomId = roomId;

                socket.join(roomId);
                partner.socket.join(roomId);

                socket.roomId = roomId;
                partner.socket.roomId = roomId;

                io.to(roomId).emit('matched', { roomId, message: '配對成功，可以開始聊天了！' });
            } else {
                queue.push(userId);
                waitingQueue.set(queueKey, queue);
                socket.emit('waiting', { message: '尋找配對中...' });
            }
        } else {
            queue.push(userId);
            waitingQueue.set(queueKey, queue);
            socket.emit('waiting', { message: '尋找配對中...' });
        }
    });

    socket.on('send_message', async (data) => {
        try {
            if (!data || typeof data !== 'object') return;
            if (typeof data.message !== 'string') return;
            if (typeof data.messageId !== 'string') return;

            // 嚴格限制長度，超過 500 字直接砍掉，加上刪節號
            if (data.message.length > 500) {
                data.message = data.message.substring(0, 500) + '... (訊息過長已截斷)';
            }

            await socketRateLimiter.consume(socket.id);
            if (socket.roomId) {
                const cleanMessage = xss(data.message);
                const msgData = {
                    messageId: data.messageId,
                    senderId: socket.userId,
                    message: cleanMessage,
                    timestamp: new Date()
                };

                // 將訊息存入房間紀錄 (保留最後 50 筆)
                const room = roomMap.get(socket.roomId);
                if (room) {
                    room.messages.push(msgData);
                    if (room.messages.length > 50) room.messages.shift();
                    room.lastActivity = Date.now();
                }

                socket.to(socket.roomId).emit('receive_message', msgData);
            }
        } catch (rejRes) {
            socket.emit('error', '發言頻率過高，請稍後再試。');
        }
    });

    socket.on('typing', () => {
        if (socket.roomId) socket.to(socket.roomId).emit('partner_typing');
    });

    socket.on('mark_read', (messageId) => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('message_read', messageId);
        }
    });

    socket.on('leave_chat', () => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner_disconnected', { message: '對方已離開對話。' });
            const room = roomMap.get(socket.roomId);
            if (room) saveChatLog(socket.roomId, room);
            if (room && room.users) {
                room.users.forEach(uid => {
                    const u = userMap.get(uid);
                    if (u) {
                        u.roomId = null;
                        if (u.socket) {
                            u.socket.leave(socket.roomId);
                            u.socket.roomId = null;
                        }
                    }
                });
            }
            roomMap.delete(socket.roomId);
        }
        // 從等待佇列移除
        if (socket.userId) {
            for (const [key, queue] of waitingQueue.entries()) {
                const newQueue = queue.filter(id => id !== socket.userId);
                waitingQueue.set(key, newQueue);
            }
        }
    });

    socket.on('disconnect', () => {
        if (socket.userId) {
            const user = userMap.get(socket.userId);
            if (user) {
                user.socket = null; // Mark as disconnected
                // 設定一個斷線寬限期 (30 分鐘)，保留房間讓使用者有充裕時間重連
                user.timer = setTimeout(() => {
                    if (user.roomId) {
                        const roomId = user.roomId;
                        const room = roomMap.get(roomId);
                        io.to(roomId).emit('partner_disconnected', { message: '對方已閒置過久，對話結束。' });
                        if (room) saveChatLog(roomId, room);
                        if (room && room.users) {
                            room.users.forEach(uid => {
                                const u = userMap.get(uid);
                                if (u) {
                                    u.roomId = null;
                                    if (u.socket) u.socket.roomId = null;
                                }
                            });
                        }
                        roomMap.delete(roomId);
                    }
                    userMap.delete(socket.userId);
                    // 清理 Queue
                    for (const [key, queue] of waitingQueue.entries()) {
                        waitingQueue.set(key, queue.filter(id => id !== socket.userId));
                    }
                }, 30 * 60 * 1000); // 30 minutes
            }
        }
    });
});

// 處理前端路由(SPA)，讓 React Router 運作
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend/dist', 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Anonymous chat server running on port ${PORT}`);
});
