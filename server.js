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
const os = require('os');

const app = express();
const adminApp = express();
const server = http.createServer(app);
const adminServer = http.createServer(adminApp);

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
            mediaSrc: ["'self'"], // 允許播放自己網站的音效檔案
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

// [Security 6] 音效發送頻率限制
const soundRateLimiter = new RateLimiterMemory({
    keyPrefix: 'sound_limit',
    points: 1,   // 每個連線每 1 秒最多 1 次音效
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

// Hell Pool 相關
const userReports = new Map(); // ipHash -> { reporters: Set<string>, timestamp: number }
const hellPool = new Map(); // ipHash -> { expiry: number, successfulChats: number }

// Admin / Metrics Tracking 相關
let mpsCounter = 0;
let currentMps = 0;
setInterval(() => { currentMps = mpsCounter; mpsCounter = 0; }, 1000);

const recentDurations = []; // 存最後100筆對話(毫秒)
const recentReports = []; // 存最後50筆檢舉
const instantLeaves = new Map(); // ipHash -> [ timestamps ]
const redFlags = new Set(); // ipHash
const permaBans = new Set(); // ipHash
let isEmergencyStop = false;
let idleTimeoutHours = 12;

const getIpHash = (socket) => {
    // 嚴格使用 Cloudflare 提供的真實 IP，如果沒有才退回一般 IP
    const rawIp = socket.handshake.headers['cf-connecting-ip'] || socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || socket.id;
    // 取出逗號分隔的第一個 IP，以防 x-forwarded-for 是個 list
    const ip = rawIp.split(',')[0].trim();
    return crypto.createHash('sha256').update(ip).digest('hex');
};

// 讓 Express 提供 Vite build 出來的靜態檔案，並開啟強快取機制讓瀏覽器快取媒體資源
app.use(express.static(path.join(__dirname, 'frontend/dist'), { maxAge: '365d' }));

// =========== 輔助函式區 ===========
const saveChatLog = (roomId, room) => {
    if (!room || !room.messages || room.messages.length === 0) return;

    // 每天獨立產生一個 Log 檔案
    const dateStr = new Date().toISOString().split('T')[0];
    const logFilePath = path.join(__dirname, `chat_logs_${dateStr}.txt`);
    const logData = `=== 房間 ID: ${roomId} ===\n結束時間: ${new Date().toLocaleString()}\n` +
        room.messages.map(m => `[${new Date(m.timestamp).toLocaleTimeString()}] 使用者 ${m.senderId.slice(0, 6)}...: ${m.message}`).join('\n') +
        `\n===================================\n\n`;

    fs.appendFile(logFilePath, logData, (err) => {
        if (err) console.error('儲存對話紀錄失敗:', err);
    });
};

const handleRoomClose = (roomId) => {
    const room = roomMap.get(roomId);
    if (!room) return;

    // Hell Pool 解除機制：審查對話是否大於 3 分鐘且沒有被檢舉
    const chatDuration = Date.now() - room.createdAt;

    // 更新指標: 平均時間
    recentDurations.push(chatDuration);
    if (recentDurations.length > 100) recentDurations.shift();

    room.users.forEach(uid => {
        const u = userMap.get(uid);
        if (u && u.socket) {
            const uIpHash = getIpHash(u.socket);

            // 異常行為偵測: 秒退 (<10秒)
            if (chatDuration < 10000 && !room.isReported) {
                let leaves = instantLeaves.get(uIpHash) || [];
                // 清理5分鐘前的紀錄
                leaves = leaves.filter(t => Date.now() - t < 5 * 60 * 1000);
                leaves.push(Date.now());
                instantLeaves.set(uIpHash, leaves);

                // 如果5分鐘內秒退20次，貼上紅區標籤
                if (leaves.length >= 20) {
                    redFlags.add(uIpHash);
                }
            }

            const hData = hellPool.get(uIpHash);
            if (hData && Date.now() <= hData.expiry) {
                if (room.isReported) {
                    hData.successfulChats = 0; // 若有人檢舉，連續次數歸零
                } else if (chatDuration >= 3 * 60 * 1000) {
                    hData.successfulChats = (hData.successfulChats || 0) + 1;
                    if (hData.successfulChats >= 5) {
                        hellPool.delete(uIpHash); // 重獲自由！
                    }
                }
            }
        }
    });

    saveChatLog(roomId, room);

    // 清除使用者房間狀態
    room.users.forEach(uid => {
        const u = userMap.get(uid);
        if (u) {
            u.roomId = null;
            if (u.socket) {
                u.socket.leave(roomId);
                u.socket.roomId = null;
            }
        }
    });
    roomMap.delete(roomId);
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
        // [Security Admin] Global Emergency Stop Check
        if (isEmergencyStop) {
            socket.emit('error', '系統維護中，暫時停止新配對。已在聊天的用戶不受影響。');
            return;
        }

        // [Security 5] 配對頻率限制: 使用更直接的 Date.now() 阻擋，冷卻 2 秒
        const ipHashForLimit = getIpHash(socket);

        // 黑名單阻擋
        if (permaBans.has(ipHashForLimit)) {
            socket.emit('error', '您的連線已被系統永久封鎖。');
            return;
        }
        let userLimit = userMap.get(ipHashForLimit); // 我們直接用 ipHash 存一個輕量的時間紀錄
        if (!userLimit) {
            userLimit = { lastMatchTime: 0 };
            userMap.set(ipHashForLimit, userLimit);
        }

        const now = Date.now();
        if (now - userLimit.lastMatchTime < 2000) {
            socket.emit('error', '配對請求過於頻繁，請稍後再試。');
            return;
        }
        userLimit.lastMatchTime = now;

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

        const ipHash = getIpHash(socket);
        const hellData = hellPool.get(ipHash);

        let queueKey = keyword ? keyword.trim().toLowerCase() : 'general';
        if (hellData) {
            if (Date.now() > hellData.expiry) {
                hellPool.delete(ipHash);
            } else {
                queueKey = `hell_${queueKey}`; // 丟進地獄池隔離對列
            }
        }

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
                    lastActivity: Date.now(),
                    createdAt: Date.now(),
                    isReported: false
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

                // 更新 MPS (Messages Per Second) 計算器
                mpsCounter++;

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

    socket.on('play_sound', async (soundFile) => {
        try {
            await soundRateLimiter.consume(socket.id);
            // 將播放音效的事件廣播給同房間的另一人
            if (socket.roomId && typeof soundFile === 'string') {
                socket.to(socket.roomId).emit('play_sound', soundFile);
            }
        } catch (rejRes) {
            // 超出頻率限制，忽略
        }
    });

    socket.on('play_ambient', (track) => {
        if (socket.roomId && (typeof track === 'string' || track === null)) {
            socket.to(socket.roomId).emit('play_ambient', track);
        }
    });

    socket.on('report_user', () => {
        if (socket.roomId) {
            const room = roomMap.get(socket.roomId);
            if (room) {
                room.isReported = true;
                const reporterIpHash = getIpHash(socket);

                const partnerId = [...room.users].find(id => id !== socket.userId);
                if (partnerId) {
                    const partnerUser = userMap.get(partnerId);
                    if (partnerUser && partnerUser.socket) {
                        const partnerIpHash = getIpHash(partnerUser.socket);

                        let reports = userReports.get(partnerIpHash);
                        if (!reports) {
                            reports = { reporters: new Set(), timestamp: Date.now() };
                            userReports.set(partnerIpHash, reports);
                        }

                        if (Date.now() - reports.timestamp > 24 * 60 * 60 * 1000) {
                            reports.reporters.clear();
                            reports.timestamp = Date.now();
                        }

                        reports.reporters.add(reporterIpHash);

                        // 超過 7 個不同 IP 檢舉，關進地獄池 2 小時
                        if (reports.reporters.size >= 7) {
                            hellPool.set(partnerIpHash, {
                                expiry: Date.now() + 2 * 60 * 60 * 1000,
                                successfulChats: 0
                            });
                            reports.reporters.clear(); // 避免重複觸發
                        }

                        // 記錄到 admin feed
                        recentReports.unshift({
                            time: Date.now(),
                            reporterHash: reporterIpHash.slice(0, 8),
                            targetHash: partnerIpHash,
                            reason: 'User Feedback'
                        });
                        if (recentReports.length > 50) recentReports.pop();
                    }
                }
            }
        }
    });

    socket.on('leave_chat', () => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner_disconnected', { message: '對方已離開對話。' });
            handleRoomClose(socket.roomId);
            socket.roomId = null;
        }
        // 從等待佇列移除
        if (socket.userId) {
            for (const [key, queue] of waitingQueue.entries()) {
                const newQueue = queue.filter(id => id !== socket.userId);
                waitingQueue.set(key, newQueue);
            }
            // 使用者主動離開，完全清除其狀態，不留緩衝避免幽靈現象
            userMap.delete(socket.userId);
        }
    });

    socket.on('disconnect', () => {
        if (socket.userId) {
            const user = userMap.get(socket.userId);
            if (user) {
                user.socket = null; // Mark as disconnected

                // 如果根本沒在房間裡 (只是在大廳或排隊)，斷線 10 秒後直接清理，不要佔用記憶體 12 小時
                const isIdle = !user.roomId;
                const timeoutMs = isIdle ? 10 * 1000 : idleTimeoutHours * 60 * 60 * 1000;

                user.timer = setTimeout(() => {
                    if (user.roomId) {
                        const roomId = user.roomId;
                        io.to(roomId).emit('partner_disconnected', { message: '對方已閒置過久，對話結束。' });
                        handleRoomClose(roomId);
                    }
                    userMap.delete(socket.userId);
                    // 清理 Queue
                    for (const [key, queue] of waitingQueue.entries()) {
                        waitingQueue.set(key, queue.filter(id => id !== socket.userId));
                    }
                }, timeoutMs);
            }
        }
    });
});

