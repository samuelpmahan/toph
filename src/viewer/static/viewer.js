/* Toph replay viewer — evidence-first client.
 *
 * Design goal (see the usability audit): the raster must show the actual pixels/geometry the CV
 * pipeline measured, with the measured value + limit + decision registered right beside it, so a
 * reviewer can watch an assumption become wrong. Everything else (parameters, runs, tables) is
 * secondary and gets out of the way. This file is application-generic but understands the
 * ChainSpot vocabulary (Hole/Tee/Basket/candidate, assigned/reassigned) when the trace exposes it.
 */
(function () {
  'use strict';

  // ---- role palette (kept in sync with index.html CSS custom props) ----------------------
  var COLOR = {
    measured: '#38bdf8', current: '#f59e0b', proposed: '#34d399',
    threshold: '#f87171', historical: '#64748b', context: '#94a3b8',
    sel: '#ffffff', hole: '#ffd166', tee: '#c7d2e6', basket: '#ffffff',
    assigned: '#34d399', reassigned: '#f59e0b',
  };

  var state = {
    session: null, selectedRunId: null, run: null, trace: null, manifest: null, labelmaps: null,
    stageIndex: -1,
    maskMode: 'source',          // source | mask | maskOnly | component
    selectedComponent: 0,
    selectedEntityId: null,
    selectedEvidence: -1,        // index into current-stage evidence list
    showAdvanced: false, showRaw: false,
    pinnedA: null, pinnedB: null, diff: null,
    sortKey: null, sortDir: 1,
    zoom: 1,
  };
  var MASK_MODES = ['source', 'mask', 'maskOnly', 'component'];
  var MASK_LABELS = { source: 'Mask: source', mask: 'Mask: +overlay', maskOnly: 'Mask: only', component: 'Mask: component' };

  var img = new Image();
  var imgReady = false;
  img.onload = function () { imgReady = true; draw(); };

  var canvas = document.getElementById('stage');
  var ctx = canvas.getContext('2d');
  var wrap = document.getElementById('canvasWrap');
  var decodedCache = { runId: null, doc: null, decoded: null };
  var maskCache = { key: null, canvas: null };

  // ---- fetch helpers ---------------------------------------------------------------------
  function getJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return { error: r.statusText }; }).then(function (b) { throw new Error((b && b.error) || r.statusText); });
      return r.json();
    });
  }
  function getJsonOrNull(url) { return getJson(url).catch(function () { return null; }); }
  function postJson(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (p) { if (!r.ok) throw new Error((p && p.error) || r.statusText); return p; }); });
  }

  // ---- manifest / naming -----------------------------------------------------------------
  function manifestStages() { return (state.manifest && state.manifest.stages) || []; }
  function stageName(stageId) {
    var f = manifestStages().find(function (s) { return s.id === stageId; });
    return f ? f.name : 'stage#' + stageId;
  }
  function kindName(kindId) {
    var k = state.manifest && state.manifest.entityKinds && state.manifest.entityKinds.find(function (x) { return x.id === kindId; });
    return k ? k.name : 'kind#' + kindId;
  }
  function checkLabel(checkId) {
    var c = state.manifest && state.manifest.checks && state.manifest.checks.find(function (x) { return x.id === checkId; });
    return c ? (c.label || c.code) : ('check#' + checkId);
  }
  function summaryLabel(key) {
    var m = state.manifest && state.manifest.summaryLabels;
    return (m && m[key]) || key;
  }
  var OP = { gte: '≥', lte: '≤', gt: '>', lt: '<', eq: '=', neq: '≠' };

  // ---- entity helpers --------------------------------------------------------------------
  function entities() { return (state.trace && state.trace.entities) || []; }
  function entityById(id) { return entities().find(function (e) { return e.id === id; }); }
  function coordsOf(e) {
    if (!e || !e.attrs) return null;
    if (typeof e.attrs.x === 'number' && typeof e.attrs.y === 'number') return { x: e.attrs.x, y: e.attrs.y };
    if (typeof e.attrs.xPx === 'number' && typeof e.attrs.yPx === 'number') return { x: e.attrs.xPx, y: e.attrs.yPx };
    return null;
  }
  function invocationIndex(invocationId) {
    var st = state.trace.stages;
    for (var i = 0; i < st.length; i++) if (st[i].invocationId === invocationId) return i;
    return -1;
  }
  function currentInvocation() {
    if (!state.trace || state.stageIndex < 0) return null;
    return state.trace.stages[state.stageIndex];
  }
  // Latest assignment relation for a basket at or before the current stage; returns {holeNumber, relation, historical}.
  function assignmentFor(entityId) {
    var best = null, bestIdx = -1;
    (state.trace.dataflow || []).forEach(function (ev) {
      if (ev.t !== 'relate' || ev.left !== entityId) return;
      if (ev.relation !== 'assigned' && ev.relation !== 'reassigned') return;
      var idx = invocationIndex(ev.stage);
      if (idx > state.stageIndex) return;
      if (idx >= bestIdx) { bestIdx = idx; best = ev; }
    });
    if (!best) return null;
    var hole = entityById(best.right);
    return { holeNumber: hole && hole.attrs ? hole.attrs.holeNumber : null, relation: best.relation, targetId: best.right };
  }
  // Semantic, human label for an entity given the current stage context.
  function semanticLabel(e) {
    var kind = kindName(e.kindId);
    var a = e.attrs || {};
    if (/hole/i.test(kind) && a.holeNumber != null) return 'Hole ' + a.holeNumber;
    if (/tee/i.test(kind)) return a.holeNumber != null ? 'Tee ' + a.holeNumber : 'Tee';
    if (/basket/i.test(kind)) {
      var asg = assignmentFor(e.id);
      if (asg && asg.holeNumber != null) return 'Basket → Hole ' + asg.holeNumber;
      return 'Basket (cand ' + (a.candidate != null ? a.candidate : e.ordinal) + ')';
    }
    return kind + ' ' + (a.holeNumber != null ? a.holeNumber : e.ordinal);
  }
  function glyphColor(e) {
    var kind = kindName(e.kindId);
    if (/hole/i.test(kind)) return COLOR.hole;
    if (/tee/i.test(kind)) return COLOR.tee;
    return COLOR.basket;
  }

  // ---- current-stage evidence ------------------------------------------------------------
  function stageEvidence() {
    var inv = currentInvocation();
    if (!inv) return [];
    return (state.trace.evidence || []).filter(function (ev) { return ev.stageInvocationId === inv.invocationId; });
  }
  // Evidence that should be drawn: current stage, plus (if an entity is selected) any evidence for it.
  function activeEvidence() {
    var list = stageEvidence();
    return list;
  }

  // ---- labelmap decode + mask overlay ----------------------------------------------------
  function currentLabelmap() { return (state.labelmaps && state.labelmaps.length > 0) ? state.labelmaps[0] : null; }
  function decodedLabelmap() {
    var doc = currentLabelmap();
    if (!doc) return null;
    if (decodedCache.runId === state.selectedRunId && decodedCache.doc === doc) return decodedCache.decoded;
    var out = new Uint32Array(doc.widthPx * doc.heightPx);
    var cur = 0;
    for (var i = 0; i < doc.runs.length; i++) { out.fill(doc.runs[i][0], cur, cur + doc.runs[i][1]); cur += doc.runs[i][1]; }
    decodedCache = { runId: state.selectedRunId, doc: doc, decoded: out };
    return out;
  }
  function hslToRgb(h, s, l) {
    var r, g, b;
    if (s === 0) { r = g = b = l; } else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      var hue = function (t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
      r = hue(h + 1 / 3); g = hue(h); b = hue(h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }
  function buildMaskCanvas() {
    var doc = currentLabelmap();
    if (!doc) return null;
    var key = state.selectedRunId + '|' + state.maskMode + '|' + state.selectedComponent;
    if (maskCache.key === key) return maskCache.canvas;
    var decoded = decodedLabelmap();
    var w = doc.widthPx, h = doc.heightPx;
    var off = document.createElement('canvas'); off.width = w; off.height = h;
    var octx = off.getContext('2d');
    var id = octx.createImageData(w, h);
    var d = id.data;
    for (var i = 0; i < decoded.length; i++) {
      var label = decoded[i], o = i * 4;
      if (label === 0) {
        if (state.maskMode === 'maskOnly' || state.maskMode === 'component') { d[o] = 4; d[o + 1] = 6; d[o + 2] = 11; d[o + 3] = 235; }
        continue;
      }
      if (state.maskMode === 'component') {
        if (label === state.selectedComponent) { d[o] = 56; d[o + 1] = 189; d[o + 2] = 248; d[o + 3] = 165; }
        else { d[o] = 90; d[o + 1] = 100; d[o + 2] = 122; d[o + 3] = 90; }
        continue;
      }
      var rgb = hslToRgb(((label * 47) % 360) / 360, 0.62, 0.55);
      var alpha = state.maskMode === 'maskOnly' ? 232 : 120;
      d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = alpha;
    }
    octx.putImageData(id, 0, 0);
    maskCache = { key: key, canvas: off };
    return off;
  }

  // ---- focus set (selection dims unrelated clutter) --------------------------------------
  function focusSet() {
    if (state.selectedEntityId == null) return null;
    var set = {}; set[state.selectedEntityId] = true;
    (state.trace.dataflow || []).forEach(function (ev) {
      if (ev.t === 'relate' && (ev.left === state.selectedEntityId || ev.right === state.selectedEntityId)) { set[ev.left] = true; set[ev.right] = true; }
    });
    return set;
  }

  // ---- drawing ---------------------------------------------------------------------------
  function sourceWH() {
    var s = state.session && state.session.source;
    var w = (s && s.widthPx) || (imgReady && img.naturalWidth) || 800;
    var h = (s && s.heightPx) || (imgReady && img.naturalHeight) || 600;
    return { w: w, h: h };
  }
  function draw() {
    var wh = sourceWH();
    if (canvas.width !== wh.w || canvas.height !== wh.h) { canvas.width = wh.w; canvas.height = wh.h; applyZoom(state.zoom, null, null, true); }
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#05070c'; ctx.fillRect(0, 0, w, h);

    var showSource = state.maskMode === 'source' || state.maskMode === 'mask';
    if (showSource && imgReady && img.naturalWidth > 0) ctx.drawImage(img, 0, 0, w, h);
    if (state.maskMode !== 'source') { var mc = buildMaskCanvas(); if (mc) ctx.drawImage(mc, 0, 0, w, h); }

    if (!state.trace) return;
    var focus = focusSet();
    drawRelationships(focus);
    drawEvidence(focus);
    drawEntities(focus);
  }

  function alphaFor(id, focus, base) { if (!focus) return base; return focus[id] ? base : base * 0.18; }

  function drawRelationships(focus) {
    var byId = {}; entities().forEach(function (e) { byId[e.id] = e; });
    // For each basket, know whether a reassignment supersedes an earlier assignment (so we can fade the old one).
    var supersededAssign = {}; // basketId -> true if a reassigned exists at<=current
    (state.trace.dataflow || []).forEach(function (ev) {
      if (ev.t === 'relate' && ev.relation === 'reassigned' && invocationIndex(ev.stage) <= state.stageIndex) supersededAssign[ev.left] = true;
    });
    (state.trace.dataflow || []).forEach(function (ev) {
      if (ev.t !== 'relate') return;
      var idx = invocationIndex(ev.stage);
      if (idx < 0 || idx > state.stageIndex) return;
      var a = coordsOf(byId[ev.left]), b = coordsOf(byId[ev.right]);
      if (!a || !b) return;
      var atCurrent = idx === state.stageIndex;
      var isReassign = ev.relation === 'reassigned';
      var historical = ev.relation === 'assigned' && supersededAssign[ev.left];
      var color = historical ? COLOR.historical : isReassign ? COLOR.reassigned : COLOR.assigned;
      var al = alphaFor(ev.left, focus, historical ? 0.5 : atCurrent ? 1 : 0.6);
      ctx.save();
      ctx.globalAlpha = al;
      ctx.strokeStyle = color;
      ctx.lineWidth = atCurrent && !historical ? 4 : 2;
      if (isReassign) ctx.setLineDash([12, 8]); else ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      // arrowhead toward the hole for current-stage relations (color + arrow + legend carry meaning,
      // so we deliberately do not stamp the relation word on the geometry — it collides with labels).
      if (atCurrent && !historical) drawArrowHead(a.x, a.y, b.x, b.y, color);
      ctx.restore();
    });
  }

  function drawArrowHead(x1, y1, x2, y2, color) {
    var ang = Math.atan2(y2 - y1, x2 - x1), size = 16;
    var bx = x2 - Math.cos(ang) * 14, by = y2 - Math.sin(ang) * 14;
    ctx.save(); ctx.fillStyle = color; ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - Math.cos(ang - 0.4) * size, by - Math.sin(ang - 0.4) * size);
    ctx.lineTo(bx - Math.cos(ang + 0.4) * size, by - Math.sin(ang + 0.4) * size);
    ctx.closePath(); ctx.fill(); ctx.restore();
  }

  function drawEvidence(focus) {
    var list = activeEvidence();
    list.forEach(function (ev, i) {
      var selected = i === state.selectedEvidence;
      var color = COLOR[ev.role] || COLOR.measured;
      var al = 1;
      if (state.selectedEvidence >= 0 && !selected) al = 0.28;
      if (focus && ev.entityId != null && !focus[ev.entityId]) al = Math.min(al, 0.22);
      ctx.save(); ctx.globalAlpha = al;
      // Only the selected observation draws its text labels, so a busy stage stays legible; the
      // value/threshold/decision for the selection is shown in the HUD and the rail.
      (ev.shapes || []).forEach(function (sh) { drawShape(sh, color, selected, selected); });
      ctx.restore();
    });
    updateHud(state.selectedEvidence >= 0 ? list[state.selectedEvidence] : null);
  }

  function drawShape(sh, color, strong, withLabel) {
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = strong ? 4 : 2.5;
    if (sh.t === 'segment') {
      ctx.beginPath(); ctx.moveTo(sh.x1, sh.y1); ctx.lineTo(sh.x2, sh.y2); ctx.stroke();
      drawEndCap(sh.x1, sh.y1, color); drawEndCap(sh.x2, sh.y2, color);
      if (sh.label && withLabel) drawTag((sh.x1 + sh.x2) / 2, (sh.y1 + sh.y2) / 2, sh.label, color, strong);
    } else if (sh.t === 'polyline') {
      ctx.beginPath(); sh.pts.forEach(function (p, i) { if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
      if (sh.closed) ctx.closePath();
      ctx.setLineDash([10, 7]); ctx.stroke(); ctx.setLineDash([]);
      if (sh.label && withLabel) { var m = sh.pts[Math.floor(sh.pts.length / 2)]; drawTag(m[0], m[1], sh.label, color, false); }
    } else if (sh.t === 'bbox') {
      ctx.strokeRect(sh.x, sh.y, sh.w, sh.h);
      if (sh.label && withLabel) drawTag(sh.x + sh.w / 2, sh.y - 4, sh.label, color, false);
    } else if (sh.t === 'circle') {
      ctx.beginPath(); ctx.arc(sh.x, sh.y, sh.r, 0, Math.PI * 2); ctx.stroke();
    } else if (sh.t === 'angle') {
      var f = sh.fromDeg * Math.PI / 180, t = sh.toDeg * Math.PI / 180;
      var delta = ((sh.toDeg - sh.fromDeg + 540) % 360) - 180;
      ctx.globalAlpha = ctx.globalAlpha * 0.5;
      ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.arc(sh.x, sh.y, sh.radius, f, t, delta < 0); ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = ctx.globalAlpha / 0.5;
      ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.arc(sh.x, sh.y, sh.radius, f, t, delta < 0); ctx.stroke();
      if (sh.label && withLabel) { var mid = (sh.fromDeg + sh.fromDeg + delta) / 2 * Math.PI / 180; drawTag(sh.x + Math.cos(mid) * (sh.radius + 18), sh.y + Math.sin(mid) * (sh.radius + 18), sh.label, color, strong); }
    } else if (sh.t === 'vector') {
      ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(sh.x + sh.dx, sh.y + sh.dy); ctx.stroke();
      drawArrowHead(sh.x, sh.y, sh.x + sh.dx, sh.y + sh.dy, color);
    } else if (sh.t === 'point') {
      ctx.beginPath(); ctx.arc(sh.x, sh.y, strong ? 7 : 5, 0, Math.PI * 2); ctx.fill();
      if (sh.label && withLabel) drawTag(sh.x + 8, sh.y - 8, sh.label, color, strong);
    }
    ctx.restore();
  }
  function drawEndCap(x, y, color) { ctx.save(); ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }

  function drawTag(x, y, text, color, strong) {
    ctx.save();
    ctx.font = (strong ? '700 ' : '600 ') + '19px ui-monospace, Menlo, monospace';
    var padX = 5, tw = ctx.measureText(text).width, th = 20;
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(6,9,14,0.82)';
    roundRect(x - tw / 2 - padX, y - th / 2 - 3, tw + padX * 2, th, 5); ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.restore();
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  // The selected observation's value + limit + decision, shown as a fixed HUD over the canvas
  // corner (crisp at any zoom, never colliding with on-image labels) — evidence and value stay
  // registered together with the geometry highlighted on the raster.
  function updateHud(ev) {
    var hud = document.getElementById('evHud');
    if (!ev) { hud.className = 'hidden'; return; }
    var col = COLOR[ev.role] || COLOR.measured;
    var badge = ev.decision || '';
    var badgeCol = /PASS|SWAP|DETECT/i.test(badge) ? '#17402c' : /FAIL|REJECT/i.test(badge) ? '#45211f' : '#2a3242';
    var badgeInk = /PASS|SWAP|DETECT/i.test(badge) ? COLOR.proposed : /FAIL|REJECT/i.test(badge) ? COLOR.threshold : COLOR.dim;
    hud.className = '';
    hud.style.borderLeftColor = col;
    hud.innerHTML = '<div class="h">' + esc(ev.label || 'measurement') + '</div>' +
      (exprText(ev) ? '<div class="x">' + fmtExprHtml(ev) + '</div>' : '') +
      (badge ? '<div class="d" style="background:' + badgeCol + ';color:' + badgeInk + '">' + esc(badge) + '</div>' : '');
  }

  function drawEntities(focus) {
    entities().forEach(function (e) {
      var c = coordsOf(e); if (!c) return;
      var kind = kindName(e.kindId);
      var isSel = e.id === state.selectedEntityId;
      var al = alphaFor(e.id, focus, 1);
      ctx.save(); ctx.globalAlpha = al;
      var col = glyphColor(e);
      if (isSel) { ctx.beginPath(); ctx.arc(c.x, c.y, 22, 0, Math.PI * 2); ctx.strokeStyle = COLOR.sel; ctx.lineWidth = 3; ctx.stroke(); }
      // Place labels off the geometry by kind so holes/baskets/tees stacked in one spot don't collide:
      // holes label above the green, tees above the pad, baskets below the basket.
      var labelY;
      if (/hole/i.test(kind)) { drawHoleGlyph(c, e, col); labelY = c.y - ((e.attrs && e.attrs.greenRadiusPx) || 18) - 14; }
      else if (/tee/i.test(kind)) { drawTeeGlyph(c, col); labelY = c.y - 26; }
      else if (/basket/i.test(kind)) { drawBasketGlyph(c, col, isSel); labelY = c.y + ((e.attrs && e.attrs.radiusPx) || 14) + 22; }
      else { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(c.x, c.y, 6, 0, Math.PI * 2); ctx.fill(); labelY = c.y - 20; }
      drawTag(c.x, labelY, semanticLabel(e), isSel ? COLOR.sel : col, isSel);
      ctx.restore();
    });
  }
  function drawHoleGlyph(c, e, col) {
    // A small flag pin at the pin/basket target; the green disc already marks the area and the
    // "Hole N" tag carries the number, so we keep the on-green mark minimal.
    ctx.save();
    ctx.strokeStyle = col; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(c.x, c.y + 10); ctx.lineTo(c.x, c.y - 14); ctx.stroke();
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(c.x, c.y - 14); ctx.lineTo(c.x + 13, c.y - 10); ctx.lineTo(c.x, c.y - 6); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(6,9,14,0.6)'; ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(c.x, c.y + 10, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  function drawTeeGlyph(c, col) {
    ctx.save(); ctx.strokeStyle = col; ctx.fillStyle = 'rgba(6,9,14,0.5)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.rect(c.x - 11, c.y - 11, 22, 22); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  function drawBasketGlyph(c, col, strong) {
    ctx.save(); ctx.strokeStyle = col; ctx.fillStyle = 'rgba(6,9,14,0.5)'; ctx.lineWidth = strong ? 4 : 3;
    ctx.beginPath(); ctx.arc(c.x, c.y, 13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(c.x, c.y - 13); ctx.lineTo(c.x, c.y + 20); ctx.stroke();      // pole
    ctx.beginPath(); ctx.moveTo(c.x - 9, c.y - 4); ctx.lineTo(c.x, c.y + 4); ctx.lineTo(c.x + 9, c.y - 4); ctx.stroke(); // chevron chains
    ctx.restore();
  }

  // ---- expression text -------------------------------------------------------------------
  function fmt(v) { return typeof v === 'number' ? String(v) : String(v); }
  function exprText(ev) {
    if (ev.value === undefined) return ev.decision || '';
    var s = fmt(ev.value) + (ev.unit ? ' ' + ev.unit : '');
    if (ev.operator && ev.threshold !== undefined) s += ' ' + (OP[ev.operator] || ev.operator) + ' ' + ev.threshold + (ev.unit ? ' ' + ev.unit : '');
    return s;
  }

  // ---- zoom / pan ------------------------------------------------------------------------
  var MINZ = 0.15, MAXZ = 6;
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function applyZoom(next, ax, ay, silent) {
    next = clamp(next, MINZ, MAXZ);
    var rect = wrap.getBoundingClientRect();
    var acx = ax == null ? rect.left + rect.width / 2 : ax, acy = ay == null ? rect.top + rect.height / 2 : ay;
    var cx = (wrap.scrollLeft + acx - rect.left) / state.zoom, cy = (wrap.scrollTop + acy - rect.top) / state.zoom;
    state.zoom = next;
    canvas.style.width = Math.round(canvas.width * next) + 'px';
    canvas.style.height = Math.round(canvas.height * next) + 'px';
    wrap.scrollLeft = cx * next - (acx - rect.left);
    wrap.scrollTop = cy * next - (acy - rect.top);
    document.getElementById('zoomReadout').textContent = Math.round(next * 100) + '%';
  }
  function fit() {
    var rect = wrap.getBoundingClientRect();
    if (!canvas.width) return;
    applyZoom(clamp(Math.min(rect.width / canvas.width, rect.height / canvas.height), MINZ, 1));
    wrap.scrollLeft = Math.max(0, (canvas.width * state.zoom - rect.width) / 2);
    wrap.scrollTop = Math.max(0, (canvas.height * state.zoom - rect.height) / 2);
  }

  // ---- rendering the rail ----------------------------------------------------------------
  function renderStageEvidence() {
    document.getElementById('stageEvidenceName').textContent = currentInvocation() ? (state.stageIndex + 1) + ' · ' + stageName(currentInvocation().stageId) : '';
    var list = stageEvidence();
    document.getElementById('obsCount').textContent = list.length ? (state.selectedEvidence >= 0 ? (state.selectedEvidence + 1) + ' / ' + list.length : list.length + ' observations') : 'no evidence';
    var el = document.getElementById('evidenceList'); el.innerHTML = '';
    if (list.length === 0) { el.innerHTML = '<div class="muted">This stage recorded no evidence geometry.</div>'; return; }
    list.forEach(function (ev, i) {
      var card = document.createElement('div');
      card.className = 'ecard role-' + (ev.role || 'measured') + (i === state.selectedEvidence ? ' sel' : '');
      var expr = exprText(ev);
      var dec = ev.decision ? '<span class="decision ' + ev.decision + '">' + ev.decision + '</span>' : '';
      card.innerHTML = '<div class="lab">' + esc(ev.label || 'measurement') + '</div>' +
        (expr ? '<div class="expr">' + fmtExprHtml(ev) + '</div>' : '') + dec;
      card.addEventListener('click', function () { selectEvidence(i); });
      el.appendChild(card);
    });
  }
  function fmtExprHtml(ev) {
    if (ev.value === undefined) return '';
    var s = '<span class="val">' + esc(fmt(ev.value)) + (ev.unit ? ' ' + esc(ev.unit) : '') + '</span>';
    if (ev.operator && ev.threshold !== undefined) s += ' <span class="op">' + (OP[ev.operator] || ev.operator) + '</span> <span class="thr">' + esc(String(ev.threshold)) + (ev.unit ? ' ' + esc(ev.unit) : '') + '</span>';
    return s;
  }

  function renderSelection() {
    var body = document.getElementById('selectionBody');
    if (state.selectedEntityId == null) { body.innerHTML = '<div class="muted">Click an entity or an evidence card to focus it on the image.</div>'; return; }
    var e = entityById(state.selectedEntityId);
    if (!e) { body.innerHTML = '<div class="muted">(entity not in this run)</div>'; return; }
    var html = '<div class="selid">' + esc(semanticLabel(e)) + '</div>';
    html += '<div class="selkind">' + esc(kindName(e.kindId)) + ' · entity #' + e.id + '</div>';

    // checks against this entity, human formatted
    var checks = (state.trace.checks || []).filter(function (c) { return c.elementId === e.id; });
    if (checks.length) {
      html += '<div class="kv">';
      checks.forEach(function (c) {
        var pass = c.pass ? '<span class="ok">PASS</span>' : '<span class="err">FAIL</span>';
        html += '<div class="k">' + esc(checkLabel(c.checkId)) + '</div><div class="v">' + esc(String(c.value)) + ' ' + (OP[c.operator] || c.operator) + ' ' + esc(String(c.threshold)) + ' &nbsp;' + pass + '</div>';
      });
      html += '</div>';
    }
    // evidence about this entity across stages
    var evs = (state.trace.evidence || []).filter(function (x) { return x.entityId === e.id; });
    if (evs.length) {
      html += '<div class="kv" style="margin-top:6px">';
      evs.forEach(function (x) {
        var inv = state.trace.stages.find(function (s) { return s.invocationId === x.stageInvocationId; });
        html += '<div class="k">' + esc(x.label || 'evidence') + ' <span class="kbd">' + (inv ? stageName(inv.stageId) : '') + '</span></div><div class="v">' + esc(exprText(x)) + (x.decision ? ' · ' + esc(x.decision) : '') + '</div>';
      });
      html += '</div>';
    }
    var asg = /basket/i.test(kindName(e.kindId)) ? assignmentFor(e.id) : null;
    if (asg && asg.holeNumber != null) html += '<div class="muted" style="margin-top:6px">Currently ' + esc(asg.relation) + ' → Hole ' + asg.holeNumber + '</div>';

    html += '<div class="rawbox"><label class="kbd"><input type="checkbox" id="rawToggle" ' + (state.showRaw ? 'checked' : '') + '/> raw attrs / lineage</label>';
    if (state.showRaw) html += '<pre>' + esc(JSON.stringify(e.attrs, null, 1)) + '</pre>';
    html += '</div>';
    body.innerHTML = html;
    var rt = document.getElementById('rawToggle');
    if (rt) rt.addEventListener('change', function () { state.showRaw = rt.checked; renderSelection(); });
  }

  function renderLegend() {
    var items = [
      ['dot', COLOR.hole, 'Hole'], ['dot', COLOR.tee, 'Tee'], ['dot', COLOR.basket, 'Basket'],
      ['sw', COLOR.assigned, 'assigned (P6.1)'], ['sw', COLOR.reassigned, 'reassigned (P6.2)'], ['sw', COLOR.historical, 'superseded'],
      ['sw', COLOR.measured, 'measured'], ['sw', COLOR.current, 'current'], ['sw', COLOR.proposed, 'proposed'], ['sw', COLOR.threshold, 'threshold'],
    ];
    document.getElementById('legend').innerHTML = items.map(function (it) {
      return '<span class="li"><span class="' + it[0] + '" style="background:' + it[1] + '"></span>' + it[2] + '</span>';
    }).join('');
  }

  // ---- stage strip -----------------------------------------------------------------------
  function renderStagebar() {
    var el = document.getElementById('stagebar'); el.innerHTML = '';
    if (!state.trace) return;
    var divStage = state.diff && state.diff.firstDivergentStage;
    state.trace.stages.forEach(function (inv, i) {
      var d = document.createElement('div');
      var isDiv = divStage && divStage.stageId === inv.stageId && divStage.seq === inv.seq;
      d.className = 'stage' + (i === state.stageIndex ? ' active' : '') + (isDiv ? ' diverge' : '');
      var evCount = (state.trace.evidence || []).filter(function (e) { return e.stageInvocationId === inv.invocationId; }).length;
      d.innerHTML = '<span class="idx">stage ' + (i + 1) + (isDiv ? ' · diverges' : '') + '</span>' +
        '<span class="nm">' + esc(stageName(inv.stageId)) + '</span>' +
        '<span class="badge">' + (evCount ? evCount + ' obs' : '—') + '</span>';
      d.addEventListener('click', function () { setStage(i); });
      el.appendChild(d);
    });
    var active = el.querySelector('.stage.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  // ---- state transitions -----------------------------------------------------------------
  function setStage(i) {
    if (!state.trace) return;
    state.stageIndex = clamp(i, 0, state.trace.stages.length - 1);
    state.selectedEvidence = -1;
    renderStagebar(); renderStageEvidence(); renderSelection(); draw();
  }
  function selectEvidence(i) {
    var list = stageEvidence();
    if (i < 0 || i >= list.length) { state.selectedEvidence = -1; }
    else {
      state.selectedEvidence = i;
      var ev = list[i];
      if (ev.entityId != null) state.selectedEntityId = ev.entityId;
      // if evidence references a mask component, reveal it
      (ev.shapes || []).forEach(function (sh) { if (sh.t === 'component') { state.selectedComponent = sh.label; if (state.maskMode === 'source') setMaskMode('component', true); } });
    }
    renderStageEvidence(); renderSelection(); draw();
  }
  function stepObservation(delta) {
    var list = stageEvidence(); if (!list.length) return;
    var next = state.selectedEvidence < 0 ? (delta > 0 ? 0 : list.length - 1) : state.selectedEvidence + delta;
    if (next < 0 || next >= list.length) return;
    selectEvidence(next);
  }
  function selectEntity(id) {
    state.selectedEntityId = id;
    state.selectedEvidence = -1;
    // resolve to its mask component if we can
    renderSelection(); renderStageEvidence(); draw();
  }
  function setMaskMode(mode, silent) {
    state.maskMode = mode;
    document.getElementById('maskBtn').textContent = MASK_LABELS[mode];
    document.getElementById('maskBtn').classList.toggle('on', mode !== 'source');
    if (!silent) draw();
  }
  function cycleMask() { setMaskMode(MASK_MODES[(MASK_MODES.indexOf(state.maskMode) + 1) % MASK_MODES.length]); }

  // ---- hit testing -----------------------------------------------------------------------
  function canvasPointFromEvent(evt) {
    var rect = canvas.getBoundingClientRect();
    return { x: (evt.clientX - rect.left) * (canvas.width / rect.width), y: (evt.clientY - rect.top) * (canvas.height / rect.height) };
  }
  function hitTest(x, y) {
    // nearest entity within radius, else component under pixel
    var best = null, bestD = 26;
    entities().forEach(function (e) { var c = coordsOf(e); if (!c) return; var d = Math.hypot(c.x - x, c.y - y); if (d <= bestD) { bestD = d; best = e; } });
    if (best) return { entityId: best.id };
    var doc = currentLabelmap();
    if (doc) {
      var decoded = decodedLabelmap();
      var xi = Math.round(x), yi = Math.round(y);
      if (xi >= 0 && yi >= 0 && xi < doc.widthPx && yi < doc.heightPx) {
        var label = decoded[yi * doc.widthPx + xi];
        if (label > 0) { var id = doc.entityIds ? doc.entityIds[label - 1] : null; return { entityId: id, component: label }; }
      }
    }
    return null;
  }

  // ---- parameters drawer -----------------------------------------------------------------
  var paramControls = {};
  function stageParamTokens() {
    var inv = currentInvocation(); if (!inv) return [];
    return stageName(inv.stageId).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }
  function paramRelevantToStage(spec) {
    var toks = stageParamTokens();
    var hay = (spec.path + ' ' + spec.label).toLowerCase();
    return toks.some(function (t) { return t.length >= 2 && hay.indexOf(t) !== -1; });
  }
  function getAtPath(root, path) { return path.split('.').reduce(function (c, k) { return (c && typeof c === 'object') ? c[k] : undefined; }, root); }
  function renderParams() {
    var grid = document.getElementById('paramGrid'); grid.innerHTML = ''; paramControls = {};
    if (!state.session || !state.run) return;
    var specs = state.session.paramSchema.slice();
    specs.sort(function (a, b) { return (paramRelevantToStage(b) ? 1 : 0) - (paramRelevantToStage(a) ? 1 : 0); });
    var inv = currentInvocation();
    document.getElementById('drawerStageNote').textContent = inv ? 'relevant to ' + stageName(inv.stageId) + ' shown first' : '';
    specs.forEach(function (spec) {
      var row = document.createElement('div');
      row.className = 'prow' + (paramRelevantToStage(spec) ? ' forstage' : '');
      var cur = getAtPath(state.run.effectiveConfig, spec.path);
      var val = cur === undefined ? spec.default : cur;
      var tag = paramRelevantToStage(spec) ? '<span class="tag">this stage</span>' : '';
      var label = '<div class="plabel">' + esc(spec.label) + tag + '</div>';
      var ctl = document.createElement('div'); ctl.className = 'pctl';
      if (spec.type === 'boolean') {
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!val;
        cb.addEventListener('change', updatePatch); ctl.appendChild(cb);
        paramControls[spec.path] = { spec: spec, get: function () { return cb.checked; } };
      } else if (spec.type === 'number') {
        var range = document.createElement('input'); range.type = 'range';
        if (spec.min !== undefined) range.min = spec.min; if (spec.max !== undefined) range.max = spec.max; if (spec.step !== undefined) range.step = spec.step;
        range.value = val;
        var num = document.createElement('input'); num.type = 'number'; num.value = val;
        if (spec.min !== undefined) num.min = spec.min; if (spec.max !== undefined) num.max = spec.max; if (spec.step !== undefined) num.step = spec.step;
        range.addEventListener('input', function () { num.value = range.value; updatePatch(); });
        num.addEventListener('input', function () { range.value = num.value; updatePatch(); });
        ctl.appendChild(num); ctl.appendChild(range);
        paramControls[spec.path] = { spec: spec, get: function () { return Number(num.value); } };
      } else {
        var sel = document.createElement('select');
        (spec.options || []).forEach(function (o) { var op = document.createElement('option'); op.value = o; op.textContent = o; sel.appendChild(op); });
        sel.value = String(val); sel.addEventListener('change', updatePatch); ctl.appendChild(sel);
        paramControls[spec.path] = { spec: spec, get: function () { return sel.value; } };
      }
      row.innerHTML = label; row.appendChild(ctl); grid.appendChild(row);
    });
    updatePatch();
  }
  function currentPatch() {
    var patch = {};
    Object.keys(paramControls).forEach(function (path) {
      var ctl = paramControls[path], v = ctl.get();
      var base = getAtPath(state.run.effectiveConfig, path); if (base === undefined) base = ctl.spec.default;
      if (String(v) !== String(base)) patch[path] = v;
    });
    return patch;
  }
  function updatePatch() {
    var patch = currentPatch(), keys = Object.keys(patch);
    document.getElementById('patchPreview').textContent = keys.length ? JSON.stringify(patch) : '(no changes)';
    document.getElementById('applyBtn').disabled = keys.length === 0 || !state.selectedRunId;
  }

  // ---- runs / experiment tree / A-B / table (advanced) -----------------------------------
  function patchSummary(run) {
    if (!run.patch) return 'baseline';
    return Object.keys(run.patch).map(function (k) { return shortParam(k) + '=' + JSON.stringify(run.patch[k]); }).join(', ');
  }
  function shortParam(path) {
    var spec = state.session && state.session.paramSchema.find(function (s) { return s.path === path; });
    return spec ? spec.label : path;
  }
  function runDisplayName(run) {
    if (!run.patch) return 'baseline';
    var p = patchSummary(run);
    return p.length > 40 ? p.slice(0, 39) + '…' : p;
  }
  function renderTree() {
    var el = document.getElementById('tree'); el.innerHTML = ''; if (!state.session) return;
    var childrenOf = {};
    state.session.runs.forEach(function (r) { var k = r.parentRunId === null ? '__root__' : r.parentRunId; (childrenOf[k] = childrenOf[k] || []).push(r); });
    function build(key) {
      var list = childrenOf[key]; if (!list) return null;
      var ul = document.createElement('ul');
      list.forEach(function (run) {
        var li = document.createElement('li'); var node = document.createElement('div');
        node.className = 'treenode' + (run.runId === state.selectedRunId ? ' selected' : '') + (run.runId === state.pinnedA ? ' pinnedA' : '') + (run.runId === state.pinnedB ? ' pinnedB' : '');
        node.textContent = runDisplayName(run) + '  ' + summaryPreview(run);
        node.addEventListener('click', function () { selectRun(run.runId); });
        li.appendChild(node); var c = build(run.runId); if (c) li.appendChild(c); ul.appendChild(li);
      });
      return ul;
    }
    var root = build('__root__'); if (root) el.appendChild(root);
  }
  function summaryPreview(run) {
    return Object.keys(run.summary || {}).slice(0, 2).map(function (k) { return summaryLabel(k) + '=' + run.summary[k]; }).join(' · ');
  }
  function renderAb() {
    var el = document.getElementById('abControls'); el.innerHTML = '';
    var mk = function (txt, fn, dis) { var b = document.createElement('button'); b.textContent = txt; b.disabled = dis; b.addEventListener('click', fn); return b; };
    el.appendChild(mk('pin A', function () { state.pinnedA = state.selectedRunId; renderAb(); renderTree(); maybeDiff(); }, !state.selectedRunId));
    el.appendChild(mk('pin B', function () { state.pinnedB = state.selectedRunId; renderAb(); renderTree(); maybeDiff(); }, !state.selectedRunId));
    document.getElementById('abStatus').textContent = 'A=' + (state.pinnedA ? runLabelById(state.pinnedA) : '(none)') + '   B=' + (state.pinnedB ? runLabelById(state.pinnedB) : '(none)');
    renderDiff();
  }
  function runLabelById(id) { var r = state.session.runs.find(function (x) { return x.runId === id; }); return r ? runDisplayName(r) : id.slice(0, 8); }
  function maybeDiff() {
    if (!state.pinnedA || !state.pinnedB) { state.diff = null; renderStagebar(); return; }
    getJson('/api/diff?a=' + encodeURIComponent(state.pinnedA) + '&b=' + encodeURIComponent(state.pinnedB))
      .then(function (d) { state.diff = d; renderDiff(); renderStagebar(); })
      .catch(function (e) { state.diff = { error: e.message }; renderDiff(); });
  }
  function renderDiff() {
    var el = document.getElementById('diffBody'); el.innerHTML = '';
    if (!state.diff) return;
    if (state.diff.error) { el.innerHTML = '<div class="err">' + esc(state.diff.error) + '</div>'; return; }
    var html = '';
    if (state.diff.firstDivergentStage) {
      var fd = state.diff.firstDivergentStage;
      html += '<div style="margin:6px 0"><b>First divergence:</b> ' + esc(fd.stageName || ('stage#' + fd.stageId)) + ' — ' + esc(fd.reason) + '</div>';
    } else html += '<div class="ok" style="margin:6px 0">Equivalent through every shared stage.</div>';
    if (state.diff.summaryDiff && state.diff.summaryDiff.length) {
      html += '<table><thead><tr><th>outcome</th><th class="a">A</th><th class="b">B</th></tr></thead><tbody>';
      state.diff.summaryDiff.forEach(function (d) { html += '<tr><td>' + esc(summaryLabel(d.key)) + '</td><td class="a">' + esc(JSON.stringify(d.a)) + '</td><td class="b">' + esc(JSON.stringify(d.b)) + '</td></tr>'; });
      html += '</tbody></table>';
    }
    el.innerHTML = html;
  }
  function renderTable() {
    var table = document.getElementById('runsTable'), thead = table.querySelector('thead'), tbody = table.querySelector('tbody');
    thead.innerHTML = ''; tbody.innerHTML = ''; if (!state.session) return;
    var runs = state.session.runs.slice(); var keys = [];
    runs.forEach(function (r) { Object.keys(r.summary || {}).forEach(function (k) { if (keys.indexOf(k) === -1) keys.push(k); }); });
    var cols = ['run'].concat(keys);
    if (state.sortKey) runs.sort(function (a, b) { var x = state.sortKey === 'run' ? runDisplayName(a) : (a.summary || {})[state.sortKey]; var y = state.sortKey === 'run' ? runDisplayName(b) : (b.summary || {})[state.sortKey]; if (x === y) return 0; if (x === undefined) return 1; if (y === undefined) return -1; return (x < y ? -1 : 1) * state.sortDir; });
    var tr = document.createElement('tr');
    cols.forEach(function (c) { var th = document.createElement('th'); th.textContent = (c === 'run' ? 'run' : summaryLabel(c)) + (state.sortKey === c ? (state.sortDir === 1 ? ' ▲' : ' ▼') : ''); th.addEventListener('click', function () { if (state.sortKey === c) state.sortDir = -state.sortDir; else { state.sortKey = c; state.sortDir = 1; } renderTable(); }); tr.appendChild(th); });
    thead.appendChild(tr);
    runs.forEach(function (run) {
      var row = document.createElement('tr'); if (run.runId === state.selectedRunId) row.className = 'sel'; row.style.cursor = 'pointer';
      row.addEventListener('click', function () { selectRun(run.runId); });
      cols.forEach(function (c) { var td = document.createElement('td'); td.textContent = c === 'run' ? runDisplayName(run) : ((run.summary || {})[c] === undefined ? '' : String((run.summary || {})[c])); row.appendChild(td); });
      tbody.appendChild(row);
    });
  }
  function renderGridForm() {
    var el = document.getElementById('gridForm'); el.innerHTML = ''; if (!state.session) return;
    [0, 1].forEach(function (slot) {
      var row = document.createElement('div'); row.className = 'gridrow';
      var sel = document.createElement('select'); var none = document.createElement('option'); none.value = ''; none.textContent = slot === 0 ? '(pick a param)' : '(optional 2nd axis)'; sel.appendChild(none);
      state.session.paramSchema.forEach(function (s) { var o = document.createElement('option'); o.value = s.path; o.textContent = s.label; sel.appendChild(o); });
      var vals = document.createElement('input'); vals.type = 'text'; vals.placeholder = 'comma-separated values';
      row.appendChild(sel); row.appendChild(vals); el.appendChild(row); el['slot' + slot] = { select: sel, values: vals };
    });
  }

  // ---- session / run loading -------------------------------------------------------------
  function loadSession() {
    return getJson('/api/session').then(function (s) {
      state.session = s;
      document.getElementById('pipelineMeta').textContent = s.pipelineId + '  ·  ' + (s.source && s.source.name) + '  ·  ' + s.runs.length + ' run' + (s.runs.length === 1 ? '' : 's');
      renderTree(); renderTable(); renderAb(); renderGridForm();
      if (state.selectedRunId === null) { var base = s.runs.find(function (r) { return r.parentRunId === null; }); if (base) return selectRun(base.runId); }
    });
  }
  function selectRun(runId) {
    state.selectedRunId = runId; state.diff = null;
    return Promise.all([
      getJson('/api/run/' + encodeURIComponent(runId)),
      getJson('/api/run/' + encodeURIComponent(runId) + '/trace'),
      getJsonOrNull('/api/run/' + encodeURIComponent(runId) + '/manifest'),
      getJsonOrNull('/api/run/' + encodeURIComponent(runId) + '/labelmaps'),
    ]).then(function (r) {
      state.run = r[0]; state.trace = r[1]; state.manifest = r[2]; state.labelmaps = r[3];
      maskCache = { key: null, canvas: null }; decodedCache = { runId: null, doc: null, decoded: null };
      state.stageIndex = state.trace.stages.length - 1;
      state.selectedEntityId = null; state.selectedEvidence = -1;
      renderStagebar(); renderStageEvidence(); renderSelection(); renderLegend();
      renderTree(); renderTable(); renderAb(); renderParams();
      draw();
    });
  }

  // ---- events ----------------------------------------------------------------------------
  document.getElementById('maskBtn').addEventListener('click', cycleMask);
  document.getElementById('zoomIn').addEventListener('click', function () { applyZoom(state.zoom * 1.25); });
  document.getElementById('zoomOut').addEventListener('click', function () { applyZoom(state.zoom / 1.25); });
  document.getElementById('zoomFit').addEventListener('click', fit);
  document.getElementById('obsPrev').addEventListener('click', function () { stepObservation(-1); });
  document.getElementById('obsNext').addEventListener('click', function () { stepObservation(1); });
  document.getElementById('advBtn').addEventListener('click', function () { state.showAdvanced = !state.showAdvanced; document.getElementById('advanced').classList.toggle('hidden', !state.showAdvanced); this.classList.toggle('on', state.showAdvanced); });
  document.getElementById('tuneBtn').addEventListener('click', function () { var d = document.getElementById('drawer'); var open = d.classList.toggle('open'); this.classList.toggle('on', open); if (open) renderParams(); });
  document.getElementById('drawerClose').addEventListener('click', function () { document.getElementById('drawer').classList.remove('open'); document.getElementById('tuneBtn').classList.remove('on'); });
  document.getElementById('applyBtn').addEventListener('click', function () {
    var patch = currentPatch(); if (!Object.keys(patch).length || !state.selectedRunId) return;
    var btn = this; btn.disabled = true; btn.textContent = 'running…';
    postJson('/api/replay', { parentRunId: state.selectedRunId, patch: patch }).then(function (run) {
      btn.textContent = 'apply → new run';
      return loadSession().then(function () { return selectRun(run.runId); });
    }).catch(function (e) { btn.disabled = false; btn.textContent = 'apply → new run'; alert('replay failed: ' + e.message); });
  });
  document.getElementById('gridBtn').addEventListener('click', function () {
    if (!state.selectedRunId) return; var el = document.getElementById('gridForm'); var axes = {};
    [0, 1].forEach(function (slot) { var p = el['slot' + slot]; if (!p || !p.select.value || !p.values.value.trim()) return; var spec = state.session.paramSchema.find(function (s) { return s.path === p.select.value; }); axes[p.select.value] = p.values.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean).map(function (s) { return spec.type === 'boolean' ? s === 'true' : spec.type === 'number' ? Number(s) : s; }); });
    if (!Object.keys(axes).length) { document.getElementById('gridStatus').textContent = 'pick an axis with values.'; return; }
    document.getElementById('gridStatus').textContent = 'running…';
    postJson('/api/grid', { parentRunId: state.selectedRunId, axes: axes }).then(function (runs) { document.getElementById('gridStatus').textContent = runs.length + ' children.'; return loadSession(); }).catch(function (e) { document.getElementById('gridStatus').textContent = 'grid failed: ' + e.message; });
  });

  canvas.addEventListener('click', function (evt) {
    if (dragMoved) return;
    var p = canvasPointFromEvent(evt); var hit = hitTest(p.x, p.y);
    if (!hit) { selectEntity(null); return; }
    if (hit.component) state.selectedComponent = hit.component;
    if (hit.entityId != null) selectEntity(hit.entityId); else { renderSelection(); draw(); }
  });

  // pan (drag) + zoom (wheel)
  var pan = null, dragMoved = false;
  wrap.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 && e.button !== 1) return;
    pan = { x: e.clientX, y: e.clientY, l: wrap.scrollLeft, t: wrap.scrollTop }; dragMoved = false;
    wrap.classList.add('panning'); wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', function (e) {
    if (!pan) return; var dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
    wrap.scrollLeft = pan.l - dx; wrap.scrollTop = pan.t - dy;
  });
  wrap.addEventListener('pointerup', function (e) { if (!pan) return; pan = null; wrap.classList.remove('panning'); try { wrap.releasePointerCapture(e.pointerId); } catch (x) {} });
  wrap.addEventListener('wheel', function (e) { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); applyZoom(state.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY); } }, { passive: false });

  document.addEventListener('keydown', function (e) {
    var tag = e.target && e.target.tagName; if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (!state.trace) return;
    if (e.key === 'ArrowRight') { setStage(state.stageIndex + 1); }
    else if (e.key === 'ArrowLeft') { setStage(state.stageIndex - 1); }
    else if (e.key === '.') { stepObservation(1); }
    else if (e.key === ',') { stepObservation(-1); }
    else if (e.key === 'q' || e.key === 'Q') { applyZoom(state.zoom * 1.25); }
    else if (e.key === 'e' || e.key === 'E') { applyZoom(state.zoom / 1.25); }
    else if (e.key === 'f' || e.key === 'F') { fit(); }
    else if (e.key === 'm' || e.key === 'M') { cycleMask(); }
  });
  window.addEventListener('resize', function () { /* keep zoom; canvas CSS size fixed */ });

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ---- debug hook for the screenshot harness ---------------------------------------------
  window.__tophViewer = {
    ready: function () { return !!state.trace; },
    stageCount: function () { return state.trace ? state.trace.stages.length : 0; },
    setStageByName: function (name) { var i = state.trace.stages.findIndex(function (inv) { return stageName(inv.stageId) === name; }); if (i >= 0) setStage(i); return i; },
    setStageIndex: function (i) { setStage(i); },
    currentStage: function () { var inv = currentInvocation(); return inv ? stageName(inv.stageId) : null; },
    selectEvidenceByLabel: function (label) { var list = stageEvidence(); var i = list.findIndex(function (e) { return e.label === label; }); if (i >= 0) selectEvidence(i); return i; },
    selectEntityBySemantic: function (text) { var e = entities().find(function (x) { return semanticLabel(x) === text; }); if (e) { selectEntity(e.id); return e.id; } return null; },
    setMaskMode: function (m) { setMaskMode(m); },
    openDrawer: function () { document.getElementById('drawer').classList.add('open'); document.getElementById('tuneBtn').classList.add('on'); renderParams(); },
    setAdvanced: function (on) { state.showAdvanced = on; document.getElementById('advanced').classList.toggle('hidden', !on); },
    fit: fit,
  };

  // ---- boot ------------------------------------------------------------------------------
  fetch('/api/source-image').then(function (r) { if (r.ok) { img.src = '/api/source-image?_=' + Date.now(); } }).catch(function () {});
  loadSession().then(function () { setTimeout(fit, 60); }).catch(function (e) {
    document.getElementById('pipelineMeta').textContent = 'failed to load session: ' + e.message;
  });
})();
