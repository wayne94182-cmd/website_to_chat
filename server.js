const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const crypto = require('crypto');
const xss = require('xss'); // 後端二次 XSS 防護

const app = express();
const server = http.createServer(app);

// 初始化 Socket.io
const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:3000",
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

// =========== 核心邏輯區 ===========

const waitingQueue = new Map();
const userMap = new Map();
const roomMap = new Map();

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
            }
        } else {
            userMap.set(userId, { socket: socket, roomId: null, timer: null });
        }
    });

    socket.on('join_queue', (data) => {
        const { keyword, userId } = data;
        if (!userId) return;

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
                roomMap.set(roomId, new Set([userId, partnerId]));

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
            await socketRateLimiter.consume(socket.id);
            if (socket.roomId) {
                const cleanMessage = xss(data.message);
                socket.to(socket.roomId).emit('receive_message', {
                    messageId: data.messageId,
                    senderId: socket.userId,
                    message: cleanMessage,
                    timestamp: new Date()
                });
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
            const users = roomMap.get(socket.roomId);
            if (users) {
                users.forEach(uid => {
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
                // 設定一個斷線寬限期 (15秒)，防止使用者只是重新整理
                user.timer = setTimeout(() => {
                    if (user.roomId) {
                        const roomId = user.roomId;
                        io.to(roomId).emit('partner_disconnected', { message: '對方已斷線離開。' });
                        const users = roomMap.get(roomId);
                        if (users) {
                            users.forEach(uid => {
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
                }, 15000); // 15 seconds
            }
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Anonymous chat server running on port ${PORT}`);
});