// 處理前端路由(SPA)，讓 React Router 運作
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend/dist', 'index.html'));
});

// =========== Admin 本地管理伺服器 (Port 3002) ===========
adminApp.use(express.static(path.join(__dirname, 'admin')));

// 監控數據 API
adminApp.get('/api/metrics', (req, res) => {
    let waitingTotal = 0;
    for (const queue of waitingQueue.values()) waitingTotal += queue.length;

    const avgDuration = recentDurations.length ? Math.round(recentDurations.reduce((a, b) => a + b, 0) / recentDurations.length / 1000) : 0;
    const cpuAvg = os.loadavg()[0].toFixed(2);
    const ramUsage = Math.round(process.memoryUsage().rss / 1024 / 1024); // MB

    const chattingTotal = roomMap.size * 2;
    const activeUsers = chattingTotal + waitingTotal;

    res.json({
        health: {
            cpu: `${cpuAvg}% (Load)`,
            ram: `${ramUsage} MB`,
            mps: currentMps
        },
        quality: {
            avgChatDurationSeconds: avgDuration,
            usersConnected: activeUsers,
            usersWaiting: waitingTotal,
            orphanRatio: activeUsers ? ((waitingTotal / activeUsers) * 100).toFixed(1) + '%' : '0%'
        },
        moderation: {
            recentReports: recentReports,
            hellPoolUsers: Array.from(hellPool.keys()),
            redFlags: Array.from(redFlags.keys()),
            permaBans: Array.from(permaBans.keys())
        },
        controls: {
            isEmergencyStop,
            idleTimeoutHours
        }
    });
});

