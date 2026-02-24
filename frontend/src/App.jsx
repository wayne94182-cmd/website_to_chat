import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import DOMPurify from 'dompurify';
import { v4 as uuidv4 } from 'uuid';

const socket = io(import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001', {
  transports: ['websocket', 'polling']
});

function App() {
  // 生成並存入 session (關閉分頁前一直有效)
  const [sessionId] = useState(() => {
    let storedId = sessionStorage.getItem('chat_session_id');
    if (!storedId) {
      storedId = uuidv4();
      sessionStorage.setItem('chat_session_id', storedId);
    }
    return storedId;
  });

  const [appState, setAppState] = useState(() => sessionStorage.getItem('chat_app_state') || 'idle');
  const [keyword, setKeyword] = useState('');
  const [messages, setMessages] = useState(() => {
    const saved = sessionStorage.getItem('chat_messages');
    return saved ? JSON.parse(saved) : [];
  });

  const [inputMessage, setInputMessage] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const typingTimeoutRef = useRef(null);
  const messagesEndRef = useRef(null);
  const chatContainerRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping, appState]);

  // 狀態同步至 Session Storage，讓重整後可以保留畫面和訊息
  useEffect(() => {
    sessionStorage.setItem('chat_app_state', appState);
  }, [appState]);

  useEffect(() => {
    sessionStorage.setItem('chat_messages', JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    // 一連線就告訴後端我是誰
    socket.emit('register', sessionId);

    socket.on('waiting', () => setAppState('waiting'));

    socket.on('matched', (data) => {
      setAppState('matched');
      if (!data.reconnected) {
        setMessages([]);
      }
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
    };
  }, [sessionId]);

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
    if (confirm("確定要離開對話嗎？")) {
      socket.emit('leave_chat');
      setAppState('idle');
      setMessages([]);
    }
  };

  if (appState === 'idle' || appState === 'waiting') {
    return (
      <div className="flex flex-col h-[100dvh] w-full bg-gradient-to-br from-[#c4e0e5] via-[#e5d4de] to-[#efa18b] items-center justify-center p-6 font-sans overflow-hidden">
        <h1 className="text-4xl font-extrabold text-white drop-shadow-md mb-2">Secret Chat</h1>
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
        <div className="h-8 w-8 text-[#6366f1] pointer-events-auto cursor-pointer" onClick={handleLeave} title="離開對話">
          <svg fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd"></path></svg>
        </div>
      </div>

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
                    <span dangerouslySetInnerHTML={{ __html: msg.message }} className="break-words whitespace-pre-wrap text-[15px] leading-relaxed block" />
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
                    <span dangerouslySetInnerHTML={{ __html: msg.message }} className="break-words whitespace-pre-wrap text-[15px] leading-relaxed block" />
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
