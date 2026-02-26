import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import DOMPurify from 'dompurify';
import { v4 as uuidv4 } from 'uuid';
import { FiMonitor, FiMoon, FiMap, FiMusic, FiVolume2, FiSettings } from 'react-icons/fi';
import { FaBullhorn } from 'react-icons/fa';

// 自動偵測後端網址：
// 如果有設定 VITE_BACKEND_URL 就用該網址，否則抓取當前網頁的 IP/域名 並指向 port 3001
const getBackendUrl = () => {
  if (import.meta.env.VITE_BACKEND_URL) return import.meta.env.VITE_BACKEND_URL;
  // 如果是透過 Vite (通常 port 是 3000 或 5173 等等)
  if (window.location.port !== '3001' && window.location.port !== '') {
    return `${window.location.protocol}//${window.location.hostname}:3001`;
  }
  return window.location.origin;
};

const socket = io(getBackendUrl(), {
  transports: ['websocket', 'polling']
});

const activeAudios = new Set();

function App() {
  "use no memo";

  // 生成並存入 localStorage (關閉分頁後依然有效)
  const [sessionId] = useState(() => {
    let storedId = localStorage.getItem('chat_session_id');
    if (!storedId) {
      storedId = uuidv4();
      localStorage.setItem('chat_session_id', storedId);
    }
    return storedId;
  });

  const [appState, setAppState] = useState(() => localStorage.getItem('chat_app_state') || 'idle');
  const [keyword, setKeyword] = useState('');
  const [showTagsPanel, setShowTagsPanel] = useState(false);
  const [showCustomKeyword, setShowCustomKeyword] = useState(false);
  const [messages, setMessages] = useState(() => {
    const saved = localStorage.getItem('chat_messages');
    return saved ? JSON.parse(saved) : [];
  });

  const [inputMessage, setInputMessage] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const [showTosModal, setShowTosModal] = useState(false);
  const [showSoundboard, setShowSoundboard] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [soundVolume, setSoundVolume] = useState(0.5);
  const [ambientVolume, setAmbientVolume] = useState(0.5);
  const [currentTheme, setCurrentTheme] = useState(() => localStorage.getItem('chat_theme') || 'modern');
  const [currentAmbient, setCurrentAmbient] = useState(null); // '海島.ogg', '火車.ogg', 等

  const lastSoundTimeRef = useRef(0);
  const typingTimeoutRef = useRef(null);
  const messagesEndRef = useRef(null);
  const chatContainerRef = useRef(null);
  const ambientAudioRef = useRef(null);
  const soundVolumeRef = useRef(soundVolume);
  const ambientVolumeRef = useRef(ambientVolume);

  useEffect(() => {
    soundVolumeRef.current = soundVolume;
    activeAudios.forEach(audio => {
      audio.volume = soundVolume;
    });
  }, [soundVolume]);

  useEffect(() => {
    ambientVolumeRef.current = ambientVolume;
    if (ambientAudioRef.current) {
      ambientAudioRef.current.volume = ambientVolume;
    }
  }, [ambientVolume]);

  // 初始化環境音效物件
  useEffect(() => {
    ambientAudioRef.current = new Audio();
    ambientAudioRef.current.loop = true;
    return () => {
      ambientAudioRef.current.pause();
      ambientAudioRef.current = null;
    };
  }, []);

  // 當環境音軌或音量改變時更新播放器
  useEffect(() => {
    if (ambientAudioRef.current) {
      ambientAudioRef.current.volume = ambientVolume;
      if (currentAmbient) {
        // 若目前的 src 不同再更換
        if (!ambientAudioRef.current.src.endsWith(encodeURIComponent(currentAmbient))) {
          ambientAudioRef.current.src = `/ambient/${currentAmbient}`;
          ambientAudioRef.current.play().catch(e => console.warn("環境音播放失敗", e));
        } else {
          ambientAudioRef.current.play().catch(e => console.warn("環境音播放失敗", e));
        }
      } else {
        ambientAudioRef.current.pause();
      }
    }
  }, [currentAmbient, ambientVolume]);

  const changeAmbient = (track) => {
    setCurrentAmbient(track);
    if (appState === 'matched') {
      socket.emit('play_ambient', track); // 同步給對方
    }
  };

  const changeTheme = useCallback((theme) => {
    setCurrentTheme(theme);
    localStorage.setItem('chat_theme', theme);
  }, []);

  // Play sound function
  const playSound = useCallback((soundFile, broadcast = true) => {
    if (broadcast) {
      const now = Date.now();
      if (now - lastSoundTimeRef.current < 1000) {
        alert("音效傳送每次需間隔 1 秒喔！");
        return;
      }
      lastSoundTimeRef.current = now;
    }

    const audio = new Audio(`/media/${soundFile}`);
    audio.volume = soundVolumeRef.current;

    activeAudios.add(audio);
    audio.onended = () => activeAudios.delete(audio);

    audio.play().catch(e => {
      console.warn("音效播放失敗:", e);
      activeAudios.delete(audio);
    });
    if (broadcast && appState === 'matched') {
      socket.emit('play_sound', soundFile);

      const cleanName = soundFile.split('/').pop().replace(/\.[^/.]+$/, "");
      const safeMessage = `[播放了音效：${cleanName}]`;
      const messageId = uuidv4();
      socket.emit('send_message', { messageId, message: safeMessage });
      setMessages((prev) => [...prev, {
        id: messageId,
        message: safeMessage,
        isMine: true,
        isRead: false,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp: Date.now()
      }]);
    }
  }, [appState]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping, appState, scrollToBottom]);

  // 狀態同步至 Local Storage，讓重整後可以保留畫面和訊息
  useEffect(() => {
    localStorage.setItem('chat_app_state', appState);
  }, [appState]);

  // 非配對時自動停止播放環境音
  useEffect(() => {
    if (appState === 'idle') {
      setCurrentAmbient(null);
    }
  }, [appState]);

  useEffect(() => {
    localStorage.setItem('chat_messages', JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    // 檢查是否有上一次的房間 ID
    const storedRoomId = localStorage.getItem('chat_room_id');
    if (storedRoomId && appState === 'matched') {
      socket.emit('rejoin_room', { userId: sessionId, roomId: storedRoomId });
    } else {
      socket.emit('register', sessionId);
    }

    socket.on('waiting', () => setAppState('waiting'));

    socket.on('matched', (data) => {
      setAppState('matched');
      if (data.roomId) {
        localStorage.setItem('chat_room_id', data.roomId);
      }
      if (!data.reconnected) {
        setMessages([]);
      }
    });

    socket.on('chat_history', (historyMessages) => {
      // 伺服器傳回最後幾筆歷史紀錄，與本地紀錄結合或覆蓋
      if (historyMessages && historyMessages.length > 0) {
        setMessages(
          historyMessages.map(msg => ({
            id: msg.messageId,
            message: msg.message,
            isMine: msg.senderId === sessionId,
            time: new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            timestamp: new Date(msg.timestamp).getTime()
          }))
        );
      }
    });

    socket.on('rejoin_failed', () => {
      setAppState('idle');
      setMessages([]);
      localStorage.removeItem('chat_room_id');
      localStorage.removeItem('chat_messages');
      alert('房間已過期或失效，請重新尋找配對。');
    });

    socket.on('receive_message', (data) => {
      const safeMessage = DOMPurify.sanitize(data.message);

      setMessages((prev) => [...prev, {
        id: data.messageId,
        message: safeMessage,
        isMine: false,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp: Date.now()
      }]);
      setIsTyping(false);

      if (document.hasFocus()) {
        socket.emit('mark_read', data.messageId);
      }

      const audio = new Audio('/鈴聲.MP3');
      audio.volume = soundVolumeRef.current;
      activeAudios.add(audio);
      audio.onended = () => activeAudios.delete(audio);
      audio.play().catch(e => {
        console.warn("訊息音效播放失敗:", e);
        activeAudios.delete(audio);
      });
    });

    socket.on('message_read', (messageId) => {
      setMessages((prev) => {
        const targetIndex = prev.findIndex(m => m.id === messageId);
        if (targetIndex === -1) return prev;
        return prev.map((msg, index) =>
          (index <= targetIndex && msg.isMine) ? { ...msg, isRead: true } : msg
        );
      });
    });

    socket.on('partner_typing', () => {
      setIsTyping(true);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => setIsTyping(false), 2000);
    });

    socket.on('partner_disconnected', (data) => {
      setAppState('idle');
      setMessages([]);
      alert(data.message || '對方已離開對話');
    });

    socket.on('play_sound', (soundFile) => {
      const audio = new Audio(`/media/${soundFile}`);
      audio.volume = soundVolumeRef.current;
      activeAudios.add(audio);
      audio.onended = () => activeAudios.delete(audio);
      audio.play().catch(e => {
        console.warn("音效播放失敗:", e);
        activeAudios.delete(audio);
      });
    });

    socket.on('play_ambient', (track) => {
      setCurrentAmbient(track);
    });

    socket.on('error', (msg) => alert(msg));

    return () => {
      socket.off('waiting');
      socket.off('matched');
      socket.off('receive_message');
      socket.off('message_read');
      socket.off('partner_typing');
      socket.off('partner_disconnected');
      socket.off('play_sound');
      socket.off('play_ambient');
      socket.off('error');
      socket.off('chat_history');
      socket.off('rejoin_failed');
    };
  }, [sessionId, appState]);

  useEffect(() => {
    const handleFocus = () => {
      if (appState === 'matched') {
        const lastPartnerMsg = [...messages].reverse().find(m => !m.isMine);
        if (lastPartnerMsg) {
          socket.emit('mark_read', lastPartnerMsg.id);
        }
      }
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [appState, messages]);

  const handleStart = (mode) => {
    let searchKeyword = '';
    if (typeof mode === 'string') {
      searchKeyword = mode;
      setKeyword(mode); // 同步到顯示字串中
    } else if (mode === true) {
      searchKeyword = keyword;
    }
    socket.emit('join_queue', { keyword: searchKeyword, userId: sessionId });
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (!inputMessage.trim()) return;

    const safeMessage = DOMPurify.sanitize(inputMessage);
    const messageId = uuidv4();

    socket.emit('send_message', { messageId, message: safeMessage });

    setMessages((prev) => [...prev, {
      id: messageId,
      message: safeMessage,
      isMine: true,
      isRead: false,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      timestamp: Date.now()
    }]);
    setInputMessage('');
  };

  const handleTyping = (e) => {
    setInputMessage(e.target.value);
    socket.emit('typing');
  };

  const handleLeave = () => {
    setShowLeaveModal(true);
  };

  const confirmLeave = () => {
    socket.emit('leave_chat');
    setAppState('idle');
    setMessages([]);
    localStorage.removeItem('chat_room_id');
    setShowLeaveModal(false);
  };

  const handleReport = () => {
    socket.emit('report_user');
    alert('感謝您的回報，我們會盡快審查該使用者的行為。');
    confirmLeave();
  };

  // 主題樣式設定
  // 主題樣式設定
  const themeStyles = {
    modern: {
      bgClass: "bg-gradient-to-br from-[#c4e0e5] via-[#e5d4de] to-[#efa18b]",
      bgImage: null,
      chatBgClass: "bg-gradient-to-br from-[#c8e3e7] via-[#e5d4de] to-[#f4aaaa]",
      startBtn: "bg-white/40 hover:bg-white/60 backdrop-blur-xl border border-white/70 shadow-[0_4px_24px_rgba(255,255,255,0.4)] text-black font-extrabold select-none",
      keywordBtn: "bg-white/90 text-gray-800 rounded-[20px] font-bold shadow-md hover:bg-white active:scale-95 transition-all text-black",
      textInputBg: "bg-white/50 backdrop-blur-xl border border-white/70 focus:border-white shadow-inner text-gray-800 placeholder-gray-500",
      myMsg: "bg-gradient-to-r from-[#efa18b]/90 to-[#f4aaaa]/90 backdrop-blur-md text-white border border-white/40 shadow-lg",
      partnerMsg: "bg-white/60 backdrop-blur-lg text-gray-800 border border-white/60 shadow-lg",
      bottomBar: "bg-white/30 backdrop-blur-2xl border-t border-white/50 shadow-[0_-10px_30px_rgba(255,255,255,0.3)]",
      textColor: "text-gray-800",
      idleBoxBg: "bg-white/40 backdrop-blur-2xl border border-white/70 shadow-[0_8px_32px_rgba(255,255,255,0.4)]",
      titleColor: "text-white drop-shadow-md shadow-black/50"
    },
    woodland: {
      bgClass: "bg-cover bg-center bg-fixed bg-[#fcf8f2]",
      bgImage: "url('/bg_wood_new.png')",
      chatBgClass: "bg-cover bg-center bg-fixed bg-[#fcf8f2]",
      startBtn: "bg-[url('/button/木質.jpg')] bg-[length:200%] bg-center border-none !shadow-[4px_6px_0px_#2c1a0e] active:translate-y-1 active:translate-x-1 active:!shadow-none text-[#1f1207] text-xl font-extrabold select-none transition-all duration-75 !rounded-[12px] uppercase tracking-wider drop-shadow-[0_1px_2px_rgba(255,255,255,0.4)]",
      keywordBtn: "bg-[url('/button/木頭2.jpg')] bg-[length:200%] bg-center border-none !shadow-[4px_6px_0px_#2c1a0e] active:translate-y-1 active:translate-x-1 active:!shadow-none text-[#1f1207] font-extrabold transition-all duration-75 !rounded-[12px] drop-shadow-[0_1px_2px_rgba(255,255,255,0.4)]",
      textInputBg: "bg-[#4a3018]/90 backdrop-blur-sm border-2 border-[#2c1a0e] focus:border-[#d5a069] text-[#f4e4c1] placeholder-[#d5a069] shadow-[inset_2px_4px_10px_rgba(0,0,0,0.6)]",
      myMsg: "bg-[url('/button/木質.jpg')] bg-[length:200%] bg-center border-b-4 border-r-2 border-t border-l border-[#3a200d] text-[#1f1207] shadow-[2px_3px_5px_rgba(0,0,0,0.4)] font-bold rounded-[12px]",
      partnerMsg: "bg-[url('/button/木頭2.jpg')] bg-[length:200%] bg-center border-b-4 border-r-2 border-t border-l border-[#3a200d] text-[#1f1207] shadow-[2px_3px_5px_rgba(0,0,0,0.4)] font-bold rounded-[12px]",
      bottomBar: "bg-[#2c1e14]/90 backdrop-blur-xl border-t border-[#1a0f0a] shadow-[0_-5px_20px_rgba(0,0,0,0.8)]",
      textColor: "text-[#3e1d04] drop-shadow-[0_1px_1px_rgba(255,255,255,0.5)]",
      idleBoxBg: "bg-[#4a3018]/80 backdrop-blur-md border-2 border-[#2c1a0e] shadow-[8px_12px_0px_#2c1a0e] rounded-[15px]",
      titleColor: "text-[#2c1205] drop-shadow-[0_2px_2px_rgba(255,248,220,0.7)]"
    },
    night_room: {
      bgClass: "bg-cover bg-center bg-fixed bg-[#0f111a]",
      bgImage: "url('/style_bakcground/bg_night_room_1772101191995.png')",
      chatBgClass: "bg-cover bg-center bg-fixed bg-[#0f111a]",
      startBtn: "bg-gradient-to-br from-[#8ba3c7] to-[#5c7399] border border-[#a9c2e6]/50 shadow-[0_10px_25px_rgba(0,0,0,0.4),inset_0_2px_10px_rgba(255,255,255,0.3)] active:shadow-[inset_0_15px_25px_rgba(0,0,0,0.6)] active:scale-[0.98] text-white text-xl font-bold select-none transition-all duration-200 rounded-[35px]",
      keywordBtn: "bg-gradient-to-br from-[#8ba3c7] to-[#5c7399] border border-[#a9c2e6]/50 shadow-[0_5px_15px_rgba(0,0,0,0.4),inset_0_2px_8px_rgba(255,255,255,0.3)] active:shadow-[inset_0_12px_20px_rgba(0,0,0,0.6)] active:scale-[0.98] text-white font-bold transition-all duration-200 rounded-[30px]",
      textInputBg: "bg-[rgba(30,41,59,0.7)] backdrop-blur-[10px] border border-white/10 focus:border-[#CBD5E1] text-[#E2E8F0] placeholder-[#CBD5E1]/50 shadow-inner rounded-[25px]",
      myMsg: "bg-[rgba(30,41,59,0.6)] backdrop-blur-[10px] text-[#E2E8F0] border border-white/10 shadow-[0_4px_15px_rgba(0,0,0,0.3)] rounded-[20px]",
      partnerMsg: "bg-[rgba(30,41,59,0.6)] backdrop-blur-[10px] text-[#CBD5E1] border border-white/10 shadow-[0_4px_15px_rgba(0,0,0,0.3)] rounded-[20px]",
      bottomBar: "bg-[rgba(15,20,30,0.7)] backdrop-blur-[15px] border-t border-white/5 shadow-[0_-10px_30px_rgba(0,0,0,0.5)]",
      textColor: "text-[#E2E8F0]",
      idleBoxBg: "bg-[rgba(30,41,59,0.8)] backdrop-blur-[10px] border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.5)] rounded-[35px]",
      titleColor: "text-white drop-shadow-lg"
    }
  };

  const currentSettings = themeStyles[currentTheme] || themeStyles.modern;

  if (appState === 'idle' || appState === 'waiting') {
    return (
      <div className={`flex flex-col h-[100dvh] w-full ${currentSettings.bgClass} items-center justify-center p-6 font-sans overflow-hidden transition-colors duration-700`} style={{ backgroundImage: currentSettings.bgImage }}>
        {/* Settings Button */}
        <div className="absolute top-6 right-6 z-50">
          <button onClick={() => setShowSettings(!showSettings)} className={`p-3 rounded-full bg-black/20 hover:bg-black/30 backdrop-blur-md text-white transition-all ${showSettings ? 'rotate-90' : ''}`}>
            <FiSettings size={20} />
          </button>

          {showSettings && (
            <div className="absolute top-14 right-0 w-64 bg-white/10 backdrop-blur-xl border border-white/20 rounded-2xl p-4 shadow-2xl animate-in slide-in-from-top-2">
              <h3 className="text-white/90 text-sm font-bold border-b border-white/20 pb-2 mb-3">設定</h3>

              {/* Theme Selection */}
              <div className="mb-4">
                <p className="text-white/70 text-xs mb-2">背景風格</p>
                <div className="flex justify-between gap-2">
                  <button onClick={() => changeTheme('modern')} className={`flex-1 py-2 flex justify-center items-center rounded-lg transition-colors ${currentTheme === 'modern' ? 'bg-white/30 border border-white/50' : 'bg-white/10 hover:bg-white/20 border border-transparent'} text-white`} title="現代風格"><FiMonitor /></button>
                  <button onClick={() => changeTheme('woodland')} className={`flex-1 py-2 flex justify-center items-center rounded-lg transition-colors ${currentTheme === 'woodland' ? 'bg-[#8c5e3c]/50 border border-[#a67c52]' : 'bg-white/10 hover:bg-white/20 border border-transparent'} text-white`} title="木質森林"><FiMap /></button>
                  <button onClick={() => changeTheme('night_room')} className={`flex-1 py-2 flex justify-center items-center rounded-lg transition-colors ${currentTheme === 'night_room' ? 'bg-[#6c5ce7]/50 border border-[#8c7cf7]' : 'bg-white/10 hover:bg-white/20 border border-transparent'} text-white`} title="絨毛夜色"><FiMoon /></button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* TITLE & LOGO */}
        <h1 className={`text-4xl font-extrabold ${currentSettings.titleColor} mb-2`}>Secret Chat</h1>
        <p className={`${currentSettings.titleColor} opacity-90 font-medium mb-10 text-lg`}>
          {appState === 'waiting' ? '尋找緣分中...' : '隨機遇見世界上的另一個人'}
        </p>

        {appState === 'idle' && (
          <div className={`w-full max-w-sm flex flex-col space-y-4 p-6 rounded-3xl ${currentSettings.idleBoxBg}`}>
            <button
              onClick={() => handleStart(false)}
              className={`w-full py-4 rounded-[20px] shadow-lg text-lg ${currentSettings.startBtn}`}
            >
              開始隨機配對
            </button>
            <div className="relative flex items-center py-2">
              <div className="flex-grow border-t border-white/30"></div>
              <span className={`flex-shrink-0 mx-4 ${currentSettings.textColor} font-medium text-sm opacity-80`}>或者是</span>
              <div className="flex-grow border-t border-white/30"></div>
            </div>
            <div className="flex flex-col space-y-3">
              {!showTagsPanel ? (
                <button
                  onClick={() => setShowTagsPanel(true)}
                  className={`w-full py-4 rounded-[20px] shadow-md ${currentSettings.keywordBtn}`}
                >
                  依主題 / 暗號尋找
                </button>
              ) : !showCustomKeyword ? (
                <div className="flex flex-wrap gap-2 justify-center animate-in fade-in slide-in-from-top-2 duration-300">
                  {['純聊天', '線上陪讀', '深夜睡不著', '聽我抱怨', '感情解惑', '學生專區', '上班偷薪水', '聊聊 MBTI / 星座'].map((tag) => (
                    <button
                      key={tag}
                      onClick={() => handleStart(tag)}
                      className={`px-3 py-1.5 rounded-full text-sm font-bold shadow-sm active:scale-95 transition-all ${currentSettings.keywordBtn}`}
                    >
                      {tag}
                    </button>
                  ))}
                  <button
                    onClick={() => setShowCustomKeyword(true)}
                    className={`px-3 py-1.5 rounded-full text-sm font-bold shadow-sm active:scale-95 transition-all outline outline-1 outline-offset-[-1px] opacity-80 hover:opacity-100 ${currentSettings.keywordBtn}`}
                  >
                    其他 (自訂)
                  </button>
                </div>
              ) : (
                <>
                  <input
                    type="text"
                    placeholder="輸入自訂暗號"
                    className={`w-full px-5 py-4 rounded-[20px] focus:outline-none transition-all shadow-sm ${currentSettings.textInputBg}`}
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleStart(true)}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowCustomKeyword(false)}
                      className={`w-1/3 py-4 rounded-[20px] shadow-sm font-bold opacity-80 hover:opacity-100 transition-all ${currentSettings.textColor}`}
                    >
                      返回
                    </button>
                    <button
                      onClick={() => handleStart(true)}
                      className={`w-2/3 py-4 rounded-[20px] shadow-md ${currentSettings.keywordBtn}`}
                    >
                      依自訂尋找
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* TOS LINK */}
            <div className="pt-2 text-center">
              <button
                onClick={() => setShowTosModal(true)}
                className={`text-sm ${currentSettings.textColor} opacity-60 hover:opacity-100 underline underline-offset-4 transition-colors`}
              >
                服務條款與授權協議
              </button>
            </div>
          </div>
        )}

        {/* TOS MODAL */}
        {showTosModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md">
            <div className={`w-full max-w-2xl max-h-[80vh] flex flex-col rounded-3xl overflow-hidden shadow-2xl ${currentSettings.bgClass === "bg-gradient-to-br from-[#c4e0e5] via-[#e5d4de] to-[#efa18b]" ? "bg-white" : "bg-[#2c1e14] text-[#f4e4c1]"}`}>

              <div className="p-6 border-b border-gray-500/30 flex justify-between items-center bg-black/10">
                <h2 className="text-xl font-bold flex items-center gap-2"><FaBullhorn className="text-red-500" /> myanonchat.xyz 服務條款與使用者授權協議</h2>
                <button onClick={() => setShowTosModal(false)} className="text-3xl leading-none opacity-60 hover:opacity-100 transition-opacity">&times;</button>
              </div>

              <div className="p-6 overflow-y-auto space-y-4 text-sm leading-relaxed" style={{ WebkitOverflowScrolling: 'touch' }}>
                <p><strong>生效日期：</strong>2026年2月</p>
                <p>歡迎您蒞臨 myanonchat.xyz（以下簡稱「本平台」或「我們」）。本服務條款與使用者授權協議（以下簡稱「本協議」）係構成您與本平台之間具法律約束力之契約。為保障您的權益，請於開始使用本平台提供之任何服務（包含但不限於網頁瀏覽、文字通訊、音效發送等）前，詳細閱讀本協議之所有內容。</p>
                <p>當您點擊同意、進入配對大廳或實質開始使用本平台之功能時，即推定您已充分理解並無條件接受本協議之所有規範。若您對本協議有任何異議，請立即停止存取本平台。未成年使用者須在法定代理人或監護人之陪同下審閱本協議，並於取得其同意後方得使用本平台。</p>

                <h3 className="text-lg font-bold mt-4 mb-2 border-l-4 border-red-500 pl-2">第一條：隱私保護與資訊安全管理</h3>
                <p>本平台致力於提供一個低壓力的交流環境，並對資訊安全抱持嚴謹之態度。</p>
                <ul className="list-disc pl-5 space-y-2 opacity-90">
                  <li><strong>資料蒐集與管理：</strong> 針對使用者於本平台產生之互動軌跡及連線資訊（包含但不限於 IP 位址、作業系統類型、瀏覽器特徵碼及裝置識別數據），我們將採取嚴格且適當之安全管理措施進行妥善處理，以確保系統架構之穩定性與服務品質。</li>
                  <li><strong>平台秩序維護：</strong> 雖本平台標榜匿名交流，然為防堵網路犯罪、抵禦惡意程式濫用並保障整體社群之福祉，當系統安全防護機制偵測到異常連線，或接獲其他使用者提出具體檢舉時，本平台管理團隊獲授權依法調閱、審查相關之伺服器通訊紀錄，以釐清事實並採取必要之處置。</li>
                </ul>

                <h3 className="text-lg font-bold mt-4 mb-2 border-l-4 border-red-500 pl-2">第二條：服務存取限制與禁止從事之行為</h3>
                <p>為維持本平台之正常運作與全體使用者之安全，您承諾並保證於使用本平台時，絕不從事下列任何明示禁止之行為。若有違反，本平台有權立即終止您對服務之存取權：</p>
                <ul className="list-disc pl-5 space-y-2 opacity-90">
                  <li><strong>系統干擾與破壞：</strong> 嚴禁利用網路蜘蛛（Spiders）、網路爬蟲（Crawlers）、機器人（Bots）或其他自動化腳本及軟體，未經授權擷取本平台數據；亦不得策動阻斷服務攻擊（DDoS）或以任何形式造成本平台伺服器負載超載、功能受損。</li>
                  <li><strong>散布惡意程式：</strong> 嚴禁上傳、傳輸或散布任何含有軟體病毒、木馬程式或其他足以破壞、干擾電腦軟硬體運作之惡意程式碼。</li>
                  <li><strong>未經授權之商業行為：</strong> 禁止利用本平台從事任何未經官方事前核准之商業宣傳、垃圾訊息（Spam）發送，或進行金字塔式傳銷（老鼠會）、非法多層次傳銷等活動。</li>
                  <li><strong>不當內容與侵權：</strong> 嚴禁發表、傳送涉及仇恨言論、恐嚇、霸凌、性騷擾、露骨色情、煽動暴力或具有血腥暴力傾向之文字與多媒體內容。</li>
                  <li><strong>違法與詐欺行為：</strong> 嚴禁使用本平台從事任何違反當地法令之行為，包含但不限於金融犯罪、信用卡盜刷、銀行帳戶詐騙或散布虛假誤導性之資訊。</li>
                </ul>

                <h3 className="text-lg font-bold mt-4 mb-2 border-l-4 border-red-500 pl-2">第三條：違規制裁與法律追訴</h3>
                <p>若我們合理懷疑或經查證您有違反上述「第二條」規定之情事，本平台得在不另行通知之情況下，逕行採取下列一項或多項管理措施：</p>
                <ul className="list-disc pl-5 space-y-2 opacity-90">
                  <li>實施流量限制或影子封鎖（Shadowban），使您的通訊內容無法被其他正常使用者讀取。</li>
                  <li>將您的連線特徵列入系統黑名單或隔離配對池。</li>
                  <li>若您的行為涉及刑事犯罪或造成本平台及第三方之重大損害，我們將主動通報該管警察機關與司法單位，並依法追究民事損害賠償責任。</li>
                </ul>

                <h3 className="text-lg font-bold mt-4 mb-2 border-l-4 border-red-500 pl-2">第四條：免責聲明與風險承擔</h3>
                <ul className="list-disc pl-5 space-y-2 opacity-90">
                  <li><strong>系統穩定性風險：</strong> 本平台之服務係以「現況（As Is）」提供。鑑於網際網路環境之不可預測性，本平台不保證服務絕對不會出現中斷、延遲或故障。如因不可抗力、硬體設備異常，或遭受駭客攻擊等外力入侵而導致服務停擺、連線中斷或資料流失，本平台概不負擔任何形式之賠償或補償責任。</li>
                  <li><strong>人際互動風險：</strong> 本平台僅提供即時通訊之技術架構，無法實質控制或擔保其他使用者之真實身分、言論真實性及行為動機。您應自行對與陌生人之互動風險保持警覺。若因使用本平台而導致您遭受精神上之不適、名譽受損或其他經濟與非經濟上之損失，本平台依法免除一切連帶責任。</li>
                </ul>

                <h3 className="text-lg font-bold mt-4 mb-2 border-l-4 border-red-500 pl-2">第五條：條款之修訂與生效</h3>
                <p>本平台保留隨時修改、增刪本協議內容之權利。修訂後之條款將直接更新於本頁面，恕不個別另行通知。您於條款修改後繼續使用本平台，即視為您已充分閱讀並同意接受修改後之規範。</p>
              </div>

              <div className="p-4 border-t border-gray-500/30 bg-black/5 flex justify-end">
                <button
                  onClick={() => setShowTosModal(false)}
                  className="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-lg transition-colors"
                >
                  我同意並了解
                </button>
              </div>
            </div>
          </div>
        )}

        {appState === 'waiting' && (
          <div className="flex flex-col items-center">
            <div className="w-12 h-12 border-4 border-white border-t-transparent rounded-full animate-spin mb-6 shadow-sm"></div>
            <button onClick={() => { socket.emit('leave_chat'); setAppState('idle'); }} className={`${currentSettings.textColor} opacity-80 hover:opacity-100 underline underline-offset-4 transition-colors`}>取消配對</button>
          </div>
        )}
      </div>
    );
  }

  // 聊天室主體 
  return (
    <div className={`flex flex-col h-[100dvh] w-full items-center ${currentSettings.chatBgClass} font-sans overflow-hidden transition-colors duration-700`} style={{ backgroundImage: currentSettings.bgImage }}>

      {/* Top Setting Menu (also visible in chat) */}
      <div className="absolute top-4 right-4 z-40">
        <button onClick={() => setShowSettings(!showSettings)} className={`p-2.5 rounded-full bg-black/20 hover:bg-black/30 backdrop-blur-md text-white transition-all ${showSettings ? 'rotate-90' : ''}`}>
          <FiSettings size={18} />
        </button>

        {showSettings && (
          <div className="absolute top-12 right-0 w-[280px] bg-black/60 backdrop-blur-2xl border border-white/10 rounded-2xl p-4 shadow-2xl animate-in slide-in-from-top-2">

            {/* Theme Selection */}
            <div className="mb-5">
              <p className="text-white/70 text-xs mb-2">背景風格</p>
              <div className="flex justify-between gap-2">
                <button onClick={() => changeTheme('modern')} className={`flex-1 py-1.5 flex justify-center items-center rounded-lg transition-colors ${currentTheme === 'modern' ? 'bg-white/30 border border-white/50' : 'bg-white/10 hover:bg-white/20 border border-transparent'} text-white`} title="現代風格"><FiMonitor /></button>
                <button onClick={() => changeTheme('woodland')} className={`flex-1 py-1.5 flex justify-center items-center rounded-lg transition-colors ${currentTheme === 'woodland' ? 'bg-[#8c5e3c]/50 border border-[#a67c52]' : 'bg-white/10 hover:bg-white/20 border border-transparent'} text-white`} title="木質森林"><FiMap /></button>
                <button onClick={() => changeTheme('night_room')} className={`flex-1 py-1.5 flex justify-center items-center rounded-lg transition-colors ${currentTheme === 'night_room' ? 'bg-[#6c5ce7]/50 border border-[#8c7cf7]' : 'bg-white/10 hover:bg-white/20 border border-transparent'} text-white`} title="絨毛夜色"><FiMoon /></button>
              </div>
            </div>

            {/* Ambient Music */}
            <div className="mb-2">
              <div className="flex items-center justify-between mb-2">
                <p className="text-white/70 text-xs flex items-center gap-1"><FiMusic /> 環境白噪音 (雙方同步)</p>
                {currentAmbient && <button onClick={() => changeAmbient(null)} className="text-[10px] bg-red-500/80 hover:bg-red-500 text-white px-2 py-0.5 rounded-full">關閉</button>}
              </div>

              {/* Music Volume (Local) */}
              <div className="flex items-center gap-2 mb-3">
                <FiVolume2 className="text-white/60" size={12} />
                <input
                  type="range" min="0" max="1" step="0.05"
                  value={ambientVolume}
                  onChange={(e) => setAmbientVolume(parseFloat(e.target.value))}
                  className="w-full h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                {['海島.ogg', '火車.ogg', '營火.ogg', '雨聲.ogg'].map(music => (
                  <button
                    key={music}
                    onClick={() => changeAmbient(music)}
                    className={`text-xs py-1.5 rounded-md border ${currentAmbient === music ? 'bg-white/30 border-white text-white font-bold' : 'bg-white/5 hover:bg-white/10 border-transparent text-white/80'} transition-all`}
                  >
                    {music.replace('.ogg', '')}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="w-full flex items-center justify-between p-4 fixed top-0 left-0 z-30 pointer-events-none">
        <div className="relative pointer-events-auto">
          <div className={`h-8 w-8 cursor-pointer ${currentTheme === 'woodland' ? 'text-[#3e1d04] drop-shadow-[0_1px_1px_rgba(255,255,255,0.5)]' : 'text-[#6366f1]'}`} onClick={() => setIsMenuOpen(!isMenuOpen)} title="選單">
            <svg fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd"></path></svg>
          </div>

          {isMenuOpen && (
            <div className="absolute top-10 left-0 mt-2 w-64 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg border border-gray-100 overflow-hidden z-50">
              <div className="flex flex-col text-gray-700 text-[15px] font-medium">
                <button className="px-5 py-3 text-left hover:bg-gray-50 active:bg-gray-100 transition-colors border-b border-gray-100" onClick={() => { alert('為維護社群品質，若發現違規行為，我們將會處理您的檢舉。'); setIsMenuOpen(false); }}>檢舉</button>
                <div className="px-5 py-3 text-left border-b border-gray-100 text-sm text-gray-500 leading-relaxed">問題回報與廣告聯絡：<br /><span className="text-[#6366f1] select-all">wayne9487087@gmail.com</span></div>
                <button className="px-5 py-3 text-left text-red-500 hover:bg-red-50 active:bg-red-100 transition-colors font-bold" onClick={() => { setIsMenuOpen(false); handleLeave(); }}>離開對話</button>
              </div>
            </div>
          )}
        </div>


      </div>

      {showLeaveModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl flex flex-col space-y-4 animate-in fade-in zoom-in duration-200">
            <h3 className="text-xl font-bold text-gray-800">離開對話</h3>
            <p className="text-gray-600 text-sm">確定要離開目前的對話嗎？如果您遇到不當行為，您可以回報這名使用者。</p>
            <div className="flex flex-col space-y-2 pt-2">
              <button onClick={confirmLeave} className="w-full py-3 bg-[#6366f1] text-white rounded-xl font-bold hover:bg-[#4f46e5] active:scale-95 transition-all">確認離開</button>
              <button onClick={handleReport} className="w-full py-3 bg-red-500 text-white rounded-xl font-bold hover:bg-red-600 active:scale-95 transition-all">離開並檢舉該使用者</button>
              <button onClick={() => setShowLeaveModal(false)} className="w-full py-3 bg-gray-100 text-gray-700 rounded-xl font-bold hover:bg-gray-200 active:scale-95 transition-all">取消</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .hide-scroll::-webkit-scrollbar {
          display: none;
        }
        .hide-scroll {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>

      <div
        ref={chatContainerRef}
        className="flex-1 overflow-y-auto w-full max-w-2xl px-4 pt-16 pb-6 flex flex-col space-y-1.5 hide-scroll"
      >
        <div className="flex justify-center mb-6 mt-2">
          <span className={`text-xs ${currentSettings.textColor} font-medium tracking-wide`}>已配對成功，對方已加入對話</span>
        </div>

        {messages.map((msg, i) => {
          const isNextSame = i < messages.length - 1 && messages[i + 1].isMine === msg.isMine;

          return (
            <div key={i} className={`flex w-full ${msg.isMine ? 'justify-end' : 'justify-start'} ${isNextSame ? 'mb-0.5' : 'mb-3'}`}>

              {!msg.isMine && (
                <div className="flex items-end max-w-[75%] group">
                  <div className={`relative px-4 py-2.5 shadow-sm z-10 
                    ${isNextSame ? 'rounded-[20px] rounded-bl-sm' : 'rounded-[20px]'}
                    ${currentSettings.partnerMsg}
                  `}>
                    <span className="break-words whitespace-pre-wrap text-[15px] leading-relaxed block">{msg.message}</span>
                  </div>
                  <span className={`text-[10px] ${currentSettings.textColor} ml-2 mb-1 shrink-0 font-bold select-none`}>{msg.time}</span>
                </div>
              )}

              {msg.isMine && (
                <div className="flex items-end max-w-[75%] group">
                  <div className="flex flex-col items-end mr-2 mb-1 shrink-0 select-none">
                    {msg.isRead && <span className={`text-[10px] ${currentSettings.textColor} font-extrabold mb-0.5 scale-95 origin-right`}>已讀</span>}
                    <span className={`text-[10px] ${currentSettings.textColor} font-bold`}>{msg.time}</span>
                  </div>
                  <div className={`relative px-4 py-2.5 shadow-sm z-10
                    ${isNextSame ? 'rounded-[20px] rounded-br-sm' : 'rounded-[20px]'}
                    ${currentSettings.myMsg}
                  `}>
                    <span className="break-words whitespace-pre-wrap text-[15px] leading-relaxed block">{msg.message}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {isTyping && (
          <div className="flex justify-start mb-3 items-center gap-2">
            <span className={`text-[12px] font-bold opacity-80 ${currentSettings.textColor}`}>對方正在輸入...</span>
            <div className={`px-3 py-2.5 rounded-2xl rounded-bl-sm shadow-sm flex items-center gap-1.5 justify-center min-w-[3rem] ${currentSettings.partnerMsg.split(" ").filter(c => !c.includes("bg-[url")).join(" ")} bg-black/10`}>
              <span className={`w-1.5 h-1.5 rounded-full animate-bounce ${currentSettings.textColor} bg-current`} style={{ animationDelay: '0ms' }}></span>
              <span className={`w-1.5 h-1.5 rounded-full animate-bounce ${currentSettings.textColor} bg-current`} style={{ animationDelay: '150ms' }}></span>
              <span className={`w-1.5 h-1.5 rounded-full animate-bounce ${currentSettings.textColor} bg-current`} style={{ animationDelay: '300ms' }}></span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} className="h-4 shrink-0" />
      </div>

      <form onSubmit={handleSendMessage} className={`px-4 py-3 pb-8 sm:pb-4 w-full flex gap-3 shrink-0 z-20 items-center justify-between ${currentSettings.bottomBar}`}>

        <button
          type="button"
          onClick={handleLeave}
          className={`shrink-0 font-bold text-[15px] px-2 py-2 rounded-lg transition-colors ${currentSettings.textColor} hover:bg-white/10 active:bg-white/20`}
        >
          離開
        </button>

        <div className="flex-1 flex items-center bg-transparent relative">
          <input
            type="text"
            value={inputMessage}
            onChange={handleTyping}
            maxLength={500}
            className={`w-full rounded-full px-4 py-2 text-[15px] focus:outline-none transition-colors ${currentSettings.textInputBg}`}
            placeholder="輸入訊息..."
          />
        </div>

        {/* Soundboard Button & Menu */}
        <div className="relative flex items-center shrink-0 mr-1">
          <button
            type="button"
            onClick={() => setShowSoundboard(!showSoundboard)}
            className={`p-2 rounded-full transition-colors focus:outline-none ${currentSettings.textColor} hover:bg-white/10 active:bg-white/20`}
            title="音效板"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"></path></svg>
          </button>

          {showSoundboard && (
            <div className="absolute bottom-full right-0 mb-3 w-[300px] bg-black/60 backdrop-blur-2xl rounded-2xl shadow-2xl border border-white/10 overflow-hidden z-50 p-4 max-h-[60vh] overflow-y-auto animate-in slide-in-from-bottom-2">

              {/* Volume Control */}
              <div className="flex items-center gap-2 mb-4 px-1">
                <span className="text-xs font-bold text-[#e0e0e0] shrink-0">音量</span>
                <input
                  type="range"
                  min="0" max="1" step="0.05"
                  value={soundVolume}
                  onChange={(e) => setSoundVolume(parseFloat(e.target.value))}
                  className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-[#6366f1]"
                />
              </div>

              {/* General Sounds */}
              <h4 className="text-xs font-bold text-[#e0e0e0] mb-2 px-1 flex items-center gap-1">🎵 一般音效</h4>
              <div className="flex flex-wrap gap-1.5 mb-4">
                {['Laughing_Dog.mp3', 'SUS.mp3', 'SUS_heavy.mp3', 'wtdd.MP3', '八嘎壓怒.MP3', '歪比八卜.MP3', '比比拉布.MP3', '派大星.MP3', '羊.mp3'].map((file) => (
                  <button key={file} type="button" onClick={() => playSound(file)} className="bg-white/10 hover:bg-white/20 active:bg-white/30 text-white border border-white/10 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors shadow-sm">{file.replace(/\.[^/.]+$/, "")}</button>
                ))}
              </div>

              {/* Cat Sounds */}
              <h4 className="text-xs font-bold text-[#e0e0e0] mb-2 px-1 flex items-center gap-1">🐱 貓咪系列</h4>
              <div className="flex flex-wrap gap-1.5">
                {['88boy.MP3', '哭.mp3', '啊？.MP3', '尖叫.mp3', '德語貓.mp3', '狂笑.mp3', '笑.mp3', '進食.mp3', '開.mp3', '阿剛.MP3', '阿嗚.MP3'].map((file) => (
                  <button key={file} type="button" onClick={() => playSound(`cat/${file}`)} className="bg-white/10 hover:bg-white/20 active:bg-white/30 text-white border border-white/10 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors shadow-sm">{file.replace(/\.[^/.]+$/, "")}</button>
                ))}
              </div>
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={!inputMessage.trim()}
          className={`shrink-0 font-bold text-[15px] px-2 py-2 rounded-lg transition-colors disabled:opacity-40 disabled:hover:bg-transparent ${currentSettings.textColor} hover:bg-white/10 active:bg-white/20`}
        >
          傳送
        </button>
      </form>

    </div>
  );
}

export default App;
