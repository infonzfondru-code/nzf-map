/* NZF map v2: department/year tree + KML semantics. */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const scriptBase = document.currentScript?.src ? new URL('../', document.currentScript.src) : new URL('./', document.baseURI);
  const dataBase = new URL('data/', scriptBase);
  const dataUrl = file => new URL(String(file).split('/').map(encodeURIComponent).join('/'), dataBase).toString();
  const statusText = byId('statusText');
  const departmentList = byId('departmentList');
  const resultsEl = byId('searchResults');
  const searchEl = byId('searchInput');
  const LOCALE = 'ru-RU';
  const FIELD_NAMES = {
    'Контракт_N_договора': 'Контракт / № договора',
    'Название': 'Название',
    'Год_и_месяц': 'Год и месяц',
    'Вид_работ': 'Вид работ',
    'Площадь_га': 'Площадь, га',
    'Детализация_см_пикс': 'Детализация, см/пикс',
    'Масштаб': 'Масштаб'
  };
  const ORDER = ['Вид_работ', 'Год_и_месяц', 'Контракт_N_договора', 'Площадь_га', 'Детализация_см_пикс', 'Масштаб', 'Название'];
  if (!window.L) {
    departmentList.textContent = 'Не удалось загрузить библиотеку карты. Проверьте доступ к unpkg.com.';
    statusText.textContent = 'Картографическая библиотека недоступна';
    return;
  }

  const map = L.map('map', {
    center: [61, 90], zoom: 3, minZoom: 2, maxZoom: 18, zoomControl: false,
    preferCanvas: true, worldCopyJump: true, zoomSnap: .5, zoomDelta: 1
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
  }).addTo(map);
  L.control.zoom({position: 'topright'}).addTo(map);
  L.control.scale({position: 'bottomleft', imperial: false, metric: true}).addTo(map);
  const canvasRenderer = L.canvas({padding: .25});

  let departments = [];
  let specs = [];
  const selected = new Set();
  const cached = new Map();
  const pending = new Map();
  const records = new Map();
  const failed = new Set();
  const expanded = new Set();

  function normalize(s) { return String(s ?? '').toLocaleLowerCase(LOCALE).replaceAll('ё', 'е').trim(); }
  function countSelected() { return specs.reduce((n, s) => n + (selected.has(s.key) && cached.has(s.key) ? s.count : 0), 0); }
  function setStatus(message) { statusText.textContent = message; }
  function updateCounts() {
    byId('visibleCount').textContent = countSelected().toLocaleString(LOCALE);
    searchEl.disabled = !cached.size;
  }
  function updateStatus() {
    if (pending.size) setStatus(`Загружаем наборы данных: ${pending.size}…`);
    else if (failed.size) setStatus('Часть данных не загрузилась. Проверьте файлы или соединение.');
    else setStatus('Данные загружены · нажмите на объект');
  }
  function makeRow(label, value) {
    const row = document.createElement('div');
    row.className = 'nzf-popup-line';
    const key = document.createElement('dt');
    key.textContent = label;
    const val = document.createElement('dd');
    // Always show original semantics as plain text, never as untrusted HTML.
    val.textContent = String(value);
    row.append(key, val);
    return row;
  }
  function popupNode(feature, spec) {
    const p = feature.properties || {};
    const fields = p.fields || {};
    const card = document.createElement('div');
    card.className = 'nzf-popup';
    const pill = document.createElement('span');
    pill.className = 'nzf-popup-year';
    pill.textContent = `${spec.departmentTitle} · ${spec.year} год`;
    const title = document.createElement('h3');
    title.className = 'nzf-popup-title';
    title.textContent = p.name || fields['Название'] || 'Объект без названия';
    card.append(pill, title);
    const dl = document.createElement('dl');
    dl.className = 'nzf-popup-list';
    const keys = [...ORDER, ...Object.keys(fields).filter(k => !ORDER.includes(k))];
    for (const key of keys) {
      const val = fields[key];
      if (val === undefined || val === null || String(val).trim() === '') continue;
      if (key === 'Название' && normalize(val) === normalize(p.name)) continue;
      dl.appendChild(makeRow(FIELD_NAMES[key] || key.replaceAll('_', ' '), val));
    }
    if (!dl.children.length) dl.appendChild(makeRow('Информация', 'Дополнительные сведения отсутствуют'));
    card.appendChild(dl);
    return card;
  }
  function lineStyle(spec) { return {color: spec.color, weight: 3.2, opacity: .95, renderer: canvasRenderer}; }
  function featureStyle(spec) {
    return {color: spec.color, weight: 1.7, opacity: .9, fillColor: spec.color,
      fillOpacity: .27, smoothFactor: 1.35, renderer: canvasRenderer};
  }

  async function loadDataset(spec) {
    if (cached.has(spec.key)) return cached.get(spec.key);
    if (pending.has(spec.key)) return pending.get(spec.key);
    const task = (async () => {
      const res = await fetch(dataUrl(spec.file), {cache: 'default'});
      if (!res.ok) throw new Error(`${spec.file}: HTTP ${res.status}`);
      const geo = await res.json();
      const reg = [];
      const layer = L.geoJSON(geo, {
        renderer: canvasRenderer,
        style: feature => feature.geometry && /LineString/.test(feature.geometry.type) ? lineStyle(spec) : featureStyle(spec),
        onEachFeature(feature, shape) {
          reg.push({feature, layer: shape, spec});
          shape.on('mouseover', () => { if (shape.setStyle) shape.setStyle({weight: 3, fillOpacity: .42}); });
          shape.on('mouseout', () => { if (shape.setStyle) layer.resetStyle(shape); });
          shape.on('click', () => {
            shape.bindPopup(popupNode(feature, spec), {maxWidth: 380, minWidth: 230, autoPan: true}).openPopup();
          });
        }
      });
      cached.set(spec.key, layer);
      records.set(spec.key, reg);
      failed.delete(spec.key);
      if (selected.has(spec.key)) layer.addTo(map);
      updateCounts();
      return layer;
    })();
    pending.set(spec.key, task);
    updateStatus();
    try { return await task; }
    catch (e) {
      console.error('Не удалось загрузить ' + spec.file, e);
      failed.add(spec.key);
      return null;
    } finally {
      pending.delete(spec.key);
      updateStatus();
      updateCounts();
    }
  }

  function fitSelected() {
    let bounds = null;
    for (const spec of specs) {
      if (!selected.has(spec.key)) continue;
      for (const item of (records.get(spec.key) || [])) {
        const b = typeof item.layer.getBounds === 'function' ? item.layer.getBounds() : null;
        if (!b || !b.isValid()) continue;
        // Retain, but exclude from initial fit, features with suspicious coordinates.
        const c = b.getCenter();
        if (c.lat < 35 || c.lat > 78 || c.lng < 20 || c.lng > 180) continue;
        bounds = bounds ? bounds.extend(b) : L.latLngBounds(b);
      }
    }
    if (bounds && bounds.isValid()) map.fitBounds(bounds, {padding: [38, 38], maxZoom: 12, animate: false});
    else map.setView([61, 90], 3);
  }
  async function changeDataset(spec, enabled) {
    if (enabled) selected.add(spec.key);
    else selected.delete(spec.key);
    const layer = cached.get(spec.key);
    if (layer) {
      if (enabled && !map.hasLayer(layer)) layer.addTo(map);
      else if (!enabled && map.hasLayer(layer)) map.removeLayer(layer);
    } else if (enabled) await loadDataset(spec);
    updateCounts();
    searchResults();
  }
  function makeYearRow(spec) {
    const label = document.createElement('label');
    label.className = 'nzf-year';
    const left = document.createElement('span');
    left.className = 'nzf-year-left';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = selected.has(spec.key);
    check.dataset.key = spec.key;
    check.setAttribute('aria-label', `${spec.departmentTitle}, ${spec.year} год, ${spec.count} объектов`);
    check.addEventListener('change', () => changeDataset(spec, check.checked));
    const dot = document.createElement('span');
    dot.className = 'nzf-year-dot';
    dot.style.backgroundColor = spec.color;
    const name = document.createElement('span');
    name.className = 'nzf-year-name';
    name.textContent = `${spec.year} год`;
    left.append(check, dot, name);
    const counter = document.createElement('span');
    counter.className = 'nzf-year-count';
    counter.textContent = spec.count;
    label.append(left, counter);
    return label;
  }
  function renderDepartments() {
    departmentList.replaceChildren();
    for (const dept of departments) {
      const section = document.createElement('section');
      section.className = 'nzf-department';
      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'nzf-department-head';
      const isOpen = expanded.has(dept.id);
      header.setAttribute('aria-expanded', String(isOpen));
      const title = document.createElement('span');
      title.className = 'nzf-department-title';
      title.textContent = dept.title;
      const amount = document.createElement('span');
      amount.className = 'nzf-department-count';
      amount.textContent = dept.years.reduce((n, year) => n + year.count, 0).toLocaleString(LOCALE);
      const chevron = document.createElement('span');
      chevron.className = 'nzf-department-chevron';
      chevron.textContent = isOpen ? '⌄' : '›';
      header.append(title, amount, chevron);
      const body = document.createElement('div');
      body.className = 'nzf-department-body';
      body.hidden = !isOpen;
      header.addEventListener('click', () => {
        const open = body.hidden;
        body.hidden = !open;
        header.setAttribute('aria-expanded', String(open));
        chevron.textContent = open ? '⌄' : '›';
        if (open) expanded.add(dept.id);
        else expanded.delete(dept.id);
      });
      const actions = document.createElement('div');
      actions.className = 'nzf-department-actions';
      for (const [label, state] of [['Все годы', true], ['Скрыть', false]]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => setAll(state, dept.id));
        actions.appendChild(button);
      }
      const yearRows = document.createElement('div');
      yearRows.className = 'nzf-years';
      for (const spec of specs.filter(s => s.departmentId === dept.id).slice().reverse()) {
        yearRows.appendChild(makeYearRow(spec));
      }
      body.append(actions, yearRows);
      section.append(header, body);
      departmentList.appendChild(section);
    }
  }

  async function setAll(enabled, departmentId = null) {
    const subset = specs.filter(s => !departmentId || s.departmentId === departmentId);
    for (const spec of subset) {
      if (enabled) selected.add(spec.key);
      else selected.delete(spec.key);
      const layer = cached.get(spec.key);
      if (layer) {
        if (enabled && !map.hasLayer(layer)) layer.addTo(map);
        else if (!enabled && map.hasLayer(layer)) map.removeLayer(layer);
      }
    }
    departmentList.querySelectorAll('input[data-key]').forEach(input => {
      if (subset.some(s => s.key === input.dataset.key)) input.checked = enabled;
    });
    if (enabled) await Promise.all(subset.filter(s => !cached.has(s.key)).map(loadDataset));
    updateCounts();
    searchResults();
    if (enabled) fitSelected();
  }
  function focusFeature(item) {
    const layer = item.layer;
    if (typeof layer.getBounds === 'function') {
      const b = layer.getBounds();
      if (b.isValid()) map.fitBounds(b, {padding: [50, 50], maxZoom: 12});
    } else if (typeof layer.getLatLng === 'function') map.setView(layer.getLatLng(), 12);
    layer.bindPopup(popupNode(item.feature, item.spec), {maxWidth: 380, minWidth: 230}).openPopup();
    if (window.innerWidth < 681) byId('map').scrollIntoView({behavior: 'smooth', block: 'center'});
  }
  function searchResults() {
    resultsEl.replaceChildren();
    const q = normalize(searchEl.value);
    if (!q) return;
    const matches = [];
    for (const spec of specs) {
      if (!selected.has(spec.key)) continue;
      for (const item of (records.get(spec.key) || [])) {
        const p = item.feature.properties || {};
        if (normalize([p.name, ...Object.values(p.fields || {})].join(' ')).includes(q)) matches.push(item);
        if (matches.length >= 12) break;
      }
      if (matches.length >= 12) break;
    }
    if (!matches.length) {
      const empty = document.createElement('span');
      empty.className = 'nzf-no-result';
      empty.textContent = 'По выбранным отделам и годам ничего не найдено';
      resultsEl.appendChild(empty);
    }
    for (const item of matches) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nzf-result';
      const title = document.createElement('strong');
      title.textContent = item.feature.properties?.name || 'Без названия';
      const small = document.createElement('small');
      small.textContent = `${item.spec.departmentTitle} · ${item.spec.year} · ${item.feature.properties?.fields?.['Вид_работ'] || 'Объект'}`;
      btn.append(title, small);
      btn.addEventListener('click', () => focusFeature(item));
      resultsEl.appendChild(btn);
    }
  }
  async function init() {
    try {
      const response = await fetch(dataUrl('manifest.json'), {cache: 'default'});
      if (!response.ok) throw new Error(`manifest.json: HTTP ${response.status}`);
      const config = await response.json();
      departments = (config.departments || []).filter(dept => dept.id && Array.isArray(dept.years) && dept.years.length);
      specs = departments.flatMap(dept => dept.years.map(y => ({
        ...y, departmentId: dept.id, departmentTitle: dept.title,
        key: `${dept.id}:${y.year}`
      }))).sort((a, b) => a.year - b.year);
      if (!specs.length) throw new Error('В manifest.json нет отделов и годов');
      for (const spec of specs) selected.add(spec.key);
      expanded.add(departments[0].id);
      byId('totalCount').textContent = specs.reduce((a, s) => a + s.count, 0).toLocaleString(LOCALE);
      renderDepartments();
      searchEl.addEventListener('input', searchResults);
      byId('selectAll').addEventListener('click', () => setAll(true));
      byId('selectNone').addEventListener('click', () => setAll(false));
      byId('fitAll').addEventListener('click', fitSelected);
      await Promise.all(specs.map(loadDataset));
      fitSelected();
      updateStatus();
    } catch (e) {
      console.error('Ошибка загрузки карты', e);
      setStatus('Ошибка загрузки карты. Откройте страницу через HTTP(S), а не как файл.');
      departmentList.textContent = 'Не удалось прочитать список данных. Проверьте data/manifest.json.';
    }
  }
  init();
})();
