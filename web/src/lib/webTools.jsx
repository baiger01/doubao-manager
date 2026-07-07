import React from 'react';

// 内置网页工具配置:左栏点击后在主区域打开内置浏览器
// icon 为返回 SVG 的函数(currentColor 跟随主题)
export const WEB_TOOLS = [
  {
    key: 'gemini',
    label: 'Gemini',
    url: 'https://gemini.google.com/app',
    partition: 'persist:gemini',
    icon: () => (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c.3 4.6 2.4 8.3 7 9.8.3.1.3.5 0 .6-4.6 1.4-6.7 5-7 9.6 0 .3-.5.3-.6 0-.3-4.6-2.4-8.2-7-9.6-.3-.1-.3-.5 0-.6 4.6-1.5 6.7-5.2 7-9.8 0-.3.6-.3.6 0Z" /></svg>
    ),
  },
  {
    key: 'grok',
    label: 'Grok',
    url: 'https://grok.com/',
    partition: 'persist:grok',
    icon: () => (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4h5l7 16h-5L6 4Z" /><path d="M9 13h9" /></svg>
    ),
  },
  {
    key: 'chatgpt',
    label: 'ChatGPT',
    url: 'https://chatgpt.com/',
    partition: 'persist:chatgpt',
    icon: () => (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 12 4.8 7.8M12 12v8.4M12 12l7.2-4.2M12 12 4.8 16.2M12 12l7.2 4.2" /><path d="M12 3.6 19.2 7.8v8.4L12 20.4 4.8 16.2V7.8L12 3.6Z" /></svg>
    ),
  },
  {
    key: 'doubaochat',
    label: '豆包对话',
    url: 'https://www.doubao.com/chat/',
    partition: 'persist:doubaochat',
    bindable: true, // 支持在「设置 > 内置浏览器」绑定已存储的豆包账号登录态
    icon: () => (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="6" width="16" height="12" rx="5" /><circle cx="9.5" cy="12" r="1.1" fill="currentColor" stroke="none" /><circle cx="14.5" cy="12" r="1.1" fill="currentColor" stroke="none" /><path d="M12 6V3.5M8 18l-1.5 2.5M16 18l1.5 2.5" /></svg>
    ),
  },
];

export const getWebTool = (key) => WEB_TOOLS.find(t => t.key === key) || null;


