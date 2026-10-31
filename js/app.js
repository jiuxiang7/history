const {
  buildIndex,
  cnNumber,
  countLineage,
  getDescendants,
  getKeyPeople,
  validateLineage,
} = window.Genealogy;
const { computeLayout, NODE: NODE_BOX } = window.LineageLayout;

const $ = (selector) => document.querySelector(selector);

const els = {
  app: $('#app'),
  sidebar: $('#sidebar'),
  sidebarToggle: $('#sidebar-toggle'),
  sidebarScrim: $('#sidebar-scrim'),
  lineageList: $('#lineage-list'),
  lineageCount: $('#lineage-count'),
  keyList: $('#key-list'),
  generationLabels: $('#generation-labels'),
  currentPeriod: $('#current-period'),
  currentTitle: $('#current-title'),
  currentStats: $('#current-stats'),
  expandAll: $('#expand-all'),
  fitView: $('#fit-view'),
  canvas: $('#canvas'),
  stage: $('#stage'),
  viewport: $('#viewport'),
  layerLinks: $('#layer-links'),
  layerExtras: $('#layer-extras'),
  layerNodes: $('#layer-nodes'),
  viewHint: $('#view-hint'),
  zoomReadout: $('#zoom-readout'),
  zoomIn: $('#zoom-in'),
  zoomOut: $('#zoom-out'),
  resetView: $('#reset-view'),
  minimap: $('#minimap'),
  minimapSvg: $('#minimap-svg'),
  emptyState: $('#empty-state'),
  emptyExpand: $('#empty-expand'),
  loading: $('#loading'),
  errorPanel: $('#error-panel'),
  errorCopy: $('#error-copy'),
  errorRetry: $('#error-retry'),
  detail: $('#detail'),
  detailScroll: $('#detail-scroll'),
  toast: $('#toast'),
};

const state = {
  manifest: null,
  lineages: new Map(),
  activeId: null,
  entry: null,
  index: null,
  keyPeople: [],
  layout: null,
  hidden: new Set(),
  selectedId: null,
  scale: 1,
  tx: 0,
  ty: 0,
  fitScale: 1,
  viewportW: 0,
  viewportH: 0,
  pointers: new Map(),
  dragging: false,
  dragStart: null,
  moved: 0,
  pinch: null,
  suppressClick: false,
  animation: 0,
  loadToken: 0,
  toastTimer: 0,
  detailPersonId: null,
  hintTimer: 0,
};

const HONOR_LABEL = {
  emperor: '帝王',
  other: '其他重要人物',
};

// 会出现在左侧索引里的类别；具体到某个人还要看 indexed 字段。
const INDEXED_HONORS = ['emperor', 'other'];

const KEY_GLYPH = {
  emperor: `<path d="M3 18 L4.5 7 L9 12 L12 5 L15 12 L19.5 7 L21 18 Z"></path>
    <path d="M3 21 H21"></path>`,
  other: `<path d="M12 2.5 L14.9 8.8 L21.7 9.6 L16.6 14.2 L18 21 L12 17.5 L6 21 L7.4 14.2 L2.3 9.6 L9.1 8.8 Z"></path>`,
};

function keyHonor(person) {
  if (!person || person.importance !== 'key') return '';
  return person.honor === 'emperor' ? 'emperor' : 'other';
}

// 角标：帝王是冠、其他重要人物是星。与进不进左侧索引无关。
function keyMark(honor) {
  return KEY_GLYPH[honor] || '';
}

// 第二类帝王（indexed: false）外观与第一类完全一致，只是不占左侧索引的位置。
function inKeyIndex(person) {
  if (!person || person.indexed === false) return false;
  return INDEXED_HONORS.includes(keyHonor(person));
}

function keyGlyph(honor, className = '') {
  if (!KEY_GLYPH[honor]) return '';
  return `<svg class="key-glyph key-glyph-${honor}${className ? ` ${className}` : ''}" viewBox="0 0 24 24" aria-hidden="true">${KEY_GLYPH[honor]}</svg>`;
}

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPE_MAP[character]);
}

