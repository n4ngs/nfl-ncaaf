'use strict';

// A synchronous dispatcher with independent completion clocks. Calling run never waits on a
// different key, and callers for an in-flight key share its promise rather than duplicate work.
class KeyedPoller {
  constructor({ now = Date.now, onError = () => {}, maxEntries = 128, maxBackoffMs = 120000 } = {}) {
    this.now = now;
    this.onError = onError;
    this.maxEntries = maxEntries;
    this.maxBackoffMs = maxBackoffMs;
    this.states = new Map();
  }

  run(key, task, { intervalMs = 0, lastSuccessAt = null, retryMinMs = 0 } = {}) {
    let state = this.states.get(key);
    if (state?.promise) return state.promise;
    const now = this.now();
    const interval = Math.max(0, Number(intervalMs) || 0);
    const clocks = [state?.lastSuccessAt, lastSuccessAt].filter((at) => at != null && Number.isFinite(at));
    if (state?.retryAt > now || (clocks.length && now < Math.max(...clocks) + interval)) return null;
    if (!state) {
      if (this.states.size >= this.maxEntries) {
        const oldest = [...this.states].filter(([, s]) => !s.promise && s.retryAt <= now).sort((a, b) => a[1].lastCompletedAt - b[1].lastCompletedAt)[0];
        if (oldest) this.states.delete(oldest[0]);
        else return Promise.resolve({ ok: false, error: new Error('Poll capacity reached') });
      }
      state = { attempts: 0, failures: 0, lastSuccessAt: null, lastCompletedAt: null, retryAt: 0, durationMs: null, meanDurationMs: null, promise: null };
      this.states.set(key, state);
    }
    state.attempts++;
    state.lastStartedAt = now;
    state.promise = Promise.resolve().then(task).then((value) => {
      state.failures = 0;
      state.retryAt = 0;
      state.lastSuccessAt = this.now();
      return { ok: true, value };
    }, (error) => {
      state.failures++;
      const exponential = Math.min(this.maxBackoffMs, 5000 * 2 ** Math.min(20, state.failures - 1));
      state.retryAt = this.now() + Math.max(Number(retryMinMs) || 0, exponential, Number(error?.retryAfterMs) || 0);
      try { this.onError(key, error); } catch { /* reporting cannot strand a poll */ }
      return { ok: false, error };
    }).finally(() => {
      state.lastCompletedAt = this.now();
      state.durationMs = Math.max(0, state.lastCompletedAt - state.lastStartedAt);
      state.meanDurationMs = state.meanDurationMs == null ? state.durationMs : Math.round(state.meanDurationMs * 0.8 + state.durationMs * 0.2);
      state.promise = null;
    });
    return state.promise;
  }

  health() {
    return Object.fromEntries([...this.states].map(([key, s]) => [key, {
      running: !!s.promise, attempts: s.attempts, failures: s.failures,
      lastStartedAt: s.lastStartedAt, lastCompletedAt: s.lastCompletedAt,
      lastSuccessAt: s.lastSuccessAt, retryAt: s.retryAt,
      durationMs: s.durationMs, meanDurationMs: s.meanDurationMs,
    }]));
  }
}

function retryAfterMs(value, now = Date.now()) {
  if (value == null || String(value).trim() === '') return 0;
  const text = String(value).trim();
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Number.isFinite(seconds * 1000) ? Math.max(0, seconds * 1000) : 0;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

module.exports = { KeyedPoller, retryAfterMs };
