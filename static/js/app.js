(() => {
  'use strict';

  // ---------- Configuración ----------
  const SHEET_ID = '1mN1dy04M1oRSiGVxZWvbrt_I7x4MMLoZ59N8HNq4Ig4';
  const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;
  const REFRESH_MS = 30000;
  const FETCH_TIMEOUT_MS = 10000;
  const CACHE_KEY = 'af-products-v1';
  const THEME_KEY = 'af-theme';
  const MAX_SUGGESTIONS = 6;

  // ---------- Utilidades ----------
  const $ = (id) => document.getElementById(id);

  // Minúsculas y sin tildes: "Azúcar" == "azucar"
  const normalize = (s) =>
    String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  const escapeHTML = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Parser CSV (RFC 4180): respeta comillas, comas y saltos de línea dentro de celdas.
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    text = text.replace(/^\uFEFF/, '');

    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function rowsToProducts(rows) {
    if (rows.length < 2) return [];
    const headers = rows[0].map((h) => normalize(h).replace(/\s+/g, '_'));
    return rows
      .slice(1)
      .filter((r) => r.some((c) => c.trim()))
      .map((r) => {
        const o = {};
        headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
        const p = {
          nombre: o.nombre || '',
          marca: o.marca || '',
          presentacion: o.presentacion || '',
          precio: o.precio || '',
          fecha: o.ultima_actualizacion || '',
        };
        p._name = normalize(p.nombre);
        p._hay = normalize(`${p.nombre} ${p.marca} ${p.presentacion}`);
        return p;
      })
      .filter((p) => p.nombre);
  }

  // Todas las palabras tienen que aparecer (en nombre, marca o presentación).
  // Los que empiezan con lo buscado salen primero.
  function search(list, query) {
    const tokens = normalize(query).split(/\s+/).filter(Boolean);
    if (!tokens.length) return list;
    return list
      .map((p) => {
        if (!tokens.every((t) => p._hay.includes(t))) return null;
        let score = 0;
        if (p._name.startsWith(tokens[0])) score += 2;
        if (tokens.every((t) => p._name.includes(t))) score += 1;
        return { p, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.p);
  }

  // Exponer para pruebas (no afecta a la app)
  globalThis.__af = { parseCSV, rowsToProducts, search, normalize };
  if (typeof document === 'undefined' || !$('searchInput')) return;

  // ---------- Estado ----------
  const els = {
    form: $('searchForm'),
    input: $('searchInput'),
    clear: $('clearBtn'),
    suggestions: $('suggestions'),
    list: $('productList'),
    empty: $('emptyState'),
    count: $('count'),
    syncText: $('syncText'),
    refresh: $('refreshBtn'),
    results: $('results'),
    theme: $('themeToggle'),
    install: $('installBtn'),
  };

  let products = [];
  let query = '';
  let suggestionItems = [];
  let activeIdx = -1;
  let lastSync = null;
  let loading = true;
  let failed = false; // el último intento de sincronizar falló

  // ---------- Tema (oscuro por defecto) ----------
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function applyTheme(theme, persist) {
    document.documentElement.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f7f5' : '#0e1311');
    els.theme.setAttribute('aria-label', theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
    if (persist) {
      try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* modo privado */ }
    }
  }

  els.theme.addEventListener('click', () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true));
  applyTheme(currentTheme(), false);

  // ---------- Render ----------
  function formatTime(ts) {
    return new Date(ts).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function timeAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 45) return 'hace un momento';
    const m = Math.round(s / 60);
    if (m < 60) return `hace ${m} min`;
    return `a las ${formatTime(ts)}`;
  }

  function renderStatus() {
    let state = 'ok';
    let text = '';
    if (loading && !lastSync) { state = 'loading'; text = 'Sincronizando…'; }
    else if (failed && lastSync) { state = 'offline'; text = `Sin conexión · datos del ${formatTime(lastSync)}`; }
    else if (failed) { state = 'error'; text = 'Sin conexión'; }
    else if (lastSync) { text = `Actualizado ${timeAgo(lastSync)}`; }
    els.syncText.textContent = text;
    els.syncText.dataset.state = state;
    els.refresh.classList.toggle('spin', loading);
  }

  function itemHTML(p) {
    const meta = [p.marca, p.presentacion].filter(Boolean).map(escapeHTML).join(' · ');
    return `
      <li class="item">
        <span class="item-name">${escapeHTML(p.nombre)}</span>
        <span class="item-meta">${meta || '&nbsp;'}</span>
        <span class="item-price">${escapeHTML(p.precio || '—')}${p.fecha ? `<small>${escapeHTML(p.fecha)}</small>` : ''}</span>
      </li>`;
  }

  function render() {
    const hasData = products.length > 0;

    // Primera carga sin datos guardados: esqueleto
    if (!hasData && loading) {
      els.list.innerHTML = Array(5).fill(
        '<li class="item skeleton"><span class="item-name">.</span><span class="item-meta">.</span><span class="item-price">.</span></li>'
      ).join('');
      els.list.setAttribute('aria-busy', 'true');
      els.empty.hidden = true;
      els.count.textContent = 'Cargando precios…';
      renderStatus();
      return;
    }
    els.list.setAttribute('aria-busy', 'false');

    if (!hasData) {
      els.list.innerHTML = '';
      els.empty.hidden = false;
      els.empty.innerHTML = failed
        ? '<strong>No pudimos cargar los precios</strong>Revisá tu conexión e intentá de nuevo.<br><button type="button" data-action="retry">Reintentar</button>'
        : '<strong>La lista está vacía</strong>Todavía no hay productos cargados.';
      els.count.textContent = '';
      renderStatus();
      return;
    }

    const matches = search(products, query);
    const q = query.trim();

    els.list.innerHTML = matches.map(itemHTML).join('');
    if (matches.length === 0) {
      els.empty.hidden = false;
      els.empty.innerHTML = `<strong>Sin resultados para “${escapeHTML(q)}”</strong>Probá con otra palabra o revisá la ortografía.<br><button type="button" data-action="clear">Ver todos los productos</button>`;
    } else {
      els.empty.hidden = true;
    }

    const n = matches.length;
    els.count.textContent = q
      ? `${n} ${n === 1 ? 'resultado' : 'resultados'}`
      : `${n} ${n === 1 ? 'producto' : 'productos'}`;
    renderStatus();
  }

  els.empty.addEventListener('click', (e) => {
    const action = e.target.closest('button')?.dataset.action;
    if (action === 'clear') clearSearch();
    if (action === 'retry') loadProducts(true);
  });

  // ---------- Sugerencias ----------
  function buildSuggestions() {
    const q = query.trim();
    if (!q) return [];
    const seen = new Set();
    const out = [];
    for (const p of search(products, q)) {
      if (seen.has(p._name)) continue;
      seen.add(p._name);
      out.push(p);
      if (out.length >= MAX_SUGGESTIONS) break;
    }
    // Si lo único que hay es exactamente lo escrito, no hace falta sugerir
    if (out.length === 1 && out[0]._name === normalize(q)) return [];
    return out;
  }

  function openSuggestions() {
    suggestionItems = buildSuggestions();
    activeIdx = -1;
    if (!suggestionItems.length) return closeSuggestions();
    els.suggestions.innerHTML = suggestionItems
      .map((p, i) => `<li role="option" id="sug-${i}" data-i="${i}" aria-selected="false"><span>${escapeHTML(p.nombre)}</span>${p.marca ? `<small>${escapeHTML(p.marca)}</small>` : ''}</li>`)
      .join('');
    els.suggestions.hidden = false;
    els.input.setAttribute('aria-expanded', 'true');
  }

  function closeSuggestions() {
    els.suggestions.hidden = true;
    els.suggestions.innerHTML = '';
    suggestionItems = [];
    activeIdx = -1;
    els.input.setAttribute('aria-expanded', 'false');
    els.input.removeAttribute('aria-activedescendant');
  }

  function setActive(i) {
    const items = els.suggestions.querySelectorAll('li');
    items.forEach((li, idx) => li.setAttribute('aria-selected', String(idx === i)));
    activeIdx = i;
    if (i >= 0) {
      els.input.setAttribute('aria-activedescendant', `sug-${i}`);
      items[i].scrollIntoView({ block: 'nearest' });
    } else {
      els.input.removeAttribute('aria-activedescendant');
    }
  }

  function pickSuggestion(i) {
    const p = suggestionItems[i];
    if (!p) return;
    els.input.value = p.nombre;
    commitSearch();
  }

  // ---------- Búsqueda ----------
  function syncClearButton() {
    els.clear.hidden = !els.input.value;
  }

  // Búsqueda "confirmada": Enter o botón Buscar
  function commitSearch() {
    query = els.input.value;
    closeSuggestions();
    render();
    syncClearButton();
    // En el celular bajamos el teclado para ver los resultados; en escritorio dejamos el foco.
    if (window.matchMedia('(pointer: coarse)').matches) els.input.blur();
    els.results.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function clearSearch() {
    els.input.value = '';
    query = '';
    closeSuggestions();
    syncClearButton();
    render();
    els.input.focus();
  }

  // Enter (teclado físico o virtual) y botón "Buscar" terminan acá
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (activeIdx >= 0) pickSuggestion(activeIdx);
    else commitSearch();
  });

  // Filtra mientras se escribe
  els.input.addEventListener('input', () => {
    query = els.input.value;
    syncClearButton();
    render();
    openSuggestions();
  });

  els.input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const open = !els.suggestions.hidden;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openSuggestions();
      if (suggestionItems.length) setActive((activeIdx + 1) % suggestionItems.length);
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      setActive(activeIdx <= 0 ? suggestionItems.length - 1 : activeIdx - 1);
    } else if (e.key === 'Escape') {
      if (open) closeSuggestions();
      else if (els.input.value) clearSearch();
    }
  });

  els.input.addEventListener('focus', () => { if (els.input.value) openSuggestions(); });

  // mousedown evita que el input pierda el foco antes del click
  els.suggestions.addEventListener('mousedown', (e) => e.preventDefault());
  els.suggestions.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (li) pickSuggestion(Number(li.dataset.i));
  });

  els.clear.addEventListener('click', clearSearch);

  // Cerrar sugerencias al salir del buscador
  els.form.addEventListener('focusout', (e) => {
    if (!els.form.contains(e.relatedTarget)) closeSuggestions();
  });

  // ---------- Datos (Google Sheets + caché local) ----------
  function loadFromCache() {
    try {
      const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (raw && Array.isArray(raw.rows) && raw.rows.length) {
        products = rowsToProducts(raw.rows);
        lastSync = raw.ts;
      }
    } catch (e) { /* caché dañada: se ignora */ }
  }

  function saveToCache(rows) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), rows })); } catch (e) { /* sin espacio */ }
  }

  let inFlight = false;
  async function loadProducts(manual = false) {
    if (inFlight) return;
    if (!manual && (document.hidden || !navigator.onLine)) return;
    inFlight = true;
    loading = true;
    renderStatus();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${CSV_URL}&_t=${Date.now()}`, { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = parseCSV(await res.text());
      products = rowsToProducts(rows);
      lastSync = Date.now();
      failed = false;
      saveToCache(rows);
    } catch (err) {
      console.warn('No se pudo sincronizar con Google Sheets:', err);
      failed = true;
    } finally {
      clearTimeout(timer);
      loading = false;
      inFlight = false;
      render();
      // Si el usuario está viendo sugerencias, que reflejen los datos nuevos
      if (!els.suggestions.hidden) openSuggestions();
    }
  }

  els.refresh.addEventListener('click', () => loadProducts(true));

  // Mostrar al instante lo guardado y sincronizar en segundo plano
  loadFromCache();
  render();
  loadProducts(true);

  setInterval(() => loadProducts(), REFRESH_MS);
  setInterval(renderStatus, 30000);
  window.addEventListener('online', () => loadProducts(true));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!lastSync || Date.now() - lastSync > 10000)) loadProducts();
  });

  // ---------- PWA: service worker + botón instalar ----------
  const swTag = document.querySelector('script[data-sw]');
  if ('serviceWorker' in navigator && swTag && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(swTag.dataset.sw).catch((err) => console.warn('SW no registrado:', err));
    });
  }

  let installEvent = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    els.install.hidden = false;
  });
  els.install.addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null;
    els.install.hidden = true;
  });
  window.addEventListener('appinstalled', () => { els.install.hidden = true; });
})();