function truncate(value, maxLength) {
  const characters = Array.from(String(value ?? ''));
  if (characters.length <= maxLength) return characters.join('');
  return `${characters.slice(0, Math.max(1, maxLength - 1)).join('')}…`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function uniqueIds(ids) {
  return [...new Set(ids.filter(Boolean))];
}

function isMobileLayout() {
  return window.matchMedia('(max-width: 900px)').matches;
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (!raw) return {};
  const parts = raw.split('/').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  return {
    lineage: parts[0] || '',
    person: parts[1] || '',
  };
}

function updateHash() {
  if (!state.activeId) return;
  const selected =
    state.selectedId && state.index?.byId.has(state.selectedId)
      ? `/${encodeURIComponent(state.selectedId)}`
      : '';
  const next = `#/${encodeURIComponent(state.activeId)}${selected}`;
  if (window.location.hash === next) return;
  try {
    window.history.replaceState(null, '', next);
  } catch {
    // file:// 下部分浏览器不允许改写地址，退回 hash。
    try {
      window.location.hash = next;
    } catch {
      // 仍失败则忽略，页面功能不受影响。
    }
  }
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add('show');
  state.toastTimer = window.setTimeout(() => els.toast.classList.remove('show'), 2300);
}

function fadeHint() {
  if (!els.viewHint || els.viewHint.classList.contains('faded')) return;
  els.viewHint.classList.add('faded');
}

function setLoadingDone() {
  els.loading.classList.add('done');
  window.setTimeout(() => {
    els.loading.hidden = true;
  }, 460);
}

function showError(error) {
  setLoadingDone();
  els.emptyState.hidden = true;
  els.errorPanel.hidden = false;
  els.errorCopy.textContent = error instanceof Error ? error.message : String(error);
}

function syncViewport() {
  const width = Math.max(1, els.canvas.clientWidth);
  const height = Math.max(1, els.canvas.clientHeight);
  els.stage.setAttribute('viewBox', `0 0 ${width} ${height}`);
  state.viewportW = width;
  state.viewportH = height;
}

function observeResize() {
  syncViewport();
  const observer = new ResizeObserver(() => {
    const previousWidth = state.viewportW;
    const previousHeight = state.viewportH;
    syncViewport();
    if (state.layout && previousWidth && previousHeight) {
      state.tx += (state.viewportW - previousWidth) / 2;
      state.ty += (state.viewportH - previousHeight) / 2;
      applyTransform();
    }
  });
  observer.observe(els.canvas);
}

function getLineageEntries() {
  return Array.isArray(state.manifest?.lineages) ? state.manifest.lineages : [];
}

function renderLineageList() {
  const entries = getLineageEntries();
  els.lineageCount.textContent = `${entries.length} 部`;
  els.lineageList.innerHTML = entries
    .map((meta) => {
      const count = meta.peopleCount ?? '—';
      const active = meta.id === state.activeId;
      return `
        <button class="lineage-item${active ? ' active' : ''}" type="button"
          data-lineage="${escapeHtml(meta.id)}"${active ? ' aria-current="true"' : ''}
          title="${escapeHtml(meta.description || meta.title || '')}">
          <span class="lineage-name">${escapeHtml(meta.title || meta.id)}</span>
          <span class="lineage-period">${escapeHtml(meta.period || '')}</span>
          <span class="lineage-people">${escapeHtml(count)} 人</span>
        </button>`;
    })
    .join('');
}

function updateLineageActive() {
  els.lineageList.querySelectorAll('[data-lineage]').forEach((button) => {
    const active = button.dataset.lineage === state.activeId;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  });
}

function renderKeyList() {
  // 第二类（indexed: false）在画布上照常描金边、戴王冠，只是不进这份索引
  const people = state.keyPeople.filter(inKeyIndex);
  if (!people.length) {
    els.keyList.innerHTML = '<p class="relation-empty">此谱尚未标记重点人物。</p>';
    return;
  }
  const groups = INDEXED_HONORS.map((honor) => ({
    honor,
    label: HONOR_LABEL[honor],
    people: people.filter((person) => keyHonor(person) === honor),
  }));
  els.keyList.innerHTML = groups
    .map(
      (group) => `
      <div class="key-group key-group-${group.honor}${group.people.length ? '' : ' is-empty'}">
        <div class="key-group-head">
          <span class="key-group-icon">${keyGlyph(group.honor)}</span>
          <span>${group.label}</span>
          <span class="key-group-count">${group.people.length}</span>
        </div>
        ${group.people
          .map(
            (person) => `
          <button class="key-item key-item-${group.honor}" type="button" data-key-person="${escapeHtml(
            person.id
          )}"
            title="${escapeHtml(`${group.label} · ${person.title || person.name}`)}">
            <span class="key-mark">${keyGlyph(group.honor)}</span>
            <span class="key-name">${escapeHtml(person.title || person.name)}</span>
          </button>`
          )
          .join('')}
      </div>`
    )
    .join('');
  updateKeyListActive();
}

function updateKeyListActive() {
  els.keyList.querySelectorAll('[data-key-person]').forEach((button) => {
    button.classList.toggle('active', button.dataset.keyPerson === state.selectedId);
  });
}

function renderChrome() {
  if (!state.entry) return;
  const { data } = state.entry;
  const counts = countLineage(data);
  els.currentPeriod.textContent = [data.period, data.subtitle].filter(Boolean).join(' · ');
  els.currentTitle.textContent = data.title;
  els.currentStats.textContent = `${counts.people} 人 · ${counts.generations} 代 · ${counts.unions} 组亲缘`;
  els.expandAll.hidden = state.hidden.size === 0;
  document.title = `${data.title} · 世系`;
}

