(function () {
  'use strict';

  // Small, deliberately non-invasive usability layer over the existing replay viewer.
  // It does not know ChainSpot semantics and does not touch replay execution.

  var style = document.createElement('style');
  style.textContent = `
    html, body { color:#f2f5fb !important; font-size:14px !important; }
    header { padding:8px 12px !important; }
    header h1 { font-size:14px !important; }
    header .meta, .small, .kbd, .runsummary { color:#b8c1d5 !important; }
    #rightPane { flex-basis:340px !important; background:#11141b; }
    section h2 { color:#d7deec !important; font-size:12px !important; }
    .stagechip { font-size:12px !important; padding:5px 8px !important; }
    .paramrow label { color:#eef2fa !important; }
    #inspector { color:#f5f7fc !important; font-size:13px !important; max-height:38% !important; }
    #stageMeasures { color:#d6deef !important; font-size:12px !important; }
    #canvasWrap { cursor:grab; }
    #canvasWrap.panning { cursor:grabbing; user-select:none; }
    #viewerTools { display:flex; gap:5px; margin-left:auto; align-items:center; }
    #viewerTools button { padding:3px 8px; }
    #zoomReadout { min-width:46px; text-align:center; color:#d7deec; }
    body:not(.show-advanced) #gridSection,
    body:not(.show-advanced) #treeSection,
    body:not(.show-advanced) #abSection,
    body:not(.show-advanced) #runsTableWrap { display:none !important; }
    body:not(.show-advanced) #rightPane { overflow-y:auto; }
    .reviewHint { color:#aeb9cf; font-size:11px; margin-left:4px; }
  `;
  document.head.appendChild(style);

  var header = document.querySelector('header');
  var wrap = document.getElementById('canvasWrap');
  var canvas = document.getElementById('stage');
  if (!header || !wrap || !canvas) return;

  var zoom = 1;
  var MIN_ZOOM = 0.2;
  var MAX_ZOOM = 6;
  var labelMap = Object.create(null);

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  var tools = document.createElement('div');
  tools.id = 'viewerTools';
  tools.innerHTML =
    '<button id="zoomOut" title="Zoom out">−</button>' +
    '<span id="zoomReadout">100%</span>' +
    '<button id="zoomIn" title="Zoom in">+</button>' +
    '<button id="zoomFit" title="Fit image to viewport">Fit</button>' +
    '<button id="advancedToggle" title="Grid, experiment tree, A/B and runs table">Advanced</button>';
  header.appendChild(tools);

  var readout = document.getElementById('zoomReadout');

  function applyZoom(next, anchorClientX, anchorClientY) {
    next = clamp(next, MIN_ZOOM, MAX_ZOOM);
    var old = zoom;
    if (Math.abs(next - old) < 0.0001) return;

    var rect = wrap.getBoundingClientRect();
    var anchorX = anchorClientX == null ? rect.left + rect.width / 2 : anchorClientX;
    var anchorY = anchorClientY == null ? rect.top + rect.height / 2 : anchorClientY;
    var contentX = (wrap.scrollLeft + anchorX - rect.left) / old;
    var contentY = (wrap.scrollTop + anchorY - rect.top) / old;

    zoom = next;
    canvas.style.width = Math.round(canvas.width * zoom) + 'px';
    canvas.style.height = Math.round(canvas.height * zoom) + 'px';
    wrap.scrollLeft = contentX * zoom - (anchorX - rect.left);
    wrap.scrollTop = contentY * zoom - (anchorY - rect.top);
    readout.textContent = Math.round(zoom * 100) + '%';
  }

  function fit() {
    if (!canvas.width || !canvas.height) return;
    var rect = wrap.getBoundingClientRect();
    applyZoom(clamp(Math.min(rect.width / canvas.width, rect.height / canvas.height), MIN_ZOOM, 1));
    wrap.scrollLeft = Math.max(0, (canvas.width * zoom - rect.width) / 2);
    wrap.scrollTop = Math.max(0, (canvas.height * zoom - rect.height) / 2);
  }

  document.getElementById('zoomIn').addEventListener('click', function () { applyZoom(zoom * 1.25); });
  document.getElementById('zoomOut').addEventListener('click', function () { applyZoom(zoom / 1.25); });
  document.getElementById('zoomFit').addEventListener('click', fit);
  document.getElementById('advancedToggle').addEventListener('click', function () {
    document.body.classList.toggle('show-advanced');
    this.textContent = document.body.classList.contains('show-advanced') ? 'Hide advanced' : 'Advanced';
  });

  wrap.addEventListener('wheel', function (e) {
    if (!e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      applyZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
    }
  }, { passive:false });

  // Shift-drag or middle-button drag pans without stealing ordinary click-to-inspect.
  var pan = null;
  wrap.addEventListener('pointerdown', function (e) {
    if (!(e.shiftKey || e.button === 1)) return;
    e.preventDefault();
    pan = { x:e.clientX, y:e.clientY, left:wrap.scrollLeft, top:wrap.scrollTop };
    wrap.classList.add('panning');
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', function (e) {
    if (!pan) return;
    wrap.scrollLeft = pan.left - (e.clientX - pan.x);
    wrap.scrollTop = pan.top - (e.clientY - pan.y);
  });
  wrap.addEventListener('pointerup', function (e) {
    if (!pan) return;
    pan = null;
    wrap.classList.remove('panning');
    try { wrap.releasePointerCapture(e.pointerId); } catch (_) {}
  });

  // Q/E matches ChainSpot's existing zoom muscle-memory. F fits. Ignore form fields.
  document.addEventListener('keydown', function (e) {
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === 'q' || e.key === 'Q') { e.preventDefault(); applyZoom(zoom * 1.25); }
    else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); applyZoom(zoom / 1.25); }
    else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); fit(); }
  });

  function prettyKind(name) {
    return String(name || '').replace(/[_\-.]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function semanticLabel(kind, ordinal, attrs) {
    attrs = attrs || {};
    var hole = attrs.holeNumber != null ? attrs.holeNumber :
      attrs.hole != null ? attrs.hole : attrs.assignedHoleNumber;
    var pretty = prettyKind(kind);
    if (/^hole$/i.test(kind) && hole == null) hole = ordinal;
    if (hole != null && /tee|basket|hole/i.test(kind)) return pretty + ' · Hole ' + hole;
    // Never present a raw ordinal as though it were a semantic object number.
    return pretty + ' · candidate ' + ordinal;
  }

  function refreshSemanticLabels() {
    fetch('/api/session').then(function (r) { return r.json(); }).then(function (session) {
      var selected = document.querySelector('.treenode.selected');
      var run = null;
      if (selected) {
        var txt = selected.textContent || '';
        run = session.runs.find(function (r) { return txt.indexOf(r.runId) !== -1 || txt.indexOf(r.runId.slice(0, 8)) !== -1; });
      }
      if (!run) run = session.runs[0];
      if (!run) return;
      return Promise.all([
        fetch('/api/run/' + encodeURIComponent(run.runId) + '/trace').then(function (r) { return r.json(); }),
        fetch('/api/run/' + encodeURIComponent(run.runId) + '/manifest').then(function (r) { return r.ok ? r.json() : null; })
      ]).then(function (parts) {
        var trace = parts[0], manifest = parts[1];
        var kinds = Object.create(null);
        if (manifest && manifest.entityKinds) manifest.entityKinds.forEach(function (k) { kinds[k.id] = k.name; });
        labelMap = Object.create(null);
        (trace.entities || []).forEach(function (entity) {
          var kind = kinds[entity.kindId] || ('kind ' + entity.kindId);
          labelMap[kind + '#' + entity.ordinal] = semanticLabel(kind, entity.ordinal, entity.attrs);
        });
        // Force a harmless redraw through the active stage chip so patched labels appear now.
        var active = document.querySelector('.stagechip.active');
        if (active) active.click();
      });
    }).catch(function () {});
  }

  // Make raster labels readable and honest. The old labels looked like semantic IDs even
  // when they were only candidate ordinals; this explicitly says "candidate" unless a
  // holeNumber-like attribute exists.
  var originalFillText = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
    var rendered = labelMap[text] || text;
    var isOverlayLabel = typeof text === 'string' && (/#\d+$/.test(text) || text === 'assigned' || text === 'reassigned');
    if (!isOverlayLabel) return originalFillText.apply(this, arguments);

    this.save();
    this.font = 'bold 13px "SF Mono", Menlo, monospace';
    this.lineWidth = 4;
    this.strokeStyle = 'rgba(0,0,0,.9)';
    this.globalAlpha = 1;
    this.strokeText(rendered, x, y, maxWidth);
    this.fillStyle = text === 'reassigned' ? '#ffdf6e' : '#f7fbff';
    var args = maxWidth === undefined ? [rendered, x, y] : [rendered, x, y, maxWidth];
    originalFillText.apply(this, args);
    this.restore();
  };

  // Keep semantic label mapping current when runs/stages change.
  document.addEventListener('click', function (e) {
    if (e.target && (e.target.closest('.treenode') || e.target.closest('#applyBtn') || e.target.closest('#gridBtn'))) {
      setTimeout(refreshSemanticLabels, 250);
    }
  });

  // Fit once the source image / baseline draw has had a chance to establish dimensions.
  setTimeout(function () { refreshSemanticLabels(); fit(); }, 700);
})();
