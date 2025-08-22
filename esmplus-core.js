// ==UserScript==
// @name        ESMplus Core Helper
// @namespace   esmplus-helper
// @version     1.2.1
// @description Shared helpers for ESMplus tools (tokens, backoff fetch, LS, concurrency, UI helpers, z-index stack, drag)
// @grant       none
// ==/UserScript==

(function () {
  'use strict';
  // singleton
  if (window.esmplus) return;

  // ---- Config (수정은 setConfig로) ----
  const CONFIG = {
    THROTTLE_MS: 0,       // per-request delay between tasks
    CONCURRENCY: 6,       // default concurrency
    USE_BATCH: false,     // server batch support flag (노출은 안함)
    TIMEOUT_MS: 10000,    // fetch timeout
    MAX_RETRY: 4          // exponential backoff retries
  };

  // ---- z-index stack ----
  const Z_BASE = 2147480000; // 매우 높은 시작값
  let zTop = Z_BASE;

  function bringToFront(el) {
    if (!el) return;
    el.style.zIndex = String(++zTop);
  }

  // 초기 계단 배치 (left/top 미설정 시)
  function autoPlaceIfNeeded(panel) {
    if (!panel) return;
    const hasPos = (panel.style.left && panel.style.top);
    if (hasPos) return;
    if (!panel.hasAttribute('data-esm-panel')) {
      panel.setAttribute('data-esm-panel', '1');
    }
    const count = document.querySelectorAll('[data-esm-panel]').length;
    const delta = (count - 1) * 24;
    panel.style.left  = `${20 + delta}px`;
    panel.style.top   = `${20 + delta}px`;
    panel.style.right = 'auto';
  }

  function registerPanel(el, headerEl) {
    if (!el) return;
    autoPlaceIfNeeded(el);
    bringToFront(el);
    const bring = () => bringToFront(el);
    // pointerdown이 클릭/드래그 모두 포착
    el.addEventListener('pointerdown', bring, { passive: true, capture: true });
    if (headerEl) headerEl.addEventListener('pointerdown', bring, { passive: true, capture: true });
  }

  // ---- Utilities ----
  const SLEEP = (ms) => new Promise(r => setTimeout(r, ms));
  const getLS = (k, d='') => {
    try { const v = localStorage.getItem(k); return v == null ? d : v; }
    catch { return d; }
  };
  const setLS = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  function collectTokens() {
    const tokens = [];
    try {
      document.querySelectorAll('input[name="__RequestVerificationToken"]').forEach(i => i.value && tokens.push(i.value));
      const meta = document.querySelector('meta[name="csrf-token"], meta[name="request-verification-token"]');
      if (meta?.content) tokens.push(meta.content);
    } catch {}
    return tokens;
  }

  async function postJSON(url, payload, extraHeaders) {
    const { TIMEOUT_MS, MAX_RETRY } = CONFIG;
    const baseHeaders = {
      'Content-Type': 'application/json;charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      ...(extraHeaders || {})
    };
    collectTokens().forEach(tk => {
      baseHeaders['RequestVerificationToken'] = tk;
      baseHeaders['X-CSRF-TOKEN'] = tk;
      baseHeaders['X-Request-Verification-Token'] = tk;
    });

    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: baseHeaders,
          credentials: 'include',
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        clearTimeout(timer);
        if (res.ok) return res.json();

        const status = res.status;
        const text = await res.text().catch(()=> '');
        // 재시도 조건: 429 또는 5xx
        if ((status === 429 || (status >= 500 && status < 600)) && attempt < MAX_RETRY) {
          await SLEEP(Math.min(2000, 200 * Math.pow(2, attempt - 1))); // 200,400,800,1600
          continue;
        }
        throw new Error(`HTTP ${status}: ${text || '요청 실패'}`);
      } catch (e) {
        clearTimeout(timer);
        const retriable = (e.name === 'AbortError') || /network|Failed to fetch/i.test(String(e));
        if (retriable && attempt < MAX_RETRY) {
          await SLEEP(300 * attempt);
          continue;
        }
        throw e;
      }
    }
  }

  async function runWithConcurrency(tasks, limit) {
    if (!Array.isArray(tasks) || tasks.length === 0) return [];
    const size = Math.min(Math.max(1, limit ?? CONFIG.CONCURRENCY), tasks.length);
    const results = new Array(tasks.length);
    let i = 0;
    const workers = Array.from({ length: size }, async () => {
      while (true) {
        const cur = i++;
        if (cur >= tasks.length) break;
        results[cur] = await tasks[cur]();
        if (CONFIG.THROTTLE_MS > 0) await SLEEP(CONFIG.THROTTLE_MS);
      }
    });
    await Promise.all(workers);
    return results;
  }

  function fmt(v) {
    if (v == null || v === '') return '';
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString() : String(v);
  }
  function fixWidth(s, n) {
    const t = (s ?? '').toString();
    return t.length > n ? (t.slice(0, n - 1) + '…') : t.padEnd(n, ' ');
  }
  function tryDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

  // ---- Drag helper (패널 드래그 & 위치 저장) ----
  // 헤더 안 인터랙티브 요소에서는 드래그 시작하지 않도록 개선
  const INTERACTIVE_SELECTOR = 'button, input, select, textarea, a, label, [role="button"], .no-drag';

  function enableDrag(panelEl, headerEl, posKey) {
    const handle = headerEl || panelEl;
    if (!panelEl || !handle) return;

    // 저장된 위치 복원
    try {
      const saved = getLS(`drag:${posKey}`, '');
      if (saved) {
        const pos = JSON.parse(saved);
        if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
          panelEl.style.left = `${pos.left}px`;
          panelEl.style.top  = `${pos.top}px`;
          panelEl.style.right = 'auto'; // left/top 기준으로 이동
        }
      }
    } catch {}

    // 드래그 상태
    let dragging = false;
    let startX = 0, startY = 0;
    let baseLeft = 0, baseTop = 0;
    const m = 10; // 화면 가장자리 마진

    // 모바일 스크롤/제스처 간섭 최소화
    try { handle.style.touchAction = 'none'; } catch {}
    try { handle.style.cursor = 'move'; } catch {}

    const onDown = (e) => {
      // 인터랙티브 요소 위면 드래그 시작 안 함
      if (e.target && e.target.closest && e.target.closest(INTERACTIVE_SELECTOR)) {
        return;
      }
      if (e.button != null && e.button !== 0) return; // 좌클릭만
      dragging = true;
      bringToFront(panelEl);
      document.body.style.userSelect = 'none';

      const rect = panelEl.getBoundingClientRect();
      baseLeft = rect.left + window.scrollX;
      baseTop  = rect.top + window.scrollY;
      startX = (e.clientX ?? 0) + window.scrollX;
      startY = (e.clientY ?? 0) + window.scrollY;

      try { handle.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!dragging) return;
      const curX = (e.clientX ?? 0) + window.scrollX;
      const curY = (e.clientY ?? 0) + window.scrollY;

      let nx = baseLeft + (curX - startX);
      let ny = baseTop  + (curY - startY);

      // 화면 경계 내로 클램프
      const maxX = window.scrollX + window.innerWidth  - panelEl.offsetWidth  - m;
      const maxY = window.scrollY + window.innerHeight - panelEl.offsetHeight - m;
      nx = Math.max(window.scrollX + m, Math.min(nx, Math.max(window.scrollX + m, maxX)));
      ny = Math.max(window.scrollY + m, Math.min(ny, Math.max(window.scrollY + m, maxY)));

      panelEl.style.left = `${nx}px`;
      panelEl.style.top  = `${ny}px`;
      panelEl.style.right = 'auto';
    };

    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      try { handle.releasePointerCapture(e.pointerId); } catch {}

      // 위치 저장
      try {
        const rect = panelEl.getBoundingClientRect();
        const pos = { left: Math.max(0, rect.left + window.scrollX), top: Math.max(0, rect.top + window.scrollY) };
        setLS(`drag:${posKey}`, JSON.stringify(pos));
      } catch {}
    };

    // pointer events
    handle.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  // ---- 최소화/복원 helper (display 토글 + 저장) ----
  // toggle=true 이면 즉시 토글. false면 저장된 값 읽어 초기 상태 반영.
  function applyMinState(bodyEl, storageKey, toggle=false) {
    if (!bodyEl) return false;
    const key = `min:${storageKey}`;
    if (toggle) {
      const nextMin = bodyEl.style.display !== 'none';
      bodyEl.style.display = nextMin ? 'none' : '';
      setLS(key, nextMin ? '1' : '0');
      return !nextMin;
    } else {
      const saved = getLS(key, '0') === '1';
      bodyEl.style.display = saved ? 'none' : '';
      return !saved;
    }
  }

  // ---- 합성 헬퍼: 패널을 한 번에 연결 (선택) ----
  function wirePanel({
    panel, headerSel, bodySel, closeSel, minSel,
    launcher, posKey, minKey
  }) {
    if (!panel) return;
    const header  = headerSel ? panel.querySelector(headerSel) : null;
    const body    = bodySel   ? panel.querySelector(bodySel)   : null;
    const closeBt = closeSel  ? panel.querySelector(closeSel)  : null;
    const minBt   = minSel    ? panel.querySelector(minSel)    : null;

    registerPanel(panel, header);
    enableDrag(panel, header, posKey);

    // 버튼에서 드래그 간섭 차단
    const stop = (e) => e.stopPropagation();
    [closeBt, minBt].forEach(b=>{
      if (!b) return;
      ['pointerdown','mousedown','touchstart','click'].forEach(ev=>{
        b.addEventListener(ev, stop, {passive:false});
      });
    });

    // 닫기/최소화
    if (closeBt && launcher) {
      closeBt.addEventListener('click', (e)=>{
        e.preventDefault();
        panel.style.display = 'none';
        launcher.style.display = 'block';
      });
    }
    if (minBt && body) {
      minBt.addEventListener('click', (e)=>{
        e.preventDefault();
        applyMinState(body, minKey, true);
      });
      applyMinState(body, minKey, false);
    }

    // 런처
    if (launcher) {
      launcher.addEventListener('click', ()=>{
        panel.style.display = '';
        launcher.style.display = 'none';
        bringToFront(panel);
      });
    }
  }

  // ---- Public API ----
  const api = {
    // constants
    SITE: { GMARKET: 2, AUCTION: 1 },
    KEYS: {
      masterId: 'esm.masterId',
      groupNo: 'esm.groupNo',
      siteGoodsNo: 'esm.siteGoodsNo',
      sellerId: 'esm.sellerId',
      bidKeywordNo: 'esm.bidKeywordNo',
      idx: 'esm.idx'
    },

    // config
    setConfig(c={}) { Object.assign(CONFIG, c); },
    getConfig() { return { ...CONFIG }; },

    // net & task
    SLEEP,
    postJSON,
    runWithConcurrency,

    // storage & fmt
    getLS, setLS,
    fmt, fixWidth, tryDecode,

    // ui helpers
    enableDrag,
    applyMinState,
    bringToFront,
    registerPanel,
    wirePanel   // 선택 사용
  };

  window.esmplus = api;
})();