function getPortraitPath() {
  return (
    state.entry?.data?.defaultPortrait ||
    state.manifest?.site?.defaultPortrait ||
    'assets/portrait.svg'
  );
}

function renderSvg() {
  const layout = state.layout;
  if (!layout || layout.empty) {
    els.layerLinks.innerHTML = '';
    els.layerExtras.innerHTML = '';
    els.layerNodes.innerHTML = '';
    return;
  }

  const unionMarkup = layout.unions
    .map((geometry) => {
      const names = [
        ...geometry.parents.map((node) => node.person.name),
        '→',
        ...geometry.children.map((node) => node.person.name),
      ].join(' ');
      const title = geometry.union.label ? `${geometry.union.label}：${names}` : names;
      const paths = geometry.paths
        .map((path) => `<path class="link-path ${path.kind}" d="${path.d}"></path>`)
        .join('');
      return `<g class="union" data-union="${escapeHtml(geometry.union.id || '')}"><title>${escapeHtml(
        title
      )}</title>${paths}</g>`;
    })
    .join('');

  const extraMarkup = layout.extraLinks
    .map((extra) => {
      const label = extra.link.label || extra.link.type || '关联';
      const rotation = extra.lane ? ` transform="rotate(90 ${extra.label.x} ${extra.label.y})"` : '';
      return `<g class="extra" data-extra="${escapeHtml(extra.link.type || '')}">
        <title>${escapeHtml(`${extra.fromNode.person.name} · ${label} · ${extra.toNode.person.name}`)}</title>
        <path class="extra-link" d="${extra.d}" marker-end="url(#extra-arrow)"></path>
        <text class="extra-label" x="${extra.label.x}" y="${extra.label.y}"${rotation} text-anchor="middle">${escapeHtml(
          label
        )}</text>
      </g>`;
    })
    .join('');

  const portrait = getPortraitPath();
  const nodeMarkup = [...layout.nodes.values()]
    .map((node) => {
      const { person } = node;
      const honor = keyHonor(person);
      const key = Boolean(honor);
      const indexed = key && person.indexed !== false;
      const mark = keyMark(honor);
      const selected = state.selectedId === person.id;
      const aliases = Array.isArray(person.aliases) ? person.aliases.filter(Boolean) : [];
      const alias = aliases[0] || '';
      const classes = [
        'node',
        `node-${person.importance || 'normal'}`,
        key ? 'node-key' : '',
        indexed ? 'node-indexed' : '',
        honor ? `node-honor-${honor}` : '',
        selected ? 'selected' : '',
      ]
        .filter(Boolean)
        .filter((value, index, list) => list.indexOf(value) === index)
        .join(' ');
      const label = `${person.name}${alias ? `，${alias}` : ''}`;
      return `<g class="${classes}" data-id="${escapeHtml(person.id)}"
        transform="translate(${node.x} ${node.y})" tabindex="0" role="button"
        aria-label="${escapeHtml(label)}">
        <rect class="node-halo" x="-72" y="-6" width="144" height="180" rx="8"></rect>
        <rect class="node-card" x="-66" y="0" width="132" height="168" rx="4"></rect>
        <image class="node-portrait" href="${escapeHtml(portrait)}" x="-47" y="7"
          width="94" height="94" preserveAspectRatio="xMidYMid meet"></image>
        <text class="node-name" x="0" y="134">${escapeHtml(truncate(person.name, 6))}</text>
        <text class="node-alias" x="0" y="157">${escapeHtml(truncate(alias, 7))}</text>
        ${
          mark
            ? `<g class="node-key-mark key-mark-${honor}" transform="translate(41 6) scale(0.85)">${mark}</g>`
            : ''
        }
      </g>`;
    })
    .join('');

  els.layerLinks.innerHTML = unionMarkup;
  els.layerExtras.innerHTML = extraMarkup;
  els.layerNodes.innerHTML = nodeMarkup;
}

function renderGenerationLabels() {
  if (!state.layout || state.layout.empty) {
    els.generationLabels.innerHTML = '';
    return;
  }
  els.generationLabels.innerHTML = state.layout.rows
    .filter((row) => row.nodes.length)
    .map((row) => {
      const label = row.generation.label || `第${cnNumber(row.generation.index)}代`;
      const note = row.generation.note || '';
      return `<div class="generation-label" data-row="${row.rowIndex}">
        <span class="gen-index">${escapeHtml(label)}</span>
        ${note ? `<span class="gen-name">${escapeHtml(note)}</span>` : ''}
        <span class="gen-count">${row.nodes.length} 人</span>
      </div>`;
    })
    .join('');
  updateGenerationLabels();
}

