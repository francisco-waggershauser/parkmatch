{
'use strict';
/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LS = {
  get(k, d){ try{ const v = localStorage.getItem('pm_'+k); return v == null ? d : JSON.parse(v); }catch{ return d; } },
  set(k, v){ try{ localStorage.setItem('pm_'+k, JSON.stringify(v)); }catch{} }
};
const rid = n => Math.random().toString(36).slice(2, 2+n).padEnd(n, '0');
const now = () => Date.now();
const vib = p => { try{ navigator.vibrate && navigator.vibrate(p); }catch{} };

const COST = 10, START_POINTS = 50, NEAR_M = 40, RADIUS_M = 3000, NOTIFY_M = 1000;
const TOPIC = 'parkmatch-mvp-x7k2/v1/all';
const QB = new URLSearchParams(location.search).get('broker');
const BROKERS = QB && /^wss?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(QB) ? [QB] : ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
const COLORS = [['Schwarz','#111418'],['Weiß','#f2f4f7'],['Silber','#b8bec6'],['Grau','#6b7280'],['Blau','#2563eb'],['Rot','#dc2626'],['Grün','#16a34a'],['Gelb','#eab308'],['Orange','#f97316'],['Braun','#7c4a2a']];
const LIGHT = ['#f2f4f7','#b8bec6','#eab308'];

const ME = {
  id: LS.get('id', null) || rid(10),
  car: LS.get('car', null),
  points: LS.get('points', START_POINTS),
  rep: LS.get('rep', {up:0, down:0})
};
LS.set('id', ME.id);

/* ---------- geo ---------- */
const R = Math.PI/180;
function dist(a, b){
  const dLat = (b.lat-a.lat)*R, dLng = (b.lng-a.lng)*R;
  const h = Math.sin(dLat/2)**2 + Math.cos(a.lat*R)*Math.cos(b.lat*R)*Math.sin(dLng/2)**2;
  return 2*6371e3*Math.asin(Math.min(1, Math.sqrt(h)));
}
function offset(p, m, deg){
  const r = deg*R;
  return {lat: p.lat + m*Math.cos(r)/111320, lng: p.lng + m*Math.sin(r)/(111320*Math.cos(p.lat*R))};
}
function stepTo(a, b, m){
  const d = dist(a, b); if (d <= m) return {lat:b.lat, lng:b.lng};
  const f = m/d; return {lat: a.lat+(b.lat-a.lat)*f, lng: a.lng+(b.lng-a.lng)*f};
}
/* ---------- routing over real streets (OSRM, OpenStreetMap) ---------- */
const OSRM = 'https://router.project-osrm.org';
async function osrm(path){
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 7000);
  try{ const r = await fetch(OSRM + path, {signal: ctl.signal}); if (!r.ok) throw new Error('osrm ' + r.status); return await r.json(); }
  finally{ clearTimeout(t); }
}
const ll = p => p.lng.toFixed(6) + ',' + p.lat.toFixed(6);
async function getRoute(a, b){
  try{
    const j = await osrm(`/route/v1/driving/${ll(a)};${ll(b)}?overview=full&geometries=geojson`);
    const r = j.routes && j.routes[0];
    if (!r || !r.geometry || !r.geometry.coordinates.length) throw new Error('no route');
    const pts = r.geometry.coordinates.map(c => ({lat: c[1], lng: c[0]}));
    if (dist(a, pts[0]) > 2) pts.unshift({lat: a.lat, lng: a.lng});
    if (dist(b, pts[pts.length-1]) > 2) pts.push({lat: b.lat, lng: b.lng});
    return {pts, dist: r.distance, dur: r.duration, road: true};
  }catch{ return {pts: [{lat: a.lat, lng: a.lng}, {lat: b.lat, lng: b.lng}], dist: dist(a, b), dur: null, road: false}; }
}
/* snap a point onto the nearest drivable street; null if no street nearby, undefined if the service is unreachable */
async function snapToRoad(p){
  try{
    const j = await osrm(`/nearest/v1/driving/${ll(p)}?number=1`);
    const w = j.waypoints && j.waypoints[0];
    if (!w || w.distance > 120) return null;
    return {lat: w.location[1], lng: w.location[0]};
  }catch{ return undefined; }
}
/* walks along a polyline, meter by meter */
function walker(pts){
  let i = 0, p = {...pts[0]};
  return {
    step(m){
      while (m > 0 && i < pts.length-1){
        const nx = pts[i+1], d = dist(p, nx);
        if (d <= m){ m -= d; p = {...nx}; i++; } else { p = stepTo(p, nx, m); m = 0; }
      }
      return p;
    },
    get done(){ return i >= pts.length-1; }
  };
}
/* remaining part of a route as seen from point o */
function remaining(route, o){
  const pts = route.pts; let k = 0, best = Infinity;
  for (let i = 0; i < pts.length; i++){ const d = dist(o, pts[i]); if (d < best){ best = d; k = i; } }
  // if we are already past the nearest vertex, start from the next one
  if (k < pts.length-1 && dist(o, pts[k+1]) < dist(pts[k], pts[k+1])) k++;
  const rest = [o, ...pts.slice(k)];
  let len = 0; for (let i = 0; i < rest.length-1; i++) len += dist(rest[i], rest[i+1]);
  return {coords: rest.map(p => [p.lng, p.lat]), len, off: best};
}
const fmtD = d => d < 1000 ? (Math.max(10, Math.round(d/10)*10)) + ' m' : (d/1000).toFixed(1).replace('.', ',') + ' km';
const etaMin = d => Math.max(1, Math.round(d/400));          // ca. 24 km/h Stadtverkehr
const fmtT = ms => { if (ms <= 0) return 'jetzt'; const s = Math.round(ms/1000); return Math.floor(s/60) + ':' + String(s%60).padStart(2, '0'); };
const repTxt = r => { const n = (r?.up||0)+(r?.down||0); return n ? Math.round(100*r.up/n) + ' % positiv' : 'neu dabei'; };
const colorName = hex => (COLORS.find(c => c[1] === hex) || ['Auto'])[0];
const ADJ = {'Schwarz':'Schwarzes','Weiß':'Weißes','Silber':'Silbernes','Grau':'Graues','Blau':'Blaues','Rot':'Rotes','Grün':'Grünes','Gelb':'Gelbes','Orange':'Oranges','Braun':'Braunes'};
const carTxt = car => car ? (ADJ[colorName(car.color)] || 'Ein') + ' Auto' : 'Auto';