// 管理操作 API
adminApp.use(express.json());

adminApp.post('/api/control', (req, res) => {
    const { action, ipHash, value } = req.body;

    if (action === 'emergency_stop') {
        isEmergencyStop = !isEmergencyStop;
    } else if (action === 'unban') { // 特赦
        hellPool.delete(ipHash);
        redFlags.delete(ipHash);
        permaBans.delete(ipHash);
        userReports.delete(ipHash);
    } else if (action === 'permaban') { // 永久制裁
        permaBans.add(ipHash);
        hellPool.delete(ipHash);
        redFlags.delete(ipHash);

        // 把目標踢下線
        for (const [uid, u] of userMap.entries()) {
            if (u.socket && getIpHash(u.socket) === ipHash) {
                u.socket.emit('error', '您的連線已被系統永久封鎖。');
                u.socket.disconnect(true);
            }
        }
    } else if (action === 'set_timeout') {
        idleTimeoutHours = Number(value) || 12;
    }

    res.json({ success: true, action, target: ipHash || 'system' });
});

// ===========================================

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Anonymous chat server running on port ${PORT}`);
});

// 管理伺服器僅限於 localhost 監聽，保護不被外部存取
adminServer.listen(3002, '127.0.0.1', () => {
    console.log(`Admin server running locally on http://127.0.0.1:3002`);
});