function updateGenerationLabels() {
  if (!state.layout) return;
  const height = state.viewportH || els.canvas.clientHeight || 1;
  els.generationLabels.querySelectorAll('[data-row]').forEach((label) => {
    const row = state.layout.rows[Number(label.dataset.row)];
    if (!row) return;
    const y = state.ty + row.y * state.scale;
    label.style.transform = `translateY(${y.toFixed(1)}px)`;
    label.style.opacity = y < -24 || y > height - 14 ? '0' : '1';
  });
}

function renderMinimap() {
  const layout = state.layout;
  if (!layout || layout.empty) {
    els.minimapSvg.setAttribute('viewBox', '0 0 100 100');
    els.minimapSvg.innerHTML = '';
    return;
  }
  const bounds = layout.bounds;
  els.minimapSvg.setAttribute(
    'viewBox',
    `${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`
  );
  const card = NODE_BOX;
  const nodes = [...layout.nodes.values()]
    .map((node) => {
      const honor = keyHonor(node.person);
      const indexed = honor && node.person.indexed !== false;
      const key = honor ? ` key mini-${honor}${indexed ? ' mini-indexed' : ''}` : '';
      return `<rect class="mini-node${key}" x="${node.x - card.width / 2}" y="${node.y}" width="${card.width}" height="${card.height}" rx="4"></rect>`;
    })
    .join('');
  els.minimapSvg.innerHTML = `${nodes}<rect class="mini-viewport" id="mini-viewport" x="0" y="0" width="0" height="0"></rect>`;
  drawMinimapViewport();
}

function drawMinimapViewport() {
  const viewportRect = document.getElementById('mini-viewport');
  if (!viewportRect || !state.layout) return;
  const x = (0 - state.tx) / state.scale;
  const y = (0 - state.ty) / state.scale;
  const width = state.viewportW / state.scale;
  const height = state.viewportH / state.scale;
  viewportRect.setAttribute('x', String(x));
  viewportRect.setAttribute('y', String(y));
  viewportRect.setAttribute('width', String(width));
  viewportRect.setAttribute('height', String(height));
}

function applyTransform() {
  els.viewport.setAttribute(
    'transform',
    `translate(${state.tx.toFixed(2)} ${state.ty.toFixed(2)}) scale(${state.scale.toFixed(4)})`
  );
  els.zoomReadout.textContent = `${Math.round(state.scale * 100)}%`;
  drawMinimapViewport();
  updateGenerationLabels();
}

function getViewportRect() {
  const width = state.viewportW || els.canvas.clientWidth || 1;
  const height = state.viewportH || els.canvas.clientHeight || 1;
  const rail = width > 900 ? 160 : 16;
  let right = width > 640 ? 28 : 16;
  if (els.detail.classList.contains('open') && width > 900) {
    right += Math.min(432, width * 0.58);
  }
  return {
    x: rail,
    y: width > 900 ? 22 : 58,
    width: Math.max(160, width - rail - right),
    height: Math.max(160, height - (width > 900 ? 46 : 112)),
  };
}

function cancelAnimation() {
  if (state.animation) {
    cancelAnimationFrame(state.animation);
    state.animation = 0;
  }
}

function animateTo(target, duration = 380) {
  cancelAnimation();
  const start = { scale: state.scale, tx: state.tx, ty: state.ty };
  const delta = {
    scale: target.scale - start.scale,
    tx: target.tx - start.tx,
    ty: target.ty - start.ty,
  };
  if (
    duration <= 0 ||
    prefersReducedMotion() ||
    (Math.abs(delta.scale) < 0.0005 && Math.abs(delta.tx) < 0.5 && Math.abs(delta.ty) < 0.5)
  ) {
    state.scale = target.scale;
    state.tx = target.tx;
    state.ty = target.ty;
    applyTransform();
    return;
  }

  const startTime = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    state.scale = start.scale + delta.scale * eased;
    state.tx = start.tx + delta.tx * eased;
    state.ty = start.ty + delta.ty * eased;
    applyTransform();
    if (progress < 1) {
      state.animation = requestAnimationFrame(step);
    } else {
      state.animation = 0;
    }
  };
  state.animation = requestAnimationFrame(step);
}

function fitView() {
  if (!state.layout || state.layout.empty) return;
  const bounds = state.layout.bounds;
  const rect = getViewportRect();
  const scale = clamp(
    Math.min(rect.width / bounds.width, rect.height / bounds.height),
    0.1,
    1.15
  );
  const tx = rect.x + (rect.width - bounds.width * scale) / 2 - bounds.minX * scale;
  const ty = rect.y + (rect.height - bounds.height * scale) / 2 - bounds.minY * scale;
  state.fitScale = scale;
  animateTo({ scale, tx, ty }, 420);
}

