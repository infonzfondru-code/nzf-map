/* NZF projects map, Yandex Maps JS API 2.1. Data: GitHub Pages. No API key is stored here. */
(function () {
  'use strict';

  var ROOT = 'https://infonzfondru-code.github.io/nzf-map/';
  var host = document.getElementById('nzf-yandex-widget');
  if (!host || host.dataset.nzfStarted === '1') return;
  host.dataset.nzfStarted = '1';

  host.innerHTML = `
    <div class="nzf-app">
      <div class="nzf-header">
        <div>
          <h1>Карта выполненных работ</h1>
        </div>
        <div class="nzf-total"><strong id="nzf-total">—</strong><span>объектов в архиве</span></div>
      </div>
      <div class="nzf-content">
        <aside class="nzf-sidebar">
          <div class="nzf-sidebar-top">
            <h2>Отделы и годы</h2>
            <div class="nzf-quick-actions"><button id="nzf-all" type="button">Все</button> · <button id="nzf-none" type="button">Скрыть</button></div>
          </div>
          <div id="nzf-depts" class="nzf-departments">Загрузка…</div>
          <div id="nzf-status" class="nzf-status" aria-live="polite"></div>
        </aside>
        <section class="nzf-map-frame" style="height:100%;min-height:540px">
          <div id="nzf-yandex-map" style="width:100%;height:100%;min-height:540px"></div>
          <div class="nzf-map-info"><span id="nzf-count">0</span> на карте</div>
          <button id="nzf-fit" class="nzf-map-home" type="button" title="Показать выбранные объекты">⌂</button>
          <div id="nzf-hit-menu" class="nzf-hit-menu" hidden></div>
        </section>
      </div>
    </div>`;

  function $(id) { return host.querySelector('#' + id); }
  function text(value) { return String(value == null ? '' : value); }
  function norm(value) { return text(value).toLocaleLowerCase('ru').replace(/ё/g, 'е'); }
  function safe(value) {
    return text(value).replace(/[&<>"']/g, function (c) {
      return {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c];
    });
  }
  function status(message) {
    var node = $('nzf-status');
    if (node) node.textContent = message || '';
  }

  var pretty = {
    'Вид_работ': 'Вид работ',
    'Год_и_месяц': 'Год и месяц',
    'Контракт_N_договора': 'Контракт / № договора',
    'Площадь_га': 'Площадь, га',
    'Детализация_см_пикс': 'Детализация, см/пикс',
    'Масштаб': 'Масштаб'
  };

  var state = {
    specs: [],
    selected: new Set(),
    layers: new Map(),
    pending: new Map(),
    entries: new Map(),
    visible: new Set(),
    map: null,
    manifestReady: false,
    hitMenuOpen: false,
    ignoreMapClickUntil: 0,
    lastPointer: null
  };

  function balloon(f, spec) {
    var p = f.properties || {};
    var fields = p.fields || {};
    var name = p.name || fields['Название'] || 'Объект';
    var result = '<div style="font-family:inherit;font-size:13px;line-height:1.55;color:#30352e;max-width:360px">' +
      '<div style="font-size:17px;font-weight:600;line-height:1.3;margin-bottom:8px">' + safe(name) + '</div>' +
      '<div style="color:#70816b;margin:0 0 10px">' + safe(spec.department) + ' · ' + spec.year + '</div>' +
      '<table style="border-collapse:collapse">';
    Object.keys(fields).forEach(function (key) {
      var value = fields[key];
      if (value == null || !text(value).trim()) return;
      if (key === 'Название' && norm(value) === norm(name)) return;
      result += '<tr><td style="vertical-align:top;color:#72776f;padding:4px 12px 4px 0">' +
        safe(pretty[key] || key.replace(/_/g, ' ')) + '</td><td style="padding:4px 0">' + safe(value) + '</td></tr>';
    });
    return result + '</table></div>';
  }

  function parts(geom) {
    if (!geom) return [];
    var c = geom.coordinates;
    switch (geom.type) {
      case 'Polygon': return [{ type: 'polygon', coords: c }];
      case 'MultiPolygon': return c.map(function (x) { return { type: 'polygon', coords: x }; });
      case 'LineString': return [{ type: 'line', coords: c }];
      case 'MultiLineString': return c.map(function (x) { return { type: 'line', coords: x }; });
      case 'Point': return [{ type: 'point', coords: c }];
      case 'MultiPoint': return c.map(function (x) { return { type: 'point', coords: x }; });
      case 'GeometryCollection': return (geom.geometries || []).reduce(function (a, g) { return a.concat(parts(g)); }, []);
      default: return [];
    }
  }

  function latlon(p) { return [p[1], p[0]]; }

  function pointInRing(point, ring) {
    var x = point[0], y = point[1], inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1];
      var xj = ring[j][0], yj = ring[j][1];
      var intersect = ((yi > y) !== (yj > y)) &&
        (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointInPolygon(point, rings) {
    if (!rings || !rings.length || !pointInRing(point, rings[0])) return false;
    for (var i = 1; i < rings.length; i++) {
      if (pointInRing(point, rings[i])) return false;
    }
    return true;
  }

  function pointToSegmentDistance(point, a, b) {
    var x = point[0], y = point[1], x1 = a[0], y1 = a[1], x2 = b[0], y2 = b[1];
    var dx = x2 - x1, dy = y2 - y1;
    if (!dx && !dy) return Math.hypot(x - x1, y - y1);
    var t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    var px = x1 + t * dx, py = y1 + t * dy;
    return Math.hypot(x - px, y - py);
  }

  function lineHit(point, coords, tolerance) {
    for (var i = 0; i < coords.length - 1; i++) {
      if (pointToSegmentDistance(point, coords[i], coords[i + 1]) <= tolerance) return true;
    }
    return false;
  }

  function pointHit(point, coords, tolerance) {
    return Math.hypot(point[0] - coords[0], point[1] - coords[1]) <= tolerance;
  }

  function getToleranceDegrees() {
    if (!state.map) return 0.03;
    var zoom = state.map.getZoom ? state.map.getZoom() : 4;
    return Math.max(0.00015, 0.12 / Math.pow(2, Math.max(1, zoom - 3)));
  }

  function featureHit(feature, lonLat) {
    var tolerance = getToleranceDegrees();
    return parts(feature.geometry).some(function (g) {
      if (g.type === 'polygon') return pointInPolygon(lonLat, g.coords);
      if (g.type === 'line') return lineHit(lonLat, g.coords, tolerance);
      return pointHit(lonLat, g.coords, tolerance);
    });
  }

  function openEntry(entry, zoomToObject) {
    if (!entry || !entry.objects || !entry.objects.length) return;
    var obj = entry.objects[0];
    hideHitMenu();
    if (zoomToObject !== false && state.map && obj.geometry && obj.geometry.getBounds) {
      var bounds = obj.geometry.getBounds();
      if (bounds) state.map.setBounds(bounds, { checkZoomRange: true, zoomMargin: 65 });
    }
    if (obj.balloon) obj.balloon.open();
  }

  function hideHitMenu() {
    var menu = $('nzf-hit-menu');
    if (!menu) return;
    menu.hidden = true;
    menu.innerHTML = '';
    state.hitMenuOpen = false;
  }

  function showHitMenu(entries, localPixels) {
    var menu = $('nzf-hit-menu');
    if (!menu) return;
    menu.innerHTML = '';

    var title = document.createElement('div');
    title.className = 'nzf-hit-menu-title';
    title.textContent = 'Выберите объект';
    menu.appendChild(title);

    entries.forEach(function (entry) {
      var p = entry.feature.properties || {};
      var fields = p.fields || {};
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'nzf-hit-item';

      var strong = document.createElement('strong');
      strong.textContent = p.name || fields['Название'] || 'Объект';
      var small = document.createElement('small');
      var attrs = (entry.feature.properties || {}).fields || {};
      var details = [attrs['Вид_работ'], entry.spec.year + ' год', attrs['Площадь_га'] ? attrs['Площадь_га'] + ' га' : ''];
      small.textContent = details.filter(Boolean).join(' · ');

      button.append(strong, small);
      button.addEventListener('click', function () { openEntry(entry, false); });
      menu.appendChild(button);
    });



    var x = 28, y = 28;
    if (localPixels && localPixels.length >= 2) {
      x = localPixels[0] + 14;
      y = localPixels[1] + 10;
    }
    var parent = host.querySelector('.nzf-map-frame');
    if (parent) {
      x = Math.max(10, Math.min(x, parent.clientWidth - 28));
      y = Math.max(10, Math.min(y, parent.clientHeight - 28));
    }

    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.hidden = false;
    state.hitMenuOpen = true;

    requestAnimationFrame(function () {
      var frame = host.querySelector('.nzf-map-frame');
      if (!frame) return;
      var frameRect = frame.getBoundingClientRect();
      var menuRect = menu.getBoundingClientRect();
      var left = x;
      var top = y;
      if (menuRect.right > frameRect.right - 10) left = Math.max(10, x - menuRect.width - 24);
      if (menuRect.bottom > frameRect.bottom - 10) top = Math.max(10, y - menuRect.height - 24);
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
    });
  }

  function recordPointer(e) {
    var frame = host.querySelector('.nzf-map-frame');
    if (!frame) return;
    var rect = frame.getBoundingClientRect();
    state.lastPointer = {
      local: [e.clientX - rect.left, e.clientY - rect.top],
      page: [e.pageX, e.pageY],
      when: Date.now()
    };
  }

  function coordsFromPointer() {
    var p = state.lastPointer;
    if (!p || Date.now() - p.when > 4000 || !state.map) return null;
    try {
      var projection = state.map.options.get('projection');
      var globalPixels = state.map.converter.pageToGlobal(p.page);
      return projection.fromGlobalPixels(globalPixels, state.map.getZoom());
    } catch (err) {
      return null;
    }
  }

  function eventCoordinates(e) {
    var coords = e && e.get && e.get('coords');
    if (Array.isArray(coords) && coords.length >= 2 &&
        Number.isFinite(coords[0]) && Number.isFinite(coords[1])) return coords;
    return coordsFromPointer();
  }

  function eventLocalPixels(e, coords) {
    var p = state.lastPointer;
    if (p && Date.now() - p.when < 4000) return p.local;
    try {
      if (coords && state.map && state.map.converter && typeof state.map.converter.globalToPage === 'function') {
        var projection = state.map.options.get('projection');
        var gp = projection.toGlobalPixels(coords, state.map.getZoom());
        var pp = state.map.converter.globalToPage(gp);
        var r = host.querySelector('.nzf-map-frame').getBoundingClientRect();
        return [pp[0] - window.scrollX - r.left, pp[1] - window.scrollY - r.top];
      }
    } catch (err) {}
    return [24, 24];
  }

  function visibleEntries() {
    var result = [];
    state.selected.forEach(function (key) {
      var list = state.entries.get(key) || [];
      for (var i = 0; i < list.length; i++) result.push(list[i]);
    });
    return result;
  }

  function handleCoordinateClick(coords, localPixels) {
    if (!coords || !coords.length) return;
    var lonLat = [coords[1], coords[0]];
    var hits = [];
    visibleEntries().forEach(function (entry) {
      try {
        if (featureHit(entry.feature, lonLat)) hits.push(entry);
      } catch (err) {
        console.warn('НЗФ: ошибка проверки попадания', err);
      }
    });
    if (!hits.length) {
      hideHitMenu();
      return;
    }
    if (hits.length === 1) {
      openEntry(hits[0], false);
      return;
    }
    hits.sort(function (a, b) {
      var an = ((a.feature.properties || {}).name || '').toLowerCase();
      var bn = ((b.feature.properties || {}).name || '').toLowerCase();
      return an.localeCompare(bn, 'ru');
    });
    showHitMenu(hits, localPixels);
  }

  function makeObjects(feature, spec, entry) {
    var result = [];
    var props = {
      balloonContent: balloon(feature, spec),
      hintContent: null
    };
    var opt = {
      strokeColor: '#419746',
      strokeWidth: 2,
      strokeOpacity: 0.9,
      fillColor: '#4b9b49',
      fillOpacity: 0.17,
      openBalloonOnClick: false,
      openHintOnHover: false
    };

    parts(feature.geometry).forEach(function (g) {
      try {
        var obj;
        if (g.type === 'polygon') obj = new ymaps.Polygon(g.coords.map(function (r) { return r.map(latlon); }), props, opt);
        else if (g.type === 'line') obj = new ymaps.Polyline(g.coords.map(latlon), props, opt);
        else obj = new ymaps.Placemark(latlon(g.coords), props, { preset: 'islands#greenCircleIcon', openBalloonOnClick: false, openHintOnHover: false });

        obj.events.add('click', function (e) {
          state.ignoreMapClickUntil = Date.now() + 250;
          if (e.preventDefault) e.preventDefault();
          var point = eventCoordinates(e);
          handleCoordinateClick(point, eventLocalPixels(e, point));
        });

        result.push(obj);
      } catch (err) {
        console.warn('НЗФ: пропущена геометрия', err);
      }
    });

    entry.objects = result;
    return result;
  }

  async function getJSON(path) {
    var response = await fetch(ROOT + path);
    if (!response.ok) throw new Error(path + ': HTTP ' + response.status);
    return response.json();
  }

  function updateCount() {
    var n = 0;
    state.selected.forEach(function (key) { n += (state.entries.get(key) || []).length; });
    $('nzf-count').textContent = n.toLocaleString('ru-RU');
  }

  function showCollection(spec, layer) {
    if (!state.map) return;
    if (state.selected.has(spec.key) && !state.visible.has(spec.key)) {
      state.map.geoObjects.add(layer);
      state.visible.add(spec.key);
    } else if (!state.selected.has(spec.key) && state.visible.has(spec.key)) {
      state.map.geoObjects.remove(layer);
      state.visible.delete(spec.key);
    }
  }

  async function getLayer(spec) {
    if (state.layers.has(spec.key)) return state.layers.get(spec.key);
    if (state.pending.has(spec.key)) return state.pending.get(spec.key);

    var task = (async function () {
      var fc = await getJSON(spec.file);
      var group = new ymaps.GeoObjectCollection();
      var entries = [];

      for (var i = 0; i < (fc.features || []).length; i++) {
        var f = fc.features[i];
        var entry = { feature: f, objects: [], spec: spec };
        var objects = makeObjects(f, spec, entry);
        objects.forEach(function (obj) { group.add(obj); });
        if (objects.length) entries.push(entry);
      }

      state.layers.set(spec.key, group);
      state.entries.set(spec.key, entries);
      return group;
    })();

    state.pending.set(spec.key, task);
    try { return await task; }
    finally { state.pending.delete(spec.key); }
  }

  async function toggle(spec, on, noFit) {
    if (on) state.selected.add(spec.key);
    else state.selected.delete(spec.key);

    var layer = state.layers.get(spec.key);
    if (!on) {
      if (layer) showCollection(spec, layer);
      updateCount();
      hideHitMenu();
      return;
    }

    if (!state.map) {
      status('Ожидаем подключения Яндекс Карт…');
      return;
    }

    try {
      status('Загрузка объектов за ' + spec.year + ' год…');
      layer = layer || await getLayer(spec);
      showCollection(spec, layer);
      updateCount();
      status('');
      if (!noFit && state.selected.size === 1) fit();
    } catch (err) {
      state.selected.delete(spec.key);
      var c = host.querySelector('input[data-key="' + spec.key + '"]');
      if (c) c.checked = false;
      status('Ошибка загрузки ' + spec.year + ': ' + err.message);
      console.error('НЗФ:', err);
    }
  }

  function fit() {
    if (!state.map) return;
    var loLat = 90, loLon = 180, hiLat = -90, hiLon = -180;
    function include(p) {
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
      var lon = p[0], lat = p[1];
      if (lat < 35 || lat > 79 || lon < 19 || lon > 180) return;
      loLat = Math.min(loLat, lat); hiLat = Math.max(hiLat, lat);
      loLon = Math.min(loLon, lon); hiLon = Math.max(hiLon, lon);
    }
    function scan(node) {
      if (!Array.isArray(node)) return;
      if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') { include(node); return; }
      node.forEach(scan);
    }
    state.selected.forEach(function (key) {
      (state.entries.get(key) || []).forEach(function (r) {
        parts(r.feature.geometry).forEach(function (p) { scan(p.coords); });
      });
    });
    if (loLat <= hiLat) state.map.setBounds([[loLat, loLon], [hiLat, hiLon]], { checkZoomRange: true, zoomMargin: 35 });
    else state.map.setCenter([61, 90], 3);
  }

  function buildMenu(manifest) {
    var list = $('nzf-depts');
    list.replaceChildren();

    (manifest.departments || []).forEach(function (dept) {
      var section = document.createElement('section');
      section.className = 'nzf-department';

      var heading = document.createElement('button');
      heading.type = 'button';
      heading.className = 'nzf-department-head';
      heading.textContent = dept.title;
      heading.setAttribute('aria-expanded', 'true');

      var body = document.createElement('div');
      body.className = 'nzf-department-body';

      var years = document.createElement('div');
      years.className = 'nzf-years';

      (dept.years || []).slice().reverse().forEach(function (year) {
        var spec = Object.assign({}, year, { key: dept.id + ':' + year.year, department: dept.title });
        state.specs.push(spec);

        var label = document.createElement('label');
        label.className = 'nzf-year';

        var left = document.createElement('span');
        left.className = 'nzf-year-left';

        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.key = spec.key;
        cb.addEventListener('change', function () { toggle(spec, cb.checked); });

        var name = document.createElement('span');
        name.className = 'nzf-year-name';
        name.textContent = year.year + ' год';

        var count = document.createElement('span');
        count.className = 'nzf-year-count';
        count.textContent = year.count || 0;

        left.append(cb, name);
        label.append(left, count);
        years.append(label);
      });

      body.append(years);
      section.append(heading, body);
      heading.addEventListener('click', function () {
        body.hidden = !body.hidden;
        heading.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
      });
      list.append(section);
    });

    $('nzf-total').textContent = state.specs.reduce(function (n, s) { return n + (s.count || 0); }, 0).toLocaleString('ru-RU');
    $('nzf-fit').addEventListener('click', fit);

    $('nzf-none').addEventListener('click', function () {
      hideHitMenu();
      host.querySelectorAll('.nzf-year input').forEach(function (input) { input.checked = false; });
      state.specs.forEach(function (spec) { toggle(spec, false, true); });
      status('');
    });

    $('nzf-all').addEventListener('click', async function () {
      hideHitMenu();
      host.querySelectorAll('.nzf-year input').forEach(function (input) { input.checked = true; });
      await Promise.all(state.specs.map(function (spec) { return toggle(spec, true, true); }));
      fit();
    });

    state.manifestReady = true;
  }

  async function initialize() {
    try {
      var manifest = await getJSON('manifest.json');
      buildMenu(manifest);
      status('');
    } catch (err) {
      status('Не удалось загрузить данные: ' + err.message);
      console.error('НЗФ: ошибка manifest.json', err);
      return;
    }

    var attempts = 0;
    var ticker = setInterval(function () {
      if (window.ymaps && typeof window.ymaps.ready === 'function') {
        clearInterval(ticker);
        window.ymaps.ready(function () {
          try {
            state.map = new ymaps.Map(
              'nzf-yandex-map',
              { center: [61, 90], zoom: 3, controls: ['zoomControl', 'typeSelector', 'fullscreenControl'] },
              { suppressMapOpenBlock: true }
            );

            state.map.options.set('openBalloonOnClick', false);
            state.map.options.set('openHintOnHover', false);
            var mapDiv = host.querySelector('#nzf-yandex-map');
            mapDiv.addEventListener('pointerdown', recordPointer, true);
            mapDiv.addEventListener('click', recordPointer, true);

            state.map.events.add('click', function (e) {
              if (Date.now() < state.ignoreMapClickUntil) return;
              var point = eventCoordinates(e);
          handleCoordinateClick(point, eventLocalPixels(e, point));
            });
            state.map.events.add('actionbegin', hideHitMenu);
            document.addEventListener('pointerdown', function (e) {
              if (!host.contains(e.target)) hideHitMenu();
            });
            document.addEventListener('keydown', function (e) {
              if (e.key === 'Escape') hideHitMenu();
            });

            var recent = state.specs.find(function (s) { return s.department === 'Отдел геодезии' && s.year === 2025; });
            if (recent) {
              var checkbox = host.querySelector('input[data-key="' + recent.key + '"]');
              if (checkbox) checkbox.checked = true;
              toggle(recent, true);
            }
          } catch (err) {
            status('Ошибка инициализации карты: ' + err.message);
            console.error('НЗФ: ошибка ymaps.Map', err);
          }
        });
      } else if (++attempts >= 120) {
        clearInterval(ticker);
        status('API Яндекс Карт не появился на этой странице.');
      }
    }, 250);
  }

  initialize();
})();
