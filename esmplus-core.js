// ==UserScript==
// @name        ESMplus Core Helper
// @namespace   esmplus-helper
// @version     1.0.0
// @description Shared helpers for ESMplus tools (tokens, backoff fetch, LS, concurrency, UI helpers)
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  if (window.esmplus) return; // singleton

  const CONFIG = {
    THROTTLE_MS: 0,       // per-request delay between concurrent tasks
    CONCURRENCY: 6,       // default concurrency
    USE_BATCH: false,     // server batch support
    TIMEOUT_MS: 10000,    // fetch timeout
    MAX_RETRY: 4          // exponential backoff retries
  };

  const api = {
    SITE: { GMARKET: 2, AUCTION: 1 },
    KEYS: {
      masterId: 'esm.masterId',
      groupNo: 'esm.groupNo',
      siteGoodsNo: 'esm.siteGoodsNo',
      sellerId: 'esm.sellerId',
      bidKeywordNo: 'esm.bidKeywordNo',
      idx: 'esm.idx'
    },
    setConfig(c={}) { Object.assign(CONFIG, c); },
    getConfig() { return { ...CONFIG }; },

    SLEEP: (ms) => new Promise(r => setTimeout(r, ms)),
    getLS: (k, d='') => localStorage.getItem(k) ?? d,
    setLS: (k, v) => localStorage.setItem(k, v),

    // z-index stack (페이지 위로 띄우되, 서로 간에는 순서를 조정)
    const Z_BASE = 2147480000; // 매우 높은 시작값(사이트 오버레이 위)
    let zTop = Z_BASE;

    function bringToFront(el) {
      // 가장 위로
      el.style.zIndex = String(++zTop);
    }
    
    function registerPanel(el, headerEl) {
      // 초기 등록 시에도 맨 위로
      bringToFront(el);
      const bring = () => bringToFront(el);
      // 마우스/터치 모두 대응
      el.addEventListener('pointerdown', bring, { passive: true });
      if (headerEl) headerEl.addEventListener('pointerdown', bring, { passive: true });
    }

    // 공개 API로 노출
    api.bringToFront = bringToFront;
    api.registerPanel = registerPanel;

    collectTokens() {
      const tokens = [];
      document.querySelectorAll('input[name="__RequestVerificationToken"]').forEach(i => i.value && tokens.push(i.value));
      const meta = document.querySelector('meta[name="csrf-token"], meta[name="request-verification-token"]');
      if (meta?.content) tokens.push(meta.content);
      return tokens;
    },

    async postJSON(url, payload, extraHeaders) {
      const { TIMEOUT_MS, MAX_RETRY } = CONFIG;
      const baseHeaders = { 'Content-Type': 'application/json;charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', ...(extraHeaders||{}) };
      api.collectTokens().forEach(tk => {
        baseHeaders['RequestVerificationToken'] = tk;
        baseHeaders['X-CSRF-TOKEN'] = tk;
        baseHeaders['X-Request-Verification-Token'] = tk;
      });

      for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const res = await fetch(url, { method: 'POST', headers: baseHeaders, credentials: 'include', body: JSON.stringify(payload), signal: controller.signal });
          clearTimeout(timer);
          if (res.ok) return res.json();
          const status = res.status;
          const text = await res.text().catch(()=> '');
          if ((status === 429 || (status >= 500 && status < 600)) && attempt < MAX_RETRY) {
            await api.SLEEP(Math.min(2000, 200 * Math.pow(2, attempt-1)));
            continue;
          }
          throw new Error(`HTTP ${status}: ${text || '요청 실패'}`);
        } catch (e) {
          clearTimeout(timer);
          if (attempt < MAX_RETRY && (e.name === 'AbortError' || /network|Failed to fetch/i.test(String(e)))) {
            await api.SLEEP(300 * attempt);
            continue;
          }
          throw e;
        }
      }
    },

    async runWithConcurrency(tasks, limit) {
      const { THROTTLE_MS, CONCURRENCY } = CONFIG;
      const size = Math.min(limit ?? CONCURRENCY, tasks.length);
      const results = new Array(tasks.length);
      let i = 0;
      const workers = Array.from({ length: Math.max(1, size) }, async () => {
        while (true) {
          const cur = i++;
          if (cur >= tasks.length) break;
          results[cur] = await tasks[cur]();
          if (THROTTLE_MS > 0) await api.SLEEP(THROTTLE_MS);
        }
      });
      await Promise.all(workers);
      return results;
    },

    fmt(v) {
      if (v == null || v === '') return '';
      const n = Number(v);
      return Number.isFinite(n) ? n.toLocaleString() : String(v);
    },
    fixWidth(s, n) {
      const t = (s ?? '').toString();
      return t.length > n ? (t.slice(0, n - 1) + '…') : t.padEnd(n, ' ');
    },
    tryDecode(s) { try { return decodeURIComponent(s); } catch { return s; } },

    // UI helpers
    enableDrag(panelEl, headerEl, posKey) {
      let isDown=false, sx=0, sy=0, startLeft=0, startTop=0;
      const pos = JSON.parse(api.getLS(posKey, 'null') || 'null');
      if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
        panelEl.style.left = `${pos.left}px`;
        panelEl.style.top  = `${pos.top}px`;
        panelEl.style.right = 'auto';
      }
      headerEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isDown = true;
        const rect = panelEl.getBoundingClientRect();
        startLeft = rect.left + window.scrollX; startTop = rect.top + window.scrollY;
        sx = e.clientX + window.scrollX; sy = e.clientY + window.scrollY;
        document.body.style.userSelect = 'none';
      });
      window.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        const nx = startLeft + (e.clientX + window.scrollX - sx);
        const ny = startTop  + (e.clientY + window.scrollY - sy);
        panelEl.style.left = `${Math.max(0, nx)}px`;
        panelEl.style.top  = `${Math.max(0, ny)}px`;
        panelEl.style.right = 'auto';
      });
      window.addEventListener('mouseup', () => {
        if (!isDown) return;
        isDown = false;
        document.body.style.userSelect = '';
        const rect = panelEl.getBoundingClientRect();
        const pos = { left: Math.max(0, rect.left + window.scrollX), top: Math.max(0, rect.top + window.scrollY) };
        api.setLS(posKey, JSON.stringify(pos));
      });
    },

    applyMinState(bodyEl, storageKey, toggle=false) {
      const next = toggle ? (bodyEl.style.display !== 'none') : (api.getLS(storageKey,'0') === '1');
      bodyEl.style.display = next ? 'none' : '';
      api.setLS(storageKey, next ? '1' : '0');
      return !next; // true if expanded
    }
  };

  window.esmplus = api;
})();