function initialView() {
  if (!state.layout || state.layout.empty) return;
  const bounds = state.layout.bounds;
  const rect = getViewportRect();
  const fitScale = Math.min(rect.width / bounds.width, rect.height / bounds.height);
  if (fitScale >= 0.64) {
    fitView();
    return;
  }

  const scale = Math.min(Math.max(fitScale, rect.width > 900 ? 0.64 : 0.56), 0.82);
  const firstRow = state.layout.rows[0];
  const top = firstRow ? firstRow.y : bounds.minY;
  // 窄屏上树通常远宽于视口：先让第一代落在视口中央，左右分支由用户横向拖看。
  const firstRowCenter = firstRow?.nodes.length
    ? firstRow.nodes.reduce((sum, node) => sum + node.x + node.width / 2, 0) / firstRow.nodes.length
    : (bounds.minX + bounds.maxX) / 2;
  const tx = rect.width < 720
    ? rect.x + rect.width / 2 - firstRowCenter * scale
    : rect.x + (rect.width - bounds.width * scale) / 2 - bounds.minX * scale;
  const ty = rect.y + 18 - top * scale;
  state.fitScale = fitScale;
  animateTo({ scale, tx, ty }, 520);
}

function zoomAt(factor, screenX, screenY) {
  cancelAnimation();
  const nextScale = clamp(state.scale * factor, 0.1, 2.4);
  if (Math.abs(nextScale - state.scale) < 0.0001) return;
  const worldX = (screenX - state.tx) / state.scale;
  const worldY = (screenY - state.ty) / state.scale;
  state.scale = nextScale;
  state.tx = screenX - worldX * nextScale;
  state.ty = screenY - worldY * nextScale;
  applyTransform();
  fadeHint();
}

function focusPerson(id, duration = 430) {
  const node = state.layout?.nodes.get(id);
  if (!node) return;
  const rect = getViewportRect();
  const scale = clamp(Math.max(state.scale, 0.86), 0.1, 1.6);
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  animateTo(
    {
      scale,
      tx: rect.x + rect.width / 2 - centerX * scale,
      ty: rect.y + rect.height / 2 - centerY * scale,
    },
    duration
  );
  const element = els.layerNodes.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
  if (element) {
    element.classList.remove('just-focused');
    void element.getBoundingClientRect();
    element.classList.add('just-focused');
    window.setTimeout(() => element.classList.remove('just-focused'), 1700);
  }
}

function rebuild({ fit = false } = {}) {
  if (!state.index) return;
  state.layout = computeLayout(state.index.lineage, state.hidden);
  const isEmpty = state.layout.empty || state.layout.visiblePeople.length === 0;
  els.emptyState.hidden = !isEmpty;
  els.expandAll.hidden = state.hidden.size === 0;

  if (state.selectedId && !state.layout.nodes.has(state.selectedId)) {
    closeDetail({ silent: true });
  }

  renderSvg();
  renderGenerationLabels();
  renderMinimap();
  updateSelection();

  if (isEmpty) {
    state.scale = 1;
    state.tx = 0;
    state.ty = 0;
    applyTransform();
  } else if (fit) {
    fitView();
  } else {
    applyTransform();
  }
}

function updateSelection() {
  const selectedId = state.selectedId;
  els.layerNodes.querySelectorAll('.node').forEach((node) => {
    const selected = node.dataset.id === selectedId;
    node.classList.toggle('selected', selected);
    node.setAttribute('aria-pressed', String(selected));
  });
  updateKeyListActive();

  const person = selectedId ? state.index?.byId.get(selectedId) : null;
  const activeRow = person ? state.layout?.generationIndex.get(person.generation) : null;
  els.generationLabels.querySelectorAll('[data-row]').forEach((label) => {
    label.classList.toggle('active', Number(label.dataset.row) === activeRow);
  });
}

function openDetail() {
  els.detail.classList.add('open');
  els.detail.setAttribute('aria-hidden', 'false');
}

function closeDetail({ silent = false, keepSelection = false } = {}) {
  els.detail.classList.remove('open');
  els.detail.setAttribute('aria-hidden', 'true');
  if (!keepSelection) state.selectedId = null;
  updateSelection();
  if (!silent) updateHash();
}

