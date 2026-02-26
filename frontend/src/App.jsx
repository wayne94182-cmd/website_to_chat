import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import DOMPurify from 'dompurify';
import { v4 as uuidv4 } from 'uuid';

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

function App() {
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
  const [messages, setMessages] = useState(() => {
    const saved = localStorage.getItem('chat_messages');
    return saved ? JSON.parse(saved) : [];
  });

  const [inputMessage, setInputMessage] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const typingTimeoutRef = useRef(null);
  const messagesEndRef = useRef(null);
  const chatContainerRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping, appState]);

  // 狀態同步至 Local Storage，讓重整後可以保留畫面和訊息
  useEffect(() => {
    localStorage.setItem('chat_app_state', appState);
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
        setMessages((prev) => {
          // 簡單防呆，如果本地已經有紀錄，看要不要覆蓋，這邊為了展示功能直接使用伺服器送來的
          return historyMessages.map(msg => ({
            id: msg.messageId,
            message: msg.message,
            isMine: msg.senderId === sessionId,
            time: new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            timestamp: new Date(msg.timestamp).getTime()
          }));
        });
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
    });

    socket.on('message_read', (messageId) => {
      setMessages((prev) => prev.map(msg =>
        msg.id === messageId ? { ...msg, isRead: true } : msg
      ));
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

    socket.on('error', (msg) => alert(msg));

    return () => {
      socket.off('waiting');
      socket.off('matched');
      socket.off('receive_message');
      socket.off('message_read');
      socket.off('partner_typing');
      socket.off('partner_disconnected');
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

  const handleStart = (useKeyword = false) => {
    socket.emit('join_queue', { keyword: useKeyword ? keyword : '', userId: sessionId });
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
    alert('感謝您的回報，我們會盡快審查該使用者的行為。');
    confirmLeave();
  };

  if (appState === 'idle' || appState === 'waiting') {
    return (
      <div className="flex flex-col h-[100dvh] w-full bg-gradient-to-br from-[#c4e0e5] via-[#e5d4de] to-[#efa18b] items-center justify-center p-6 font-sans overflow-hidden">
        <h1 className="text-4xl font-extrabold text-white drop-shadow-md mb-2">匿名交友</h1>
        <p className="text-white/90 font-medium mb-10 text-lg drop-shadow-sm">
          {appState === 'waiting' ? '尋找緣分中...' : '隨機遇見世界上的另一個人'}
        </p>

        {appState === 'idle' && (
          <div className="w-full max-w-sm flex flex-col space-y-4 bg-white/20 p-6 rounded-3xl backdrop-blur-md shadow-xl border border-white/30">
            <button
              onClick={() => handleStart(false)}
              className="w-full py-4 bg-[#6366f1] hover:bg-[#4f46e5] text-white rounded-full font-bold shadow-lg active:scale-95 transition-all text-lg"
            >
              開始隨機配對
            </button>
            <div className="relative flex items-center py-2">
              <div className="flex-grow border-t border-white/50"></div>
              <span className="flex-shrink-0 mx-4 text-white font-medium text-sm">或者是</span>
              <div className="flex-grow border-t border-white/50"></div>
            </div>
            <div className="flex flex-col space-y-3">
              <input
                type="text"
                placeholder="輸入興趣關鍵字 (例如：音樂、電影)"
                className="w-full px-5 py-4 bg-white/90 border-0 rounded-full focus:outline-none focus:ring-4 focus:ring-white/50 transition-all text-gray-800 shadow-sm placeholder-gray-400"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleStart(true)}
              />
              <button
                onClick={() => handleStart(true)}
                className="w-full py-4 bg-white text-[#6366f1] rounded-full font-bold shadow-md hover:bg-gray-50 active:scale-95 transition-all"
              >
                依關鍵字尋找
              </button>
            </div>
          </div>
        )}

        {appState === 'waiting' && (
          <div className="flex flex-col items-center">
            <div className="w-12 h-12 border-4 border-white border-t-transparent rounded-full animate-spin mb-6 shadow-sm"></div>
            <button onClick={() => { socket.emit('leave_chat'); setAppState('idle'); }} className="text-white/80 hover:text-white underline underline-offset-4 transition-colors">取消配對</button>
          </div>
        )}
      </div>
    );
  }

  // 聊天室主體 
  return (
    <div className="flex flex-col h-[100dvh] w-full items-center bg-gradient-to-br from-[#c8e3e7] via-[#e5d4de] to-[#f4aaaa] font-sans overflow-hidden">

      <div className="w-full flex items-center justify-between p-4 fixed top-0 left-0 z-30 pointer-events-none">
        <div className="relative pointer-events-auto">
          <div className="h-8 w-8 text-[#6366f1] cursor-pointer" onClick={() => setIsMenuOpen(!isMenuOpen)} title="選單">
            <svg fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd"></path></svg>
          </div>

          {isMenuOpen && (
            <div className="absolute top-10 left-0 mt-2 w-64 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg border border-gray-100 overflow-hidden z-50">
              <div className="flex flex-col text-gray-700 text-[15px] font-medium">
                <button className="px-5 py-3 text-left hover:bg-gray-50 active:bg-gray-100 transition-colors border-b border-gray-100" onClick={() => { alert('免責聲明：本網站僅供匿名聊天交流，不對使用者言論負責，請遵守網路禮儀。'); setIsMenuOpen(false); }}>免責聲明</button>
                <button className="px-5 py-3 text-left hover:bg-gray-50 active:bg-gray-100 transition-colors border-b border-gray-100" onClick={() => { alert('為維護社群品質，若發現違規行為，我們將會處理您的檢舉。'); setIsMenuOpen(false); }}>檢舉</button>
                <div className="px-5 py-3 text-left border-b border-gray-100 text-sm text-gray-500 leading-relaxed">問題回報與廣告聯絡：<br /><a href="mailto:wayne9487087@gmail.com" className="text-[#6366f1] select-all">wayne9487087@gmail.com</a></div>
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

      <div
        ref={chatContainerRef}
        className="flex-1 overflow-y-auto w-full max-w-2xl px-4 pt-16 pb-6 flex flex-col space-y-1.5 scrollbar-hide"
      >
        <div className="flex justify-center mb-6 mt-2">
          <span className="text-xs text-black/40 font-medium tracking-wide">已配對成功，對方已加入對話</span>
        </div>

        {messages.map((msg, i) => {
          const isNextSame = i < messages.length - 1 && messages[i + 1].isMine === msg.isMine;

          return (
            <div key={i} className={`flex w-full ${msg.isMine ? 'justify-end' : 'justify-start'} ${isNextSame ? 'mb-0.5' : 'mb-3'}`}>

              {!msg.isMine && (
                <div className="flex items-end max-w-[75%] group">
                  <div className={`relative bg-[#f5f5f5] text-gray-800 px-4 py-2.5 shadow-sm z-10 
                    ${isNextSame ? 'rounded-[20px] rounded-bl-sm' : 'rounded-[20px]'}
                    ${!isNextSame ? "after:content-[''] after:absolute after:bottom-0 after:-left-[6px] after:border-b-[14px] after:border-b-[#f5f5f5] after:border-l-[14px] after:border-l-transparent" : ''}
                  `}>
                    <span className="break-words whitespace-pre-wrap text-[15px] leading-relaxed block">{msg.message}</span>
                  </div>
                  <span className="text-[10px] text-black/30 ml-2 mb-1 shrink-0 font-medium select-none">{msg.time}</span>
                </div>
              )}

              {msg.isMine && (
                <div className="flex items-end max-w-[75%] group">
                  <div className="flex flex-col items-end mr-2 mb-1 shrink-0 select-none">
                    {msg.isRead && <span className="text-[10px] text-black/40 font-bold mb-0.5 scale-95 origin-right">已讀</span>}
                    <span className="text-[10px] text-black/30 font-medium">{msg.time}</span>
                  </div>
                  <div className={`relative bg-[#6366f1] text-white px-4 py-2.5 shadow-sm z-10
                    ${isNextSame ? 'rounded-[20px] rounded-br-sm' : 'rounded-[20px]'}
                    ${!isNextSame ? "after:content-[''] after:absolute after:bottom-0 after:-right-[6px] after:border-b-[14px] after:border-b-[#6366f1] after:border-r-[14px] after:border-r-transparent" : ''}
                  `}>
                    <span className="break-words whitespace-pre-wrap text-[15px] leading-relaxed block">{msg.message}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {isTyping && (
          <div className="flex justify-start mb-3">
            <div className="bg-[#f5f5f5] px-4 py-3.5 rounded-[20px] rounded-bl-sm shadow-sm flex items-center gap-1.5 w-14 justify-center">
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} className="h-4 shrink-0" />
      </div>

      <form onSubmit={handleSendMessage} className="bg-white px-4 py-3 pb-8 sm:pb-4 w-full flex gap-3 shrink-0 z-20 items-center justify-between shadow-[0_-5px_15px_rgba(0,0,0,0.02)]">

        <button
          type="button"
          onClick={handleLeave}
          className="shrink-0 font-bold text-[15px] text-[#6366f1] px-2 py-2 hover:bg-indigo-50 active:bg-indigo-100 rounded-lg transition-colors"
        >
          離開
        </button>

        <div className="flex-1 flex items-center bg-transparent">
          <input
            type="text"
            value={inputMessage}
            onChange={handleTyping}
            maxLength={500}
            className="w-full bg-transparent border-b border-gray-300 focus:border-[#6366f1] px-1 py-2 text-[15px] text-gray-800 placeholder-gray-400 focus:outline-none transition-colors"
            placeholder="輸入訊息..."
          />
        </div>

        <button
          type="submit"
          disabled={!inputMessage.trim()}
          className="shrink-0 font-bold text-[15px] text-[#6366f1] px-2 py-2 hover:bg-indigo-50 active:bg-indigo-100 rounded-lg transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
        >
          傳送
        </button>
      </form>

    </div>
  );
}

export default App;
