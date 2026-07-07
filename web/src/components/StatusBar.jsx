import React from 'react';
import { useStore } from '../store.jsx';

export default function StatusBar() {
  const { status } = useStore();
  const type = status.type === 'connecting' ? '' : status.type;
  return (
    <div className="status-bar">
      <div className="status-left">
        <span className={'status-indicator ' + type} />
        <span className="status-text">{status.text}</span>
      </div>
    </div>
  );
}