function renderDetail() {
  const person = state.selectedId ? state.index?.byId.get(state.selectedId) : null;
  if (!person) {
    els.detailScroll.innerHTML = '';
    state.detailPersonId = null;
    return;
  }

  const descendants = getDescendants(state.index, person.id);
  const aliases = Array.isArray(person.aliases) ? person.aliases.filter(Boolean) : [];
  const bio = Array.isArray(person.bio) ? person.bio.filter(Boolean) : person.bio ? [person.bio] : [];
  const hasHidden = state.hidden.size > 0;
  const collapsibleCount = [...descendants].filter((id) => !state.hidden.has(id)).length;
  const actionMarkup = `
    <button class="action-button" type="button" data-action="focus">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3"></path><circle cx="12" cy="12" r="4"></circle></svg>
      居中显示
    </button>
    ${
      collapsibleCount
        ? `<button class="action-button" type="button" data-action="collapse">
            折叠后裔 · ${collapsibleCount}
          </button>`
        : ''
    }
    ${
      hasHidden
        ? `<button class="action-button" type="button" data-action="expand">展开全部</button>`
        : ''
    }`;

  els.detailScroll.innerHTML = `
    <div class="detail-head">
      <button class="detail-close" type="button" data-action="close" aria-label="关闭详情">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>
      </button>
    </div>

    <div class="detail-hero">
      <div class="detail-portrait">
        <img src="${escapeHtml(getPortraitPath())}" alt="${escapeHtml(person.name)}的人物像" />
      </div>
      <div>
        <h3 class="detail-name">${escapeHtml(person.name)}</h3>
        ${aliases.length ? `<p class="detail-aliases">${escapeHtml(aliases.join(' · '))}</p>` : ''}
      </div>
    </div>

    <div class="detail-actions">${actionMarkup}</div>

    ${
      bio.length
        ? `<div class="detail-bio detail-bio-standalone">${bio
            .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
            .join('')}</div>`
        : ''
    }`;

  if (state.detailPersonId !== person.id) {
    state.detailPersonId = person.id;
    els.detailScroll.scrollTop = 0;
  }
}

function selectPerson(id, { focus = false, open = true } = {}) {
  if (!state.index?.byId.has(id)) return;
  if (state.hidden.has(id)) {
    state.hidden.clear();
    rebuild({ fit: false });
  }
  state.selectedId = id;
  updateSelection();
  renderDetail();
  if (open) openDetail();
  updateHash();
  if (focus) focusPerson(id);
}

function collapseDescendants() {
  if (!state.selectedId) return;
  const descendants = getDescendants(state.index, state.selectedId);
  if (!descendants.size) {
    showToast('此人物在谱中没有后裔可折叠。');
    return;
  }
  descendants.forEach((id) => state.hidden.add(id));
  rebuild({ fit: false });
  if (state.selectedId) focusPerson(state.selectedId, 320);
  renderDetail();
  renderChrome();
  showToast(`已折叠 ${descendants.size} 位后裔`);
}

function expandAll() {
  if (!state.hidden.size) {
    showToast('当前没有折叠的人物。');
    return;
  }
  const count = state.hidden.size;
  state.hidden.clear();
  rebuild({ fit: false });
  if (state.selectedId) focusPerson(state.selectedId, 420);
  renderDetail();
  renderChrome();
  showToast(`已展开 ${count} 位人物`);
}

function centerInView(duration = 320) {
  if (!state.layout || state.layout.empty) return;
  const bounds = state.layout.bounds;
  const rect = getViewportRect();
  const width = bounds.width * state.scale;
  const height = bounds.height * state.scale;
  const tx = rect.x + (rect.width - width) / 2 - bounds.minX * state.scale;
  let ty = state.ty;
  const top = bounds.minY * state.scale + ty;
  const bottom = top + height;
  if (height <= rect.height) {
    ty = rect.y + (rect.height - height) / 2 - bounds.minY * state.scale;
  } else if (top < rect.y) {
    ty += rect.y - top;
  } else if (bottom > rect.y + rect.height) {
    ty -= bottom - (rect.y + rect.height);
  }
  animateTo({ scale: state.scale, tx, ty }, duration);
}

function toggleSidebar() {
  if (isMobileLayout()) {
    const open = els.app.classList.toggle('sidebar-open');
    els.app.classList.remove('sidebar-collapsed');
    els.sidebarScrim.hidden = !open;
    els.sidebarToggle.setAttribute('aria-expanded', String(open));
  } else {
    const collapsed = els.app.classList.toggle('sidebar-collapsed');
    els.sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
    window.setTimeout(() => {
      if (!isMobileLayout()) centerInView();
    }, 340);
  }
}

function closeMobileSidebar() {
  if (!isMobileLayout()) return;
  els.app.classList.remove('sidebar-open');
  els.sidebarScrim.hidden = true;
  els.sidebarToggle.setAttribute('aria-expanded', 'false');
}

async function getLineageEntry(meta) {
  if (state.lineages.has(meta.id)) return state.lineages.get(meta.id);
  const data = window.LINEAGE_LIBRARY?.lineages?.[meta.id];
  if (!data) throw new Error(`数据文件里没有「${meta.title || meta.id}」这部谱系。`);
  validateLineage(data, meta.title || meta.id);
  const index = buildIndex(data);
  const entry = {
    meta,
    data,
    index,
    keyPeople: getKeyPeople(index),
  };
  state.lineages.set(meta.id, entry);
  return entry;
}

