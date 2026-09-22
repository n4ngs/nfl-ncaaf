'use strict';

// Engines cannot access the upstream credential or create their own provider connection.
function subscribe(sport, callback, peer = process) {
  let current = { enabled: false, connection: 'disabled', connected: false };
  const listener = message => {
    if (!message || message.sport !== sport) return;
    if (message.type === 'owls:status') { current = message.status || current; return; }
    if (message.type !== 'owls:update' || !Array.isArray(message.events)) return;
    current = message.status || current;
    callback({ events: message.events, receivedAt: message.receivedAt, status: current });
  };
  if (typeof peer.send === 'function') {
    current = { enabled: peer.env?.OWLS_FEED_IPC === '1', connection: 'connecting', connected: false };
    peer.on('message', listener);
    try { peer.send({ type: 'owls:ready', sport }, () => {}); } catch {}
  }
  return { status: () => ({ ...current }), close() { peer.removeListener('message', listener); } };
}

// At most one frame in flight and one latest frame waiting per child. A slow child
// cannot build an unbounded queue of obsolete odds snapshots.
function relayToChild(child, sport, feed) {
  let busy = false, pending = null, closed = false;
  function flush(message) {
    if (closed || !child.connected) return;
    if (busy) { pending = message; return; }
    busy = true;
    try {
      child.send(message, error => {
        busy = false;
        const next = pending; pending = null;
        if (!error && next) flush(next);
      });
    } catch { busy = false; pending = null; }
  }
  const update = frame => flush({ type: 'owls:update', sport, ...frame });
  const ready = message => { if (message?.type === 'owls:ready' && message.sport === sport) update(feed.snapshot(sport)); };
  child.on('message', ready);
  return { update, status(status) { if (!busy) flush({ type: 'owls:status', sport, status }); }, close() { closed = true; pending = null; child.removeListener('message', ready); } };
}

module.exports = { subscribe, relayToChild };
