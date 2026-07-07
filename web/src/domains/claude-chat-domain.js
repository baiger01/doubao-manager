import { useCallback, useRef, useState } from 'react';
import { api } from '../lib/api.js';

let claudeSeq = 0;
const nextClaudeMessageId = () => `claude_${Date.now()}_${claudeSeq++}`;

export function useClaudeChatDomain() {
  const [claudeMessages, setClaudeMessages] = useState([]);
  const [claudeSending, setClaudeSending] = useState(false);
  const [claudeConfig, setClaudeConfig] = useState({ configured: false, model: '', models: [] });
  const claudeAbortRef = useRef(null);
  const claudeMsgsRef = useRef(claudeMessages);
  claudeMsgsRef.current = claudeMessages;

  const loadClaudeConfig = useCallback(async () => {
    try {
      const r = await api.getClaudeConfig();
      if (r.success) {
        setClaudeConfig(r.data);
        return r.data;
      }
    } catch (e) {}
    return null;
  }, []);

  const sendClaudeMessage = useCallback((text) => {
    const content = (text || '').trim();
    if (!content) return false;
    if (claudeSending) return false;

    const userMsg = { id: nextClaudeMessageId(), role: 'user', content };
    const asstId = nextClaudeMessageId();
    const asstMsg = { id: asstId, role: 'assistant', content: '', streaming: true };

    const history = [...claudeMsgsRef.current.filter(m => !m.streaming), userMsg]
      .map(m => ({ role: m.role, content: m.content }));

    setClaudeMessages(prev => [...prev, userMsg, asstMsg]);
    setClaudeSending(true);

    const abort = api.claudeChat(history, undefined, {
      onDelta: (chunk) => {
        setClaudeMessages(prev => prev.map(m => m.id === asstId ? { ...m, content: m.content + chunk } : m));
      },
      onDone: (full) => {
        setClaudeMessages(prev => prev.map(m => m.id === asstId ? { ...m, content: full || m.content, streaming: false } : m));
        setClaudeSending(false);
        claudeAbortRef.current = null;
      },
      onError: (msg) => {
        setClaudeMessages(prev => prev.map(m => m.id === asstId ? { ...m, streaming: false, error: msg, content: m.content } : m));
        setClaudeSending(false);
        claudeAbortRef.current = null;
      },
    });
    claudeAbortRef.current = abort;
    return true;
  }, [claudeSending]);

  const stopClaude = useCallback(() => {
    if (claudeAbortRef.current) {
      try { claudeAbortRef.current(); } catch (e) {}
      claudeAbortRef.current = null;
    }
    setClaudeMessages(prev => prev.map(m => m.streaming ? { ...m, streaming: false } : m));
    setClaudeSending(false);
  }, []);

  const clearClaudeChat = useCallback(() => {
    stopClaude();
    setClaudeMessages([]);
  }, [stopClaude]);

  return {
    claudeMessages,
    claudeSending,
    claudeConfig,
    loadClaudeConfig,
    sendClaudeMessage,
    stopClaude,
    clearClaudeChat,
  };
}