async function activateLineage(id, { personId = '' } = {}) {
  const meta = getLineageEntries().find((entry) => entry.id === id) || getLineageEntries()[0];
  if (!meta) throw new Error('manifest.json 中没有可用的谱系。');
  const token = ++state.loadToken;
  state.activeId = meta.id;
  updateLineageActive();
  closeDetail({ silent: true });

  const entry = await getLineageEntry(meta);
  if (token !== state.loadToken) return;

  state.entry = entry;
  state.index = entry.index;
  state.keyPeople = entry.keyPeople;
  state.selectedId = null;
  state.hidden.clear();
  cancelAnimation();

  renderChrome();
  renderKeyList();
  updateLineageActive();
  rebuild({ fit: false });
  initialView();
  setLoadingDone();

  if (personId && entry.index.byId.has(personId)) {
    selectPerson(personId, { focus: true, open: true });
  } else {
    updateHash();
  }
}

function jumpFromMinimap(event) {
  const matrix = els.minimapSvg.getScreenCTM();
  if (!matrix) return;
  const point = els.minimapSvg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const world = point.matrixTransform(matrix.inverse());
  const rect = getViewportRect();
  state.tx = rect.x + rect.width / 2 - world.x * state.scale;
  state.ty = rect.y + rect.height / 2 - world.y * state.scale;
  applyTransform();
}

function screenPoint(clientX, clientY) {
  const rect = els.stage.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function setupCanvasEvents() {
  els.stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? state.viewportH : 1;
    const dx = event.deltaX * unit;
    const dy = event.deltaY * unit;
    if (event.shiftKey && !dx) {
      state.tx -= dy;
    } else {
      state.tx -= dx;
      state.ty -= dy;
    }
    applyTransform();
    fadeHint();
  }, { passive: false });

  els.stage.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.target.closest('.node')) {
      // 点击人物不是拖拽：清掉上一次平移留下的抑制标记，避免人物点击被吞掉。
      state.moved = 0;
      state.suppressClick = false;
      return;
    }
    cancelAnimation();
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      els.stage.setPointerCapture(event.pointerId);
    } catch {
      // 某些触控环境不支持捕获，平移仍可继续。
    }
    if (state.pointers.size === 1) {
      state.dragging = true;
      state.dragStart = {
        x: event.clientX,
        y: event.clientY,
        tx: state.tx,
        ty: state.ty,
      };
      state.moved = 0;
      els.stage.classList.add('is-panning');
    } else if (state.pointers.size === 2) {
      state.dragging = false;
      state.pinch = null;
      els.stage.classList.remove('is-panning');
    }
    fadeHint();
  });

  els.stage.addEventListener('pointermove', (event) => {
    if (!state.pointers.has(event.pointerId)) return;
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (state.pointers.size >= 2) {
      const [first, second] = [...state.pointers.values()];
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      const center = screenPoint((first.x + second.x) / 2, (first.y + second.y) / 2);
      if (!state.pinch) {
        state.pinch = {
          distance,
          scale: state.scale,
          worldX: (center.x - state.tx) / state.scale,
          worldY: (center.y - state.ty) / state.scale,
        };
        return;
      }
      if (!state.pinch.distance) return;
      const nextScale = clamp(
        state.pinch.scale * (distance / state.pinch.distance),
        0.1,
        2.4
      );
      state.scale = nextScale;
      state.tx = center.x - state.pinch.worldX * nextScale;
      state.ty = center.y - state.pinch.worldY * nextScale;
      applyTransform();
      return;
    }

    if (!state.dragging || !state.dragStart) return;
    const dx = event.clientX - state.dragStart.x;
    const dy = event.clientY - state.dragStart.y;
    state.moved = Math.max(state.moved, Math.hypot(dx, dy));
    state.tx = state.dragStart.tx + dx;
    state.ty = state.dragStart.ty + dy;
    applyTransform();
  });

  const endPointer = (event) => {
    const wasDragging = state.dragging;
    state.pointers.delete(event.pointerId);
    if (state.pointers.size < 2) state.pinch = null;
    if (state.pointers.size === 0) {
      state.dragging = false;
      state.dragStart = null;
      els.stage.classList.remove('is-panning');
      if (wasDragging && state.moved > 6) {
        state.suppressClick = true;
        window.setTimeout(() => {
          state.suppressClick = false;
        }, 60);
      }
    }
    try {
      els.stage.releasePointerCapture(event.pointerId);
    } catch {
      // 已经释放时忽略。
    }
  };

  els.stage.addEventListener('pointerup', endPointer);
  els.stage.addEventListener('pointercancel', endPointer);

  els.stage.addEventListener('click', (event) => {
    if (state.suppressClick) return;
    if (event.target.closest('.node')) return;
    closeDetail();
  });

  els.layerNodes.addEventListener('click', (event) => {
    const node = event.target.closest('.node');
    if (!node) return;
    // 人物点击不参与画布拖拽的 click 抑制；拖拽只会命中 stage，不会命中节点。
    selectPerson(node.dataset.id, { focus: false, open: true });
  });

  els.layerNodes.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const node = event.target.closest('.node');
    if (!node) return;
    event.preventDefault();
    selectPerson(node.dataset.id, { focus: false, open: true });
  });

  let minimapPointer = null;
  const moveMinimap = (event) => {
    if (minimapPointer !== event.pointerId) return;
    jumpFromMinimap(event);
  };
  els.minimap.addEventListener('pointerdown', (event) => {
    minimapPointer = event.pointerId;
    try {
      els.minimap.setPointerCapture(event.pointerId);
    } catch {
      // 忽略捕获失败。
    }
    jumpFromMinimap(event);
  });
  els.minimap.addEventListener('pointermove', moveMinimap);
  const endMinimap = (event) => {
    if (minimapPointer === event.pointerId) minimapPointer = null;
  };
  els.minimap.addEventListener('pointerup', endMinimap);
  els.minimap.addEventListener('pointercancel', endMinimap);
}