/* ---------- state ---------- */
let pos = null;                    // my position {lat,lng}
let gpsOk = false;
let manual = LS.get('manual', false);   // set position by tapping the map
let demo = false;
let S = { mode: ME.car ? 'idle' : 'onboard' };
const offers = new Map();          // id -> {id,lat,lng,leaveAt,car,rep,seen}
let myOffer = null;                // {lat,lng,leaveAt}
let match = null;                  // {mid, role, peer:{id,car,rep,pos,last}, spot, meOk, peerOk}
let pending = null;                // {mid, offer, t}
let selId = null;
let drive = null;                  // simulated driving timer

/* ---------- map ---------- */
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  center: [10.45, 51.16], zoom: 5, attributionControl: false, pitchWithRotate: false, dragRotate: false
});
map.addControl(new maplibregl.AttributionControl({compact: true}), 'top-left');
map.touchZoomRotate.disableRotation();
let mapReady = false;
map.on('load', () => {
  mapReady = true;
  map.addSource('route', {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
  map.addLayer({id: 'route-glow', type: 'line', source: 'route', paint: {'line-color': '#2f6bff', 'line-width': 10, 'line-opacity': .25, 'line-blur': 4}});
  map.addLayer({id: 'route', type: 'line', source: 'route', layout: {'line-cap': 'round'}, paint: {'line-color': '#6d9bff', 'line-width': 3.5, 'line-dasharray': [1.5, 1.5]}});
  map.addSource('near', {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
  map.addLayer({id: 'near', type: 'fill', source: 'near', paint: {'fill-color': '#2fd27a', 'fill-opacity': .12}});
  drawLine();
});
/* if the basemap cannot load (offline, blocked), fall back to a plain dark style so the camera and markers keep working */
const FALLBACK = {version: 8, sources: {}, layers: [{id: 'bg', type: 'background', paint: {'background-color': '#111821'}}]};
let fellBack = false;
const fallBack = () => { if (!mapReady && !fellBack){ fellBack = true; try{ map.setStyle(FALLBACK); }catch{} } };
map.on('error', e => { if (!map.isStyleLoaded()) fallBack(); });
setTimeout(fallBack, 9000);
if (/[?&]debug/.test(location.search)) window.__pm = {map};

/* smooth markers: each eases toward its target every frame */
const marks = new Map();
function mark(key, html, cls, p, onClick){
  let m = marks.get(key);
  if (!m){
    const el = document.createElement('div');
    el.className = 'mk ' + cls;
    el.innerHTML = html;
    if (onClick) el.addEventListener('click', e => { e.stopPropagation(); onClick(); });
    const mk = new maplibregl.Marker({element: el, anchor: cls.includes('pin') ? 'bottom' : 'center'}).setLngLat([p.lng, p.lat]).addTo(map);
    m = {mk, el, cur: {...p}, tgt: {...p}, html, cls};
    marks.set(key, m);
  } else {
    m.tgt = {...p};
    if (m.html !== html){ m.el.innerHTML = html; m.html = html; }
    if (m.cls !== cls){
      const tok = x => x.split(' ').filter(Boolean);
      if (m.cls) m.el.classList.remove(...tok(m.cls));
      if (cls) m.el.classList.add(...tok(cls));
      m.cls = cls;
    }
  }
  return m;
}
function unmark(key){ const m = marks.get(key); if (m){ m.mk.remove(); marks.delete(key); } }
(function frame(){
  for (const m of marks.values()){
    const dl = m.tgt.lat - m.cur.lat, dg = m.tgt.lng - m.cur.lng;
    if (Math.abs(dl) > 1e-8 || Math.abs(dg) > 1e-8){
      m.cur.lat += dl*.12; m.cur.lng += dg*.12;
      m.mk.setLngLat([m.cur.lng, m.cur.lat]);
    }
  }
  requestAnimationFrame(frame);
})();

const carSvg = '<svg viewBox="0 0 24 24"><path d="M5 16V11l2-5h10l2 5v5M5 16h14M5 16v2M19 16v2M7 13h1M16 13h1"/></svg>';
function circle(c, m){
  const pts = []; for (let i = 0; i <= 48; i++) { const p = offset(c, m, i*7.5); pts.push([p.lng, p.lat]); }
  return {type: 'Feature', geometry: {type: 'Polygon', coordinates: [pts]}};
}
/* the route always runs from the seeker (driving) to the spot */
function routeEnds(){
  if (!match || !pos) return null;
  if (match.role === 'seeker') return {from: pos, to: match.spot};
  return match.peer.pos ? {from: match.peer.pos, to: match.spot} : null;
}
let routing = false;
async function refreshRoute(force){
  const e = routeEnds(); if (!e || routing) return;
  const r = match.route;
  const stale = !r || force || (r.road && remaining(r, e.from).off > 60) || (!r.road && now() - r.t > 20000);
  if (!stale) return;
  routing = true;
  const mid = match.mid;
  const nr = await getRoute(e.from, e.to);
  routing = false;
  if (match && match.mid === mid){ nr.t = now(); match.route = nr; drawLine(); live(); }
}
function routeLeft(){
  const e = routeEnds(); if (!e) return null;
  if (match.route && match.route.road) return remaining(match.route, e.from);
  return {coords: [[e.from.lng, e.from.lat], [e.to.lng, e.to.lat]], len: dist(e.from, e.to), off: 0};
}
function drawLine(){
  if (!mapReady) return;
  const rl = routeLeft();
  const f = rl ? [{type: 'Feature', geometry: {type: 'LineString', coordinates: rl.coords}}] : [];
  try{ map.setPaintProperty('route', 'line-dasharray', match && match.route && match.route.road ? [1, 0] : [1.5, 1.5]); }catch{}
  map.getSource('route').setData({type: 'FeatureCollection', features: f});
  const spot = match ? (match.role === 'seeker' ? match.spot : myOffer || pos) : null;
  map.getSource('near').setData({type: 'FeatureCollection', features: spot ? [circle(spot, NEAR_M)] : []});
}
function drawMarkers(){
  if (pos) mark('me', '', 'me' + (manual || demo ? ' man' : ''), pos).el.style.zIndex = 5;
  // offers (only while searching or idle)
  const showOffers = ['idle', 'searching', 'claiming'].includes(S.mode);
  for (const k of [...marks.keys()]) if (k.startsWith('o:') && (!showOffers || !offers.has(k.slice(2)))) unmark(k);
  if (showOffers) for (const o of offers.values()){
    const mins = Math.max(0, Math.ceil((o.leaveAt - now())/60000));
    const isNew = !marks.has('o:'+o.id);
    const m = mark('o:'+o.id, `<div class="h">P</div><div class="s"></div><span class="m">${mins ? mins + ' Min' : 'jetzt'}</span>`, 'pin' + (selId === o.id ? ' sel' : '') + (isNew ? ' new' : ''), o, () => { if (S.mode === 'idle') setMode('searching'); select(o.id); });
    m.el.style.zIndex = selId === o.id ? 3 : 1;
  }
  // my own offer
  if (S.mode === 'offering' && myOffer) mark('mine', '<div class="h">P</div><div class="s"></div>', 'pin mine', myOffer); else if (!(match && match.role === 'leaver')) unmark('mine');
  // match
  if (match){
    if (match.role === 'seeker') mark('spot', '<div class="h">P</div><div class="s"></div>', 'pin sel', match.spot);
    if (match.peer.pos){
      const col = match.peer.car?.color || '#2f6bff';
      mark('peer', `<div class="car${LIGHT.includes(col) ? ' light' : ''}" style="background:${esc(col)}">${carSvg}</div>`, '', match.peer.pos);
    }
  } else { unmark('spot'); unmark('peer'); }
  drawLine();
}
let followed = false;
function center(force){
  if (!pos) return;
  if (match && match.peer.pos){
    const t = match.role === 'seeker' ? match.spot : match.peer.pos;
    const b = new maplibregl.LngLatBounds([pos.lng, pos.lat], [pos.lng, pos.lat]).extend([t.lng, t.lat]);
    map.setPadding({top: 0, bottom: 0, left: 0, right: 0}); map.fitBounds(b, {padding: {top: 120, bottom: sheetH() + 40, left: 60, right: 60}, maxZoom: 17, duration: 900});
  } else map.easeTo({center: [pos.lng, pos.lat], zoom: Math.max(map.getZoom(), 15.5), padding: {bottom: sheetH()}, duration: force ? 900 : 600});
}
function fitOffers(){
  if (!pos) return;
  const b = new maplibregl.LngLatBounds([pos.lng, pos.lat], [pos.lng, pos.lat]);
  sortedOffers().slice(0, 5).forEach(o => b.extend([o.lng, o.lat]));
  map.setPadding({top: 0, bottom: 0, left: 0, right: 0}); map.fitBounds(b, {padding: {top: 110, bottom: sheetH() + 50, left: 50, right: 50}, maxZoom: 16, duration: 900});
}
const sheetH = () => Math.min($('#sheet').offsetHeight, innerHeight*.6);

/* ---------- position ---------- */
function setPos(p, src){
  if (src === 'gps' && (manual || demo) && pos) return;    // simulated position wins
  const first = !pos;
  pos = {lat: p.lat, lng: p.lng};
  drawMarkers(); live();
  if (match) sendPos(true);
  if (first){ map.jumpTo({center: [pos.lng, pos.lat], zoom: 15.5}); setTimeout(() => center(true), 50); }
}
function startGps(){
  if (!('geolocation' in navigator)) return gpsFail('Dein Browser kann keinen Standort liefern.');
  navigator.geolocation.watchPosition(
    g => { gpsOk = true; hideBanner(); setPos({lat: g.coords.latitude, lng: g.coords.longitude}, 'gps'); },
    e => gpsFail(e.code === 1 ? 'Standortfreigabe abgelehnt.' : 'Standort gerade nicht verfügbar.'),
    {enableHighAccuracy: true, maximumAge: 2000, timeout: 15000}
  );
}
function gpsFail(msg){
  if (gpsOk || manual || demo) return;
  banner(msg + ' Tippe auf die Karte, um deinen Standort zu setzen.');
  manual = true; render();
}
map.on('click', e => {
  if (!(manual || demo)) return;
  if (drive) return;
  setPos({lat: e.lngLat.lat, lng: e.lngLat.lng}, 'manual');
  hideBanner();
});

/* simulated driving toward a target, 14 m/s */
async function driveTo(target){
  stopDrive();
  drive = 'routing'; render();
  const mid = match && match.mid;
  await refreshRoute(true);
  if (drive !== 'routing' || !match || match.mid !== mid){ return; }
  const w = walker(remaining(match.route, pos).coords.map(c => ({lng: c[0], lat: c[1]})));
  drive = setInterval(() => {
    if (!pos || !match){ stopDrive(); return; }
    pos = w.step(2.6);                     // 13 m/s, ca. 47 km/h
    drawMarkers(); live(); sendPos();
    if (w.done) stopDrive();
  }, 200);
  render();
}
function stopDrive(){ if (drive){ if (drive !== 'routing') clearInterval(drive); drive = null; render(); } }

/* ---------- network ---------- */
let client = null, bi = 0, netState = 'connecting';
function setNet(s){
  netState = s;
  const el = $('#net');
  el.className = 'pill ' + (demo ? 'demo' : s === 'live' ? 'live' : s === 'off' ? 'off' : '');
  el.querySelector('span').textContent = demo ? 'Demo' : s === 'live' ? 'live' : s === 'off' ? 'offline' : 'verbinde';
}
function connect(){
  if (!window.mqtt){ setNet('off'); return; }
  const url = BROKERS[bi % BROKERS.length];
  setNet('connecting');
  let ok = false;
  const c = mqtt.connect(url, {clientId: 'pm_' + ME.id + '_' + rid(4), keepalive: 30, reconnectPeriod: 0, connectTimeout: 8000, clean: true});
  client = c;
  c.on('connect', () => { ok = true; setNet('live'); c.subscribe(TOPIC, {qos: 0}); if (S.mode === 'offering') sendOffer(); });
  c.on('message', (t, buf) => {
    if (demo) return;
    let m; try{ m = JSON.parse(buf.toString()); }catch{ return; }
    if (!m || typeof m !== 'object' || m.from === ME.id) return;
    onMsg(m);
  });
  c.on('error', () => {});
  c.on('close', () => {
    if (client !== c) return;
    client = null; try{ c.end(true); }catch{}
    if (!ok) bi++;
    setNet('connecting');
    setTimeout(connect, ok ? 1500 : 600);
  });
}
function send(m){
  m.from = ME.id; m.v = 1;
  if (demo){ sim.recv(m); return; }
  if (client && client.connected) client.publish(TOPIC, JSON.stringify(m), {qos: 0});
}
const num = x => typeof x === 'number' && isFinite(x);
const okPos = m => num(m.lat) && num(m.lng) && Math.abs(m.lat) <= 90 && Math.abs(m.lng) <= 180;
const cleanCar = c => c && typeof c === 'object' ? {color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#6b7280', plate: String(c.plate || '').slice(0, 12)} : null;
const cleanRep = r => r && typeof r === 'object' ? {up: Math.max(0, +r.up || 0), down: Math.max(0, +r.down || 0)} : {up: 0, down: 0};

function onMsg(m){
  if (m.to && m.to !== ME.id) return;
  switch (m.t){
    case 'offer': {
      if (!okPos(m) || !num(m.inSec) || m.from === ME.id) return;
      if (pos && dist(pos, m) > RADIUS_M) return;
      const isNew = !offers.has(m.from);
      offers.set(m.from, {id: m.from, lat: m.lat, lng: m.lng, leaveAt: now() + Math.min(m.inSec, 1800)*1000, car: cleanCar(m.car), rep: cleanRep(m.rep), seen: now()});
      if (isNew && pos && dist(pos, m) <= NOTIFY_M && ['idle', 'searching'].includes(S.mode)){
        toast('Neue Lücke ' + fmtD(dist(pos, m)) + ' entfernt'); vib(60);
      }
      offersChanged(); break;
    }
    case 'withdraw': if (offers.delete(m.from)){ if (selId === m.from) selId = null; offersChanged(); } break;
    case 'claim': {
      if (S.mode === 'offering' && myOffer && !match && m.mid){
        match = {mid: String(m.mid), role: 'leaver', spot: {...myOffer}, meOk: false, peerOk: false,
          peer: {id: m.from, car: cleanCar(m.car), rep: cleanRep(m.rep), pos: okPos(m) ? {lat: m.lat, lng: m.lng} : null, last: now()}};
        send({t: 'accept', to: m.from, mid: match.mid, lat: myOffer.lat, lng: myOffer.lng, car: ME.car, rep: ME.rep});
        send({t: 'withdraw'});
        vib([80, 60, 80]); toast('Match! Jemand kommt zu deiner Lücke.');
        setMode('matched'); keepAwake(true); refreshRoute(true); setTimeout(() => center(true), 100);
      } else send({t: 'reject', to: m.from, mid: m.mid});
      break;
    }
    case 'accept': {
      if (S.mode === 'claiming' && pending && m.mid === pending.mid){
        const o = pending.offer;
        match = {mid: pending.mid, role: 'seeker', spot: {lat: o.lat, lng: o.lng}, meOk: false, peerOk: false,
          peer: {id: m.from, car: cleanCar(m.car) || o.car, rep: cleanRep(m.rep), pos: okPos(m) ? {lat: m.lat, lng: m.lng} : {lat: o.lat, lng: o.lng}, last: now()}};
        pending = null; offers.delete(o.id);
        vib([80, 60, 80]); toast('Match! Die Lücke ist für dich reserviert.');
        setMode('matched'); keepAwake(true); sendPos(true); refreshRoute(true); setTimeout(() => center(true), 100);
      }
      break;
    }
    case 'reject':
      if (S.mode === 'claiming' && pending && m.mid === pending.mid){ offers.delete(pending.offer.id); pending = null; toast('Diese Lücke ist schon vergeben.'); setMode('searching'); }
      break;
    case 'pos':
      if (match && m.mid === match.mid && m.from === match.peer.id && okPos(m)){
        match.peer.pos = {lat: m.lat, lng: m.lng}; match.peer.last = now();
        drawMarkers(); live();
      }
      break;
    case 'confirm':
      if (match && m.mid === match.mid && m.from === match.peer.id){
        if (okPos(m)){ match.peer.pos = {lat: m.lat, lng: m.lng}; match.peer.last = now(); }
        match.peerOk = true; vib(40); checkDone(); render(); drawMarkers();
      }
      break;
    case 'cancel':
      if (match && m.mid === match.mid && m.from === match.peer.id){
        toast('Der andere Fahrer hat abgebrochen.'); vib(200); endMatch();
      }
      break;
    case 'rate':
      if (m.to === ME.id && (m.r === 1 || m.r === -1)){
        if (m.r === 1) ME.rep.up++; else ME.rep.down++;
        LS.set('rep', ME.rep);
      }
      break;
  }
}

/* ---------- actions ---------- */
function setMode(m){ S.mode = m; if (m !== 'searching') selId = null; render(); drawMarkers(); }
function offersChanged(){ drawMarkers(); if (S.mode === 'searching' || S.mode === 'idle') renderSoft(); }
function sendOffer(){
  if (!myOffer) return;
  send({t: 'offer', lat: myOffer.lat, lng: myOffer.lng, inSec: Math.max(0, Math.round((myOffer.leaveAt - now())/1000)), car: ME.car, rep: ME.rep});
}
function startOffer(min){
  if (!pos){ toast('Erst Standort setzen.'); return; }
  myOffer = {lat: pos.lat, lng: pos.lng, leaveAt: now() + min*60000};
  setMode('offering'); sendOffer(); center(true);
}
function stopOffer(){ myOffer = null; send({t: 'withdraw'}); setMode('idle'); }
function select(id){
  selId = id; render(); drawMarkers();
  const o = offers.get(id); if (o) map.easeTo({center: [o.lng, o.lat], zoom: Math.max(map.getZoom(), 16), padding: {bottom: sheetH()}, duration: 700});
}
function take(id){
  const o = offers.get(id); if (!o) return;
  if (ME.points < COST){ toast('Zu wenig Punkte. Gib selbst eine Lücke ab.'); return; }
  pending = {mid: rid(10), offer: o, t: now()};
  send({t: 'claim', to: o.id, mid: pending.mid, car: ME.car, rep: ME.rep, lat: pos?.lat, lng: pos?.lng});
  setMode('claiming');
}
let lastPos = 0;
function sendPos(force){
  if (!match || !pos) return;
  if (!force && now() - lastPos < 900) return;
  lastPos = now();
  send({t: 'pos', to: match.peer.id, mid: match.mid, lat: pos.lat, lng: pos.lng});
}
function matchDist(){            // distance left on the road
  const rl = routeLeft(); return rl ? rl.len : null;
}
function isNear(){               // both cars really close: seeker at the spot and next to the other car
  if (!match || !pos || !match.peer.pos) return false;
  const seekerPos = match.role === 'seeker' ? pos : match.peer.pos;
  return dist(seekerPos, match.spot) <= NEAR_M && dist(pos, match.peer.pos) <= NEAR_M + 20;
}
function peerDist(){ return match && pos && match.peer.pos ? dist(pos, match.peer.pos) : null; }
function confirmHandover(){
  if (!match || !isNear()){ toast(`Bestätigen geht erst unter ${NEAR_M} m Abstand.`); return; }
  match.meOk = true; send({t: 'confirm', to: match.peer.id, mid: match.mid, lat: pos.lat, lng: pos.lng}); vib(40);
  checkDone(); render();
}
function checkDone(){
  if (!match || !match.meOk || !match.peerOk) return;
  ME.points += match.role === 'leaver' ? COST : -COST;
  LS.set('points', ME.points);
  S.done = {role: match.role, peer: match.peer.id, peerCar: match.peer.car};
  if (match.role === 'leaver') myOffer = null;
  match = null; stopDrive(); keepAwake(false); vib([60, 40, 60, 40, 120]);
  updPts(true); setMode('done');
}
function cancelMatch(){
  if (match) send({t: 'cancel', to: match.peer.id, mid: match.mid});
  endMatch();
}
function endMatch(){
  const wasLeaver = match && match.role === 'leaver';
  match = null; stopDrive(); keepAwake(false);
  if (wasLeaver) myOffer = null;
  setMode('idle'); center();
}
function rate(r){
  if (S.done) send({t: 'rate', to: S.done.peer, r});
  S.done = null; toast(r > 0 ? 'Danke für dein Feedback!' : 'Danke, wir merken uns das.'); setMode('idle'); center();
}
let wl = null;
async function keepAwake(on){
  try{
    if (on && !wl && navigator.wakeLock) wl = await navigator.wakeLock.request('screen');
    if (!on && wl){ await wl.release(); wl = null; }
  }catch{}
}

/* ---------- timers ---------- */
let tick = 0;
setInterval(() => {
  tick++;
  const t = now();
  if (S.mode === 'offering' && myOffer){
    if (tick % 4 === 0) sendOffer();
    if (t > myOffer.leaveAt + 5*60000){ toast('Dein Angebot ist abgelaufen.'); stopOffer(); }
  }
  let changed = false;
  for (const [k, o] of offers) if (t - o.seen > 13000 || t > o.leaveAt + 5*60000){ offers.delete(k); changed = true; if (selId === k) selId = null; }
  if (changed) offersChanged();
  if (S.mode === 'claiming' && pending && t - pending.t > 9000){ pending = null; toast('Keine Antwort. Versuch eine andere Lücke.'); setMode('searching'); }
  if (match && tick % 2 === 0) sendPos(true);
  if (match && tick % 3 === 0) refreshRoute();
  if (match && t - match.peer.last > 45000 && !match.lostWarned){ match.lostWarned = true; toast('Keine Verbindung zum anderen Fahrer.'); }
  if (match && t - match.peer.last < 45000) match.lostWarned = false;
  if (demo) sim.tick();
  live();
  if (S.mode === 'idle' || S.mode === 'searching') drawMarkers();
}, 1000);

/* ---------- UI ---------- */
const ICON = {
  leave: '<svg viewBox="0 0 24 24"><path d="M5 16V11l2-5h10l2 5v5H5zM7 13h1M16 13h1M5 16v2M19 16v2"/><path d="M14 3l3-2M17 1l1 3"/></svg>',
  seek: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4M9 8h2.5a2 2 0 010 4H9V8zm0 4v3"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M7 11v9H4v-9h3zM7 11l4-8a2 2 0 013 2l-1 5h6a2 2 0 012 2l-2 7a2 2 0 01-2 1H7"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M7 13V4H4v9h3zM7 13l4 8a2 2 0 003-2l-1-5h6a2 2 0 002-2l-2-7a2 2 0 00-2-1H7"/></svg>',
  nav: '<svg viewBox="0 0 24 24"><path d="M3 11l18-8-8 18-2-8-8-2z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>'
};
const sortedOffers = () => [...offers.values()].map(o => ({...o, d: pos ? dist(pos, o) : 0})).sort((a, b) => a.d - b.d);
const nearCount = () => pos ? [...offers.values()].filter(o => dist(pos, o) <= NOTIFY_M*2).length : offers.size;

let lastView = '';
function render(){
  const sc = $('#sc');
  const html = view();
  if (html === lastView) return;
  const modeKey = S.mode + (S.menu ? 'm' : '');
  if (sc.dataset.k !== modeKey){ sc.classList.remove('enter'); void sc.offsetWidth; sc.classList.add('enter'); sc.dataset.k = modeKey; }
  sc.innerHTML = html; lastView = html;
  live();
  requestAnimationFrame(() => { $('#locBtn').style.bottom = (sheetH() + 12) + 'px'; });
}
function renderSoft(){ if (!S.menu) render(); }

function view(){
  if (S.menu || S.mode === 'onboard') return viewSettings();
  const noPos = !pos ? `<p class="hint">${manual || demo ? 'Tippe auf die Karte, um deinen Standort zu setzen.' : 'Warte auf GPS…'}</p>` : '';
  switch (S.mode){
    case 'idle': return `
      <h2>Was hast du vor?</h2>
      <p id="nearTxt"></p>
      <div class="row">
        <button class="big leave" data-a="leave">${ICON.leave}<b>Ich fahre weg</b><small>Lücke abgeben, +${COST} Punkte</small></button>
        <button class="big seek" data-a="seek">${ICON.seek}<b>Ich suche</b><small>Lücke in der Nähe</small></button>
      </div>${noPos}`;
    case 'pick': return `
      <h2>Wann fährst du los?</h2>
      <p>Deine Lücke wird sofort Leuten in der Nähe angezeigt.</p>
      <div class="chips">${[2, 5, 10].map(n => `<button class="chip" data-a="go" data-n="${n}"><b>${n}</b><span>Min</span></button>`).join('')}</div>
      <button class="btn ghost" data-a="home">Zurück</button>`;
    case 'offering': return `
      <div class="radar amber">P</div>
      <h2 style="text-align:center">Deine Lücke ist online</h2>
      <p style="text-align:center">Abfahrt in <b id="cd"></b>. Wir sagen Bescheid, sobald jemand sie nimmt.</p>
      ${demo ? '<p class="hint">Demo: Gleich meldet sich ein virtueller Fahrer.</p>' : ''}
      <button class="btn" data-a="stopOffer">Angebot zurückziehen</button>`;
    case 'searching': {
      const list = sortedOffers();
      const items = list.map(o => {
        const mins = Math.max(0, Math.ceil((o.leaveAt - now())/60000));
        const sel = o.id === selId;
        return `<button class="item${sel ? ' sel' : ''}" data-a="sel" data-id="${esc(o.id)}">
          <span class="p">P</span>
          <span class="t"><b>${fmtD(o.d)} entfernt</b><span>frei ${mins ? 'in ' + mins + ' Min' : 'jetzt'} · ${esc(repTxt(o.rep))}</span></span>
          <span class="r"><span class="dot" style="display:inline-block;width:16px;height:16px;vertical-align:middle;background:${esc(o.car?.color || '#6b7280')}"></span><br>ca. ${etaMin(o.d)} Min</span>
        </button>${sel ? `<button class="btn pri take" data-a="take" data-id="${esc(o.id)}" ${ME.points < COST ? 'disabled' : ''}>${ME.points < COST ? 'Zu wenig Punkte' : 'Nehmen für ' + COST + ' Punkte'}</button>` : ''}`;
      }).join('');
      return `
        <h2>Freie Lücken</h2>
        <p>Im Umkreis von ${RADIUS_M/1000} km, nach Entfernung sortiert.</p>
        ${list.length ? `<div class="list">${items}</div>` : `<div class="empty"><div class="radar">P</div>Gerade keine Lücke in der Nähe. Neue Angebote erscheinen hier sofort.${demo ? '' : '<br><br>Allein testen? Schalte im Menü den Demo-Modus ein.'}</div>`}
        <button class="btn ghost" data-a="home">Zurück</button>${noPos}`;
    }
    case 'claiming': return `<div class="radar">P</div><h2 style="text-align:center">Frage an…</h2><p style="text-align:center">Einen Moment, der andere Fahrer bekommt deine Anfrage.</p>`;
    case 'matched': {
      if (!match) return '';
      const seeker = match.role === 'seeker';
      const p = match.peer;
      const sim = demo || manual;
      const tgt = seeker ? match.spot : null;
      const navUrl = tgt ? `https://www.google.com/maps/dir/?api=1&destination=${tgt.lat.toFixed(6)},${tgt.lng.toFixed(6)}&travelmode=driving` : '';
      const confirmBtn = match.meOk
        ? `<button class="btn" disabled>${ICON.check} Warte auf den anderen</button>`
        : `<button class="btn ok" id="okBtn" data-a="ok">${ICON.check} Übergabe bestätigen</button>`;
      return `
        <h2>${seeker ? 'Lücke reserviert' : 'Jemand kommt!'}</h2>
        <div class="stat"><b id="md">…</b><span id="me2"></span></div>
        <div class="prog"><i id="pg" style="width:0"></i></div>
        <div class="card"><span class="dot" style="background:${esc(p.car?.color || '#6b7280')}"></span>
          <span class="t"><b>${seeker ? 'Wartet: ' : 'Kommt: '}${esc(carTxt(p.car))}</b><span>${esc(repTxt(p.rep))}${match.peerOk ? ' · hat bestätigt' : ''}</span></span>
          ${p.car?.plate ? `<span class="plate">${esc(p.car.plate)}</span>` : ''}</div>
        ${confirmBtn}
        <p class="hint" id="okHint"></p>
        <div class="row">
          ${seeker ? `<a class="btn" href="${esc(navUrl)}" target="_blank" rel="noopener">${ICON.nav} Navigation</a>` : ''}
          ${sim && seeker ? `<button class="btn" data-a="drive">${drive === 'routing' ? 'Route…' : drive ? 'Anhalten' : 'Hinfahren (Sim.)'}</button>` : ''}
        </div>
        <button class="btn ghost" data-a="cancel">Abbrechen</button>`;
    }
    case 'done': {
      const l = S.done?.role === 'leaver';
      return `
        <div class="radar" style="background:var(--ok)">${ICON.check}</div>
        <h2 style="text-align:center">Übergabe geschafft</h2>
        <p style="text-align:center">${l ? `Du bekommst <b>${COST} Punkte</b>. Gute Fahrt!` : `${COST} Punkte eingesetzt. Viel Spaß!`}</p>
        <p style="text-align:center;color:var(--ink)">Wie lief es mit dem anderen Fahrer?</p>
        <div class="thumbs"><button class="up" data-a="rate" data-r="1" aria-label="Gut">${ICON.up}</button><button class="down" data-a="rate" data-r="-1" aria-label="Schlecht">${ICON.down}</button></div>`;
    }
  }
  return '';
}
function viewSettings(){
  const ob = S.mode === 'onboard';
  const car = S.draft || ME.car || {color: '', plate: ''};
  return `
    <h2>${ob ? 'Willkommen bei ParkMatch' : 'Einstellungen'}</h2>
    ${ob ? `<p>Wer wegfährt, gibt seine Lücke an jemanden in der Nähe weiter. Du startest mit ${START_POINTS} Punkten. Damit man dich erkennt:</p>` : ''}
    <div class="field"><label>Farbe deines Autos</label>
      <div class="colors">${COLORS.map(c => `<button data-a="col" data-c="${c[1]}" class="${car.color === c[1] ? 'on' : ''}" style="background:${c[1]}" aria-label="${c[0]}"></button>`).join('')}</div></div>
    <div class="field"><label for="plate">Kennzeichen (optional, hilft beim Erkennen)</label>
      <input type="text" id="plate" maxlength="12" autocomplete="off" placeholder="B AB 1234" value="${esc(car.plate)}"></div>
    ${ob ? '' : `
    <div class="sw"><div><b>Demo-Modus</b><span>Virtuelle Fahrer in deiner Nähe, ideal zum Ausprobieren allein</span></div><button class="tg${demo ? ' on' : ''}" data-a="demo" aria-label="Demo-Modus"></button></div>
    <div class="sw"><div><b>Standort per Tippen</b><span>Statt GPS: tippe auf die Karte. Gut zum Testen am Schreibtisch</span></div><button class="tg${manual ? ' on' : ''}" data-a="manual" aria-label="Standort per Tippen"></button></div>
    <div class="sw"><div><b>${ME.points} Punkte · ${esc(repTxt(ME.rep))}</b><span>Verbindung: ${demo ? 'Demo (offline)' : netState === 'live' ? 'live' : 'wird aufgebaut'}</span></div></div>`}
    <button class="btn pri" data-a="save" ${car.color ? '' : 'disabled'}>${ob ? 'Los geht’s' : 'Fertig'}</button>`;
}
function live(){
  const nt = $('#nearTxt');
  if (nt){ const n = nearCount(); nt.textContent = n ? `${n} ${n === 1 ? 'Lücke' : 'Lücken'} gerade in deiner Nähe.` : 'Gib deine Lücke weiter oder finde eine in der Nähe.'; }
  const cd = $('#cd'); if (cd && myOffer) cd.textContent = fmtT(myOffer.leaveAt - now());
  if (S.mode === 'matched' && match){
    const d = matchDist(), md = $('#md'), me2 = $('#me2'), pg = $('#pg'), hint = $('#okHint');
    if (d != null && md){
      md.textContent = fmtD(d);
      const eta = match.route && match.route.road && match.route.dur ? Math.max(1, Math.round(match.route.dur*d/Math.max(1, match.route.dist)/60)) : etaMin(d);
      me2.textContent = (match.role === 'seeker' ? 'bis zur Lücke' : 'Fahrstrecke') + (match.route && match.route.road ? '' : ' (Luftlinie)') + ` · ca. ${eta} Min`;
      if (!match.start || d > match.start) match.start = Math.max(d, 50);
      pg.style.width = Math.round(100*Math.max(0, Math.min(1, 1 - (d - NEAR_M)/(match.start - NEAR_M)))) + '%';
    } else if (md){ md.textContent = '…'; }
    const near = isNear();
    const ok = $('#okBtn');
    if (ok) ok.disabled = !near;
    if (hint) hint.textContent = match.meOk ? '' : near ? 'Ihr seid da. Jetzt beide bestätigen.' : `Bestätigen geht erst, wenn ihr beide unter ${NEAR_M} m voneinander entfernt seid.`;
  }
}
function updPts(b){ const el = $('#pts'); el.querySelector('b').textContent = ME.points; if (b){ el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); } }

$('#sheet').addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const a = b.dataset.a;
  if (a === 'leave'){ if (!pos) return toast(manual || demo ? 'Tippe erst auf die Karte für deinen Standort.' : 'Warte auf GPS…'); setMode('pick'); }
  else if (a === 'seek'){ setMode('searching'); fitOffers(); }
  else if (a === 'home') setMode('idle');
  else if (a === 'go') startOffer(+b.dataset.n);
  else if (a === 'stopOffer') stopOffer();
  else if (a === 'sel') select(b.dataset.id);
  else if (a === 'take') take(b.dataset.id);
  else if (a === 'ok') confirmHandover();
  else if (a === 'cancel') cancelMatch();
  else if (a === 'drive'){ if (drive) stopDrive(); else if (match) driveTo(() => match ? match.spot : pos); }
  else if (a === 'rate') rate(+b.dataset.r);
  else if (a === 'col'){ S.draft = {color: b.dataset.c, plate: $('#plate')?.value || ''}; render(); }
  else if (a === 'demo') toggleDemo();
  else if (a === 'manual'){ manual = !manual; LS.set('manual', manual); if (!manual && !gpsOk) banner('Kein GPS verfügbar. Standort per Tippen bleibt aktiv, bis GPS da ist.'); drawMarkers(); render(); }
  else if (a === 'save'){
    const draft = S.draft || ME.car || {};
    if (!draft.color) return;
    ME.car = {color: draft.color, plate: ($('#plate')?.value || '').trim().toUpperCase().slice(0, 12)};
    LS.set('car', ME.car); S.draft = null; S.menu = false;
    if (S.mode === 'onboard'){ S.mode = 'idle'; startGps(); }
    render(); drawMarkers();
  }
});
$('#sheet').addEventListener('input', e => { if (e.target.id === 'plate'){ S.draft = {color: (S.draft || ME.car || {}).color || '', plate: e.target.value}; } });
$('#menuBtn').addEventListener('click', () => { if (S.mode === 'onboard') return; S.menu = !S.menu; S.draft = null; render(); });
$('#locBtn').addEventListener('click', () => center(true));

let tt = null;
function toast(msg){ const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 2800); }
function banner(msg){ const b = $('#banner'); b.textContent = msg; b.hidden = false; }
function hideBanner(){ $('#banner').hidden = true; }

/* ---------- demo: virtual drivers ---------- */
const NAMES_COL = ['#dc2626', '#f2f4f7', '#111418', '#2563eb', '#b8bec6', '#16a34a', '#eab308'];
const PLATES = ['K LM 482', 'HH PA 77', 'B XY 2051', 'F MK 913', 'S RT 330', 'L ZE 18'];
const sim = {
  v: new Map(),         // virtual offers
  seeker: null,         // virtual seeker coming to my spot
  spawning: 0,
  async start(){
    this.v.clear(); this.seeker = null;
    if (pos) for (let i = 0; i < 4; i++) await this.spawn();
  },
  stop(){ this.v.clear(); if (this.seeker) clearInterval(this.seeker.timer); this.seeker = null; },
  rnd(a){ return a[Math.floor(Math.random()*a.length)]; },
  async spawn(){
    if (!pos || this.spawning > 1) return;
    this.spawning++;
    let p = null;
    try{
      for (let k = 0; k < 4 && !p; k++){
        const raw = offset(pos, 120 + Math.random()*650, Math.random()*360);
        const sn = await snapToRoad(raw);
        if (sn === undefined) p = raw;                       // routing service unreachable: keep raw point
        else if (sn && [...this.v.values()].every(o => dist(o, sn) > 40)) p = sn;
      }
    } finally { this.spawning--; }
    if (!p || !demo) return;
    const id = 'v_' + rid(6);
    this.v.set(id, {id, ...p, leaveAt: now() + (1 + Math.floor(Math.random()*9))*60000, car: {color: this.rnd(NAMES_COL), plate: this.rnd(PLATES)}, rep: {up: 5 + Math.floor(Math.random()*20), down: Math.floor(Math.random()*3)}, taken: false});
    this.emitOffers();
  },
  emitOffers(){
    for (const o of this.v.values()) if (!o.taken) onMsg({t: 'offer', from: o.id, lat: o.lat, lng: o.lng, inSec: Math.round((o.leaveAt - now())/1000), car: o.car, rep: o.rep});
  },
  tick(){
    if (!pos) return;
    if (this.v.size === 0 && !this.spawning) this.start();
    if (tick % 4 === 0) this.emitOffers();
    if ([...this.v.values()].filter(o => !o.taken).length < 3 && Math.random() < .08) this.spawn();
    // virtual leaver at the spot keeps reporting its position
    if (match && match.peer.id.startsWith('v_') && match.role === 'seeker' && tick % 2 === 0){
      const o = this.v.get(match.peer.id);
      if (o) onMsg({t: 'pos', from: o.id, to: ME.id, mid: match.mid, lat: o.lat, lng: o.lng});
    }
    // virtual seeker drives to me along the streets
    const s = this.seeker;
    if (s && match && match.mid === s.mid && s.go && !s.w && !s.routing){
      s.routing = true;
      getRoute(s.p, match.spot).then(r => { s.routing = false; if (this.seeker === s){ s.w = walker(r.pts); s.timer = setInterval(() => this.driveSeeker(s), 400); } });
    }
  },
  driveSeeker(s){
    if (this.seeker !== s || !match || match.mid !== s.mid){ clearInterval(s.timer); return; }
    s.p = s.w.step(5);                     // 12.5 m/s
    onMsg({t: 'pos', from: s.id, to: ME.id, mid: s.mid, lat: s.p.lat, lng: s.p.lng});
    if (s.w.done){
      clearInterval(s.timer);
      if (!s.ok){ s.ok = true; setTimeout(() => { if (match && match.mid === s.mid) onMsg({t: 'confirm', from: s.id, to: ME.id, mid: s.mid}); }, 1500); }
    }
  },
  recv(m){
    setTimeout(() => {
      if (m.t === 'claim'){
        const o = this.v.get(m.to); if (!o) return;
        if (o.taken) return onMsg({t: 'reject', from: o.id, to: ME.id, mid: m.mid});
        o.taken = true;
        onMsg({t: 'withdraw', from: o.id});
        onMsg({t: 'accept', from: o.id, to: ME.id, mid: m.mid, lat: o.lat, lng: o.lng, car: o.car, rep: o.rep});
      }
      if (m.t === 'offer' && !this.seeker && S.mode === 'offering'){
        const id = 'v_' + rid(6);
        const p = offset({lat: m.lat, lng: m.lng}, 380 + Math.random()*300, Math.random()*360);
        snapToRoad(p).then(sn => { if (sn && this.seeker && this.seeker.id === id && !this.seeker.go) this.seeker.p = sn; });
        this.seeker = {id, p, mid: rid(10), car: {color: this.rnd(NAMES_COL), plate: this.rnd(PLATES)}, rep: {up: 12, down: 1}, go: false};
        const s = this.seeker;
        setTimeout(() => { if (S.mode === 'offering' && this.seeker === s) onMsg({t: 'claim', from: s.id, to: ME.id, mid: s.mid, car: s.car, rep: s.rep, lat: s.p.lat, lng: s.p.lng}); }, 3500);
      }
      if (m.t === 'accept' && this.seeker && m.to === this.seeker.id) this.seeker.go = true;
      if (m.t === 'confirm' && match && m.to.startsWith('v_') && match.role === 'seeker') setTimeout(() => onMsg({t: 'confirm', from: m.to, to: ME.id, mid: m.mid}), 900);
      if (m.t === 'cancel'){ if (this.seeker && m.to === this.seeker.id){ clearInterval(this.seeker.timer); this.seeker = null; } const o = this.v.get(m.to); if (o){ o.taken = false; } }
      if (m.t === 'withdraw' && this.seeker && !this.seeker.go) this.seeker = null;
      if (m.t === 'pos' || m.t === 'rate') {}
    }, 250);
  }
};
function toggleDemo(){
  if (match) cancelMatch();
  if (myOffer) stopOffer();
  demo = !demo;
  offers.clear(); selId = null; pending = null;
  S.mode = 'idle';
  if (demo){ sim.start(); toast(pos ? 'Demo an: virtuelle Fahrer in deiner Nähe.' : 'Demo an: tippe auf die Karte für deinen Standort.'); }
  else { sim.stop(); toast('Demo aus: echte Nutzer in deiner Nähe.'); }
  setNet(netState); drawMarkers(); render();
}

/* ---------- boot ---------- */
updPts(false); setNet('connecting'); render(); connect();
if (ME.car) startGps();
document.addEventListener('visibilitychange', () => { if (!document.hidden && match) keepAwake(true); });
if (new URLSearchParams(location.search).has('demo') && ME.car) toggleDemo();
}
