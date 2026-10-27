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
        <div><div class="nzf-kicker">НЗФ · География проектов</div>
          <h1>Карта выполненных работ</h1>
          <p>Выберите отдел и год. Нажмите на объект, чтобы посмотреть информацию о проекте.</p>
        </div>
        <div class="nzf-total"><strong id="nzf-total">—</strong><span>объектов в архиве</span></div>
      </div>
      <div class="nzf-content">
        <aside class="nzf-sidebar">
          <div class="nzf-sidebar-top"><h2>Отделы и годы</h2>
            <div class="nzf-quick-actions"><button id="nzf-all" type="button">Все</button> · <button id="nzf-none" type="button">Скрыть</button></div>
          </div>
          <div id="nzf-depts" class="nzf-departments">Загрузка списка годов…</div>
          <div class="nzf-divider"></div>
          <label class="nzf-search-label" for="nzf-search">Найти объект</label>
          <input id="nzf-search" class="nzf-search" type="search" placeholder="Название, договор, вид работ">
          <div id="nzf-results" class="nzf-search-results"></div>
          <div id="nzf-status" class="nzf-bottom-state" role="status">Подготовка карты…</div>
        </aside>
        <section class="nzf-map-frame" style="height:100%;min-height:540px">
          <div id="nzf-yandex-map" style="width:100%;height:100%;min-height:540px"></div>
          <div class="nzf-map-info"><span id="nzf-count">0</span> на карте</div>
          <button id="nzf-fit" class="nzf-map-home" type="button" title="Приблизить к выбранным объектам">⌂</button>
        </section>
      </div>
    </div>`;

  function $(id) { return host.querySelector('#' + id); }
  function status(message) { $('nzf-status').textContent = message; }
  function text(value) { return String(value == null ? '' : value); }
  function norm(value) { return text(value).toLocaleLowerCase('ru').replace(/ё/g, 'е'); }
  function safe(value) {
    return text(value).replace(/[&<>"']/g, function (c) {
      return {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c];
    });
  }
  var pretty = {
    'Вид_работ':'Вид работ', 'Год_и_месяц':'Год и месяц',
    'Контракт_N_договора':'Контракт / № договора', 'Площадь_га':'Площадь, га',
    'Детализация_см_пикс':'Детализация, см/пикс', 'Масштаб':'Масштаб'
  };
  var state = {
    specs: [], selected: new Set(), layers: new Map(), pending: new Map(),
    entries: new Map(), visible: new Set(), map: null, manifestReady: false
  };

  function balloon(f, spec) {
    var p = f.properties || {};
    var fields = p.fields || {};
    var name = p.name || fields['Название'] || 'Объект';
    var result = '<div style="font:13px/1.5 Arial,sans-serif;max-width:350px">' +
      '<b style="font-size:15px">' + safe(name) + '</b>' +
      '<div style="color:#637989;margin:6px 0 10px">' + safe(spec.department) + ' · ' + spec.year + '</div>' +
      '<table style="border-collapse:collapse">';
    Object.keys(fields).forEach(function (key) {
      var value = fields[key];
      if (value == null || !text(value).trim()) return;
      if (key === 'Название' && norm(value) === norm(name)) return;
      result += '<tr><td style="vertical-align:top;color:#687f8e;padding:4px 12px 4px 0">' +
        safe(pretty[key] || key.replace(/_/g, ' ')) + '</td><td style="padding:4px 0">' + safe(value) + '</td></tr>';
    });
    return result + '</table></div>';
  }

  function parts(geom) {
    if (!geom) return [];
    var c = geom.coordinates;
    switch (geom.type) {
      case 'Polygon': return [{type:'polygon', coords:c}];
      case 'MultiPolygon': return c.map(function (x) {return {type:'polygon', coords:x};});
      case 'LineString': return [{type:'line', coords:c}];
      case 'MultiLineString': return c.map(function (x) {return {type:'line', coords:x};});
      case 'Point': return [{type:'point', coords:c}];
      case 'MultiPoint': return c.map(function (x) {return {type:'point', coords:x};});
      case 'GeometryCollection': return (geom.geometries || []).reduce(function (a,g) {return a.concat(parts(g));}, []);
      default: return [];
    }
  }
  function latlon(p) { return [p[1], p[0]]; }

  function makeObjects(feature, spec) {
    var result = [];
    var props = {balloonContent: balloon(feature, spec), hintContent: (feature.properties || {}).name || 'Объект'};
    var opt = {strokeColor:spec.color || '#2771b4', strokeWidth:2, strokeOpacity:.9,
      fillColor:spec.color || '#2771b4', fillOpacity:.27};
    parts(feature.geometry).forEach(function (g) {
      try {
        var obj;
        if (g.type === 'polygon') obj = new ymaps.Polygon(g.coords.map(function (r) {return r.map(latlon);}), props, opt);
        else if (g.type === 'line') obj = new ymaps.Polyline(g.coords.map(latlon), props, opt);
        else obj = new ymaps.Placemark(latlon(g.coords), props, {preset:'islands#blueCircleIcon'});
        result.push(obj);
      } catch (err) { console.warn('НЗФ: пропущена геометрия', err); }
    });
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
      state.map.geoObjects.add(layer); state.visible.add(spec.key);
    } else if (!state.selected.has(spec.key) && state.visible.has(spec.key)) {
      state.map.geoObjects.remove(layer); state.visible.delete(spec.key);
    }
  }

  async function getLayer(spec) {
    if (state.layers.has(spec.key)) return state.layers.get(spec.key);
    if (state.pending.has(spec.key)) return state.pending.get(spec.key);
    var task = (async function () {
      var fc = await getJSON(spec.file);
      var group = new ymaps.GeoObjectCollection();
      var entries = [];
      for (var f of fc.features || []) {
        var objects = makeObjects(f, spec);
        objects.forEach(function (obj) { group.add(obj); });
        if (objects.length) entries.push({feature:f, objects:objects, spec:spec});
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
      updateCount(); search(); return;
    }
    if (!state.map) { status('Ожидаем подключения Яндекс Карт…'); return; }
    try {
      status('Загрузка объектов за ' + spec.year + ' год…');
      layer = layer || await getLayer(spec);
      showCollection(spec, layer);
      updateCount(); search();
      status('Данные загружены. Нажмите на полигон для просмотра семантики.');
      if (!noFit && state.selected.size === 1) fit();
    } catch (err) {
      state.selected.delete(spec.key);
      var c = host.querySelector('input[data-key="' + spec.key + '"]');
      if (c) c.checked = false;
      status('Ошибка загрузки ' + spec.year + ': ' + err.message);
      console.error('НЗФ:', err);
    }
  }

  // Only use plausible Russian geographic coordinates to calculate an overview.
  function fit() {
    if (!state.map) return;
    var loLat=90, loLon=180, hiLat=-90, hiLon=-180;
    function include(p) {
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
      var lon=p[0], lat=p[1];
      if (lat<35 || lat>79 || lon<19 || lon>180) return;
      loLat=Math.min(loLat,lat); hiLat=Math.max(hiLat,lat);
      loLon=Math.min(loLon,lon); hiLon=Math.max(hiLon,lon);
    }
    function scan(node) {
      if (!Array.isArray(node)) return;
      if (node.length>=2 && typeof node[0]==='number' && typeof node[1]==='number') { include(node); return; }
      node.forEach(scan);
    }
    state.selected.forEach(function (key) {
      (state.entries.get(key) || []).forEach(function (r) {
        parts(r.feature.geometry).forEach(function (p) { scan(p.coords); });
      });
    });
    if (loLat <= hiLat) {
      state.map.setBounds([[loLat,loLon],[hiLat,hiLon]], {checkZoomRange:true, zoomMargin:35});
    } else state.map.setCenter([61,90],3);
  }

  function search() {
    var container = $('nzf-results'); container.replaceChildren();
    var query = norm($('nzf-search').value.trim());
    if (!query) return;
    var found=0;
    state.selected.forEach(function (key) {
      (state.entries.get(key) || []).some(function (r) {
        if (found >= 12) return true;
        var p=r.feature.properties || {};
        if (!norm([p.name].concat(Object.values(p.fields || {})).join(' ')).includes(query)) return false;
        found++;
        var btn=document.createElement('button'); btn.type='button'; btn.className='nzf-result';
        var title=document.createElement('strong'); title.textContent=p.name || 'Объект';
        var subtitle=document.createElement('small'); subtitle.textContent=r.spec.department+' · '+r.spec.year;
        btn.append(title,subtitle);
        btn.addEventListener('click',function () {
          var obj=r.objects[0];
          var b=obj.geometry && obj.geometry.getBounds && obj.geometry.getBounds();
          if (b) state.map.setBounds(b,{checkZoomRange:true,zoomMargin:65});
          if (obj.balloon) obj.balloon.open();
        });
        container.appendChild(btn); return false;
      });
    });
    if (!found) container.textContent='Ничего не найдено среди выбранных годов';
  }

  function buildMenu(manifest) {
    var list=$('nzf-depts'); list.replaceChildren();
    (manifest.departments || []).forEach(function (dept) {
      var section=document.createElement('section'); section.className='nzf-department';
      var heading=document.createElement('button'); heading.type='button';
      heading.className='nzf-department-head'; heading.textContent=dept.title+' ▾';
      var body=document.createElement('div'); body.className='nzf-department-body';
      var years=document.createElement('div'); years.className='nzf-years';
      (dept.years || []).slice().reverse().forEach(function (year) {
        var spec=Object.assign({},year,{key:dept.id+':'+year.year, department:dept.title});
        state.specs.push(spec);
        var label=document.createElement('label'); label.className='nzf-year';
        var cb=document.createElement('input'); cb.type='checkbox'; cb.dataset.key=spec.key;
        cb.addEventListener('change',function () { toggle(spec, cb.checked); });
        var name=document.createElement('span'); name.className='nzf-year-name';
        name.textContent=year.year+' год ('+(year.count || 0)+')';
        label.append(cb,name); years.append(label);
      });
      body.append(years); section.append(heading,body);
      heading.addEventListener('click',function () { body.hidden=!body.hidden; });
      list.append(section);
    });
    $('nzf-total').textContent=state.specs.reduce(function (n,s) {return n+(s.count || 0);},0).toLocaleString('ru-RU');
    $('nzf-search').addEventListener('input',search);
    $('nzf-fit').addEventListener('click',fit);
    $('nzf-none').addEventListener('click',function () {
      host.querySelectorAll('.nzf-year input').forEach(function (input) {input.checked=false;});
      state.specs.forEach(function (spec) {toggle(spec,false,true);});
      status('Все годы скрыты');
    });
    $('nzf-all').addEventListener('click',async function () {
      host.querySelectorAll('.nzf-year input').forEach(function (input) {input.checked=true;});
      await Promise.all(state.specs.map(function (spec) {return toggle(spec,true,true);})); fit();
    });
    state.manifestReady=true;
  }

  async function initialize() {
    try {
      var manifest=await getJSON('manifest.json');
      buildMenu(manifest);
      status('Список годов загружен. Подключение Яндекс Карт…');
    } catch (err) {
      status('Не удалось загрузить годы с GitHub: '+err.message);
      console.error('НЗФ: ошибка manifest.json',err);
      return;
    }
    var attempts=0;
    var ticker=setInterval(function () {
      if (window.ymaps && typeof window.ymaps.ready==='function') {
        clearInterval(ticker);
        window.ymaps.ready(function () {
          try {
            state.map = new ymaps.Map('nzf-yandex-map',
              {center:[61,90],zoom:3,controls:['zoomControl','typeSelector','fullscreenControl']},
              {suppressMapOpenBlock:true});
            status('Карта готова. Выберите год.');
            // Show the most recent year by default; other years are loaded on demand.
            var recent=state.specs.find(function (s) {return s.department==='Отдел геодезии' && s.year===2025;});
            if (recent) {
              var checkbox=host.querySelector('input[data-key="'+recent.key+'"]');
              if (checkbox) checkbox.checked=true;
              toggle(recent,true);
            }
          } catch (err) {
            status('Ошибка инициализации Яндекс Карт: '+err.message);
            console.error('НЗФ: ошибка ymaps.Map',err);
          }
        });
      } else if (++attempts >= 120) {
        clearInterval(ticker);
        status('API Яндекс Карт не появился на этой странице. Проверьте, что на НЗФ включён API 2.1.');
      }
    },250);
  }
  initialize();
})();