function setupUiEvents() {
  els.sidebarToggle.addEventListener('click', toggleSidebar);
  els.sidebarScrim.addEventListener('click', closeMobileSidebar);

  els.lineageList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-lineage]');
    if (!button || button.dataset.lineage === state.activeId) return;
    closeMobileSidebar();
    activateLineage(button.dataset.lineage).catch(showError);
  });

  els.keyList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-key-person]');
    if (!button) return;
    closeMobileSidebar();
    if (state.hidden.size) {
      state.hidden.clear();
      rebuild({ fit: false });
    }
    selectPerson(button.dataset.keyPerson, { focus: true, open: true });
  });

  els.detailScroll.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (!action) return;
    if (action.dataset.action === 'close') closeDetail();
    if (action.dataset.action === 'focus') focusPerson(state.selectedId, 360);
    if (action.dataset.action === 'collapse') collapseDescendants();
    if (action.dataset.action === 'expand') expandAll();
  });

  els.fitView.addEventListener('click', fitView);
  els.resetView.addEventListener('click', fitView);
  els.expandAll.addEventListener('click', expandAll);
  els.emptyExpand.addEventListener('click', expandAll);
  els.zoomIn.addEventListener('click', () => {
    const rect = getViewportRect();
    zoomAt(1.22, rect.x + rect.width / 2, rect.y + rect.height / 2);
  });
  els.zoomOut.addEventListener('click', () => {
    const rect = getViewportRect();
    zoomAt(1 / 1.22, rect.x + rect.width / 2, rect.y + rect.height / 2);
  });
  els.errorRetry.addEventListener('click', () => window.location.reload());

  document.addEventListener('keydown', (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('input, textarea, select')) return;
    if (event.key === 'Escape') {
      if (els.detail.classList.contains('open')) {
        closeDetail();
      } else if (isMobileLayout()) {
        closeMobileSidebar();
      }
      return;
    }
    if (event.key === 'f' || event.key === 'F') {
      fitView();
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      const rect = getViewportRect();
      zoomAt(1.2, rect.x + rect.width / 2, rect.y + rect.height / 2);
      return;
    }
    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      const rect = getViewportRect();
      zoomAt(1 / 1.2, rect.x + rect.width / 2, rect.y + rect.height / 2);
    }
  });

  const mobileQuery = window.matchMedia('(max-width: 900px)');
  const handleLayoutChange = () => {
    if (!mobileQuery.matches) {
      els.app.classList.remove('sidebar-open');
      els.sidebarScrim.hidden = true;
      els.sidebarToggle.setAttribute(
        'aria-expanded',
        String(!els.app.classList.contains('sidebar-collapsed'))
      );
    } else {
      els.app.classList.remove('sidebar-collapsed');
      els.sidebarToggle.setAttribute('aria-expanded', 'false');
    }
  };
  if (mobileQuery.addEventListener) mobileQuery.addEventListener('change', handleLayoutChange);
  else mobileQuery.addListener(handleLayoutChange);
}

async function boot() {
  setupUiEvents();
  setupCanvasEvents();
  observeResize();

  try {
    const library = window.LINEAGE_LIBRARY;
    if (!library?.manifest) {
      throw new Error('谱系数据未载入，请确认 data/lineages.js 与 index.html 在同一目录。');
    }
    const manifest = library.manifest;
    state.manifest = manifest;
    const site = manifest.site || {};
    document.title = `${site.title || '世系'} · 家族谱系图`;
    renderLineageList();

    const parsed = parseHash();
    const initialId =
      getLineageEntries().find((entry) => entry.id === parsed.lineage)?.id ||
      manifest.defaultLineage ||
      getLineageEntries()[0]?.id;

    if (!initialId) throw new Error('manifest.json 中没有谱系条目。');

    await activateLineage(initialId, { personId: parsed.person });
    setLoadingDone();
    state.hintTimer = window.setTimeout(fadeHint, 6500);
  } catch (error) {
    console.error(error);
    showError(error);
  }
}

boot();
