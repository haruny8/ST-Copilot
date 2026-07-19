/**
 * feature-stats.js
 * Usage statistics: records per-day counts of messages/regens/sessions/
 * tokens/quick-prompts/lorebook-changes/edits (global, per-character, and
 * per-chat scopes), and renders the Stats pane (pill filters, summary
 * cards, animated SVG line chart with hover tooltip).
 *
 * Moved from original index.js "Dirty State Tracking (item 1)" section
 * (lines 5553–6003 — everything from the `_SM` metric map onward; the
 * literal "dirty dot" tracking at the top of that section, lines 5524–5548,
 * is UNRELATED to stats — it tracks whether Settings-panel profile/theme
 * forms have unsaved changes, and depends on `isConfigProfileDirty`/
 * `isThemeDirty`/`_takeProfileSnapshot`, which live ~6000 lines away in the
 * Settings Panel code. That belongs in `ui/ui-settings.js` in a later pass,
 * not here — don't be surprised it's missing from this file.
 */

import { EXT_DISPLAY } from '../constants.js';
import { getSettings, saveSettings } from '../settings.js';
import { getBindingKey } from '../utils/util-st.js';
import { escHtml, showCustomDialog } from '../utils/util-dom.js';

// Metric index map. Import STAT.msg, STAT.regen, etc. as the `metricIdx`
// argument to recordStat() — e.g. `recordStat(STAT.sess)` from session.js.
export const STAT = { msg: 0, regen: 1, sess: 2, tokIn: 3, tokOut: 4, qp: 5, lb: 6, edit: 7 };
const _STAT_N = 8;
const _STAT_META = [
    { key: 'msg', label: 'Messages', icon: '💬', color: '#7c6dfa' },
    { key: 'regen', label: 'Regens', icon: '🔄', color: '#4caf7d' },
    { key: 'sess', label: 'Sessions', icon: '📂', color: '#ffb432' },
    { key: 'tokIn', label: 'Tokens In', icon: '📥', color: '#5bc0eb' },
    { key: 'tokOut', label: 'Tokens Out', icon: '📤', color: '#f06292' },
    { key: 'qp', label: 'QPrompts', icon: '⚡', color: '#ff8a65' },
    { key: 'lb', label: 'LB Changes', icon: '📖', color: '#ab47bc' },
    { key: 'edit', label: 'Edits', icon: '✏️', color: '#78909c' },
];

function _ensureStats() {
    const s = getSettings();
    if (!s.stats) s.stats = { g: {}, c: {}, ch: {} };
    if (!s.stats.g) s.stats.g = {};
    if (!s.stats.c) s.stats.c = {};
    if (!s.stats.ch) s.stats.ch = {};
    return s.stats;
}

function _statDateKey() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function _toDateKey(d) {
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export function recordStat(metricIdx, value = 1) {
    try {
        if (metricIdx < 0 || metricIdx >= _STAT_N || !value) return;
        const st = _ensureStats();
        const dk = _statDateKey();
        const { charId, chatId } = getBindingKey();
        const chk = `${charId}\x1f${chatId}`;
        const inc = obj => {
            if (!obj[dk]) obj[dk] = [0, 0, 0, 0, 0, 0, 0, 0];
            obj[dk][metricIdx] = (obj[dk][metricIdx] || 0) + value;
        };
        inc(st.g);
        if (!st.c[charId]) st.c[charId] = {};
        inc(st.c[charId]);
        if (!st.ch[chk]) st.ch[chk] = {};
        inc(st.ch[chk]);
        saveSettings();
    } catch (_) {}
}

function _statGetObj(scope) {
    const st = _ensureStats();
    const { charId, chatId } = getBindingKey();
    if (scope === 'g') return st.g;
    if (scope === 'ch') return st.ch[`${charId}\x1f${chatId}`] || {};
    return st.c[charId] || {};
}

export function getStatBuckets(scope, period) {
    const obj = _statGetObj(scope);
    const now = new Date();
    const EMPTY = () => new Array(_STAT_N).fill(0);
    const results = [];

    if (period === 'day') {
        for (let i = 29; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
            const v = obj[_toDateKey(d)];
            const vals = v ? v.slice() : EMPTY();
            while (vals.length < _STAT_N) vals.push(0);
            const lbl = i === 0 ? 'Today' : `${d.getMonth() + 1}/${d.getDate()}`;
            results.push({ label: lbl, vals });
        }
    } else if (period === 'week') {
        for (let w = 11; w >= 0; w--) {
            const wEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - w * 7);
            const wStart = new Date(wEnd.getFullYear(), wEnd.getMonth(), wEnd.getDate() - 6);
            const agg = EMPTY();
            for (let d = 0; d <= 6; d++) {
                const day = new Date(wStart.getFullYear(), wStart.getMonth(), wStart.getDate() + d);
                const v = obj[_toDateKey(day)];
                if (v) v.forEach((n, i) => { if (i < _STAT_N) agg[i] += (n || 0); });
            }
            results.push({ label: w === 0 ? 'This wk' : `${wStart.getMonth() + 1}/${wStart.getDate()}`, vals: agg });
        }
    } else if (period === 'month') {
        for (let m = 11; m >= 0; m--) {
            const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
            const y = d.getFullYear(), mo = d.getMonth();
            const agg = EMPTY();
            const days = new Date(y, mo + 1, 0).getDate();
            for (let day = 1; day <= days; day++) {
                const key = `${y}${String(mo + 1).padStart(2, '0')}${String(day).padStart(2, '0')}`;
                const v = obj[key];
                if (v) v.forEach((n, i) => { if (i < _STAT_N) agg[i] += (n || 0); });
            }
            results.push({ label: d.toLocaleString('default', { month: 'short', year: m > 0 ? '2-digit' : undefined }), vals: agg });
        }
    } else {
        const allKeys = Object.keys(obj);
        const yearsSet = new Set(allKeys.map(k => k.slice(0, 4)));
        yearsSet.add(String(now.getFullYear()));
        const years = [...yearsSet].sort();
        for (const y of years) {
            const agg = EMPTY();
            allKeys.forEach(k => {
                if (k.startsWith(y)) {
                    const v = obj[k];
                    if (v) v.forEach((n, i) => { if (i < _STAT_N) agg[i] += (n || 0); });
                }
            });
            results.push({ label: y, vals: agg });
        }
        if (!results.length) results.push({ label: String(now.getFullYear()), vals: EMPTY() });
    }
    return results;
}

export function getStatTotals(scope) {
    const obj = _statGetObj(scope);
    const totals = new Array(_STAT_N).fill(0);
    Object.values(obj).forEach(v => {
        if (Array.isArray(v)) v.forEach((n, i) => { if (i < _STAT_N) totals[i] += (n || 0); });
    });
    return totals;
}

function _fmtNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
}

let _statsState = { scope: 'g', period: 'day', metric: 0 };

export function renderStatsPane(container) {
    if (!container) return;
    container.innerHTML = '';

    const s = _statsState;

    const controls = document.createElement('div');
    controls.className = 'scp-stats-controls';

    const mkPillRow = (label, items, stateKey, onSelect) => {
        const row = document.createElement('div');
        row.className = 'scp-stats-pill-row';
        const lbl = document.createElement('span');
        lbl.className = 'scp-stats-pill-label';
        lbl.textContent = label;
        row.appendChild(lbl);
        items.forEach(([val, txt]) => {
            const btn = document.createElement('button');
            btn.className = `scp-stats-pill${s[stateKey] === val ? ' active' : ''}`;
            btn.textContent = txt;
            btn.dataset[stateKey] = val;
            btn.addEventListener('click', () => {
                if (_statsState[stateKey] === val) return;
                _statsState[stateKey] = val;
                container.querySelectorAll(`[data-${stateKey}]`).forEach(b => b.classList.toggle('active', b.dataset[stateKey] === val));
                onSelect(val);
            });
            row.appendChild(btn);
        });
        return row;
    };

    controls.appendChild(mkPillRow('Scope',
        [['g', 'Global'], ['c', 'Character'], ['ch', 'Chat']],
        'scope',
        () => { refreshStatCards(container); refreshStatsChart(container); },
    ));
    controls.appendChild(mkPillRow('Period',
        [['day', '30 Days'], ['week', '12 Weeks'], ['month', '12 Mo'], ['year', 'All Years']],
        'period',
        () => refreshStatsChart(container),
    ));
    container.appendChild(controls);

    const cardsWrap = document.createElement('div');
    cardsWrap.className = 'scp-stats-cards';
    cardsWrap.id = 'scp-stats-cards';
    container.appendChild(cardsWrap);

    const chartWrap = document.createElement('div');
    chartWrap.className = 'scp-stats-chart-wrap';
    chartWrap.id = 'scp-stats-chart-wrap';
    container.appendChild(chartWrap);

    const danger = document.createElement('div');
    danger.className = 'scp-sp-group scp-stats-danger';
    danger.innerHTML = `<div class="scp-sp-group-title" style="color:var(--scp-danger)"><i class="fa-solid fa-triangle-exclamation"></i> Danger Zone</div>`;
    const resetBtn = document.createElement('button');
    resetBtn.className = 'scp-action-btn scp-sp-danger-btn';
    resetBtn.innerHTML = '<i class="fa-solid fa-trash"></i><span>Reset Statistics</span>';
    resetBtn.addEventListener('click', async () => {
        const ok = await showCustomDialog({ type: 'confirm', title: 'Reset Statistics', message: 'Delete ALL collected statistics permanently? This cannot be undone.', delayConfirm: 3 });
        if (!ok) return;
        getSettings().stats = { g: {}, c: {}, ch: {} };
        saveSettings();
        renderStatsPane(container);
        toastr.success('Statistics cleared.', EXT_DISPLAY);
    });
    danger.appendChild(resetBtn);
    container.appendChild(danger);

    refreshStatCards(container);
    refreshStatsChart(container);
}

export function refreshStatCards(container) {
    const wrap = container.querySelector('#scp-stats-cards');
    if (!wrap) return;
    const totals = getStatTotals(_statsState.scope);
    wrap.innerHTML = '';
    _STAT_META.forEach((meta, idx) => {
        const card = document.createElement('div');
        card.className = `scp-stats-card${_statsState.metric === idx ? ' active' : ''}`;
        card.style.setProperty('--scp-stat-color', meta.color);
        card.innerHTML = `<span class="scp-stats-card-icon">${meta.icon}</span><span class="scp-stats-card-val">${_fmtNum(totals[idx])}</span><span class="scp-stats-card-label">${meta.label}</span>`;
        card.addEventListener('click', () => {
            _statsState.metric = idx;
            container.querySelectorAll('.scp-stats-card').forEach((c, i) => c.classList.toggle('active', i === idx));
            refreshStatsChart(container);
        });
        wrap.appendChild(card);
    });
}

export function refreshStatsChart(container) {
    const wrap = container.querySelector('#scp-stats-chart-wrap');
    if (!wrap) return;
    const buckets = getStatBuckets(_statsState.scope, _statsState.period);
    renderSVGChart(wrap, buckets, _statsState.metric, _STAT_META[_statsState.metric]);
}

export function renderSVGChart(container, buckets, metricIdx, meta) {
    const W = 580, H = 170, PL = 38, PR = 12, PT = 14, PB = 30;
    const cW = W - PL - PR, cH = H - PT - PB;
    const vals = buckets.map(b => b.vals[metricIdx] || 0);
    const maxVal = Math.max(...vals, 1);

    const px = i => PL + (buckets.length < 2 ? cW / 2 : i / (buckets.length - 1) * cW);
    const py = v => PT + cH - (v / maxVal) * cH;

    const points = buckets.map((_, i) => [px(i), py(vals[i])]);

    const buildLinePath = (pts) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
    const buildAreaPath = (pts) => buildLinePath(pts) + ` L${pts[pts.length - 1][0].toFixed(2)},${(PT + cH).toFixed(2)} L${PL},${(PT + cH).toFixed(2)} Z`;

    const yTicks = [0, 0.5, 1].map(f => ({ y: py(maxVal * f), lbl: _fmtNum(Math.round(maxVal * f)) }));
    const xStep = Math.max(1, Math.ceil(buckets.length / 9));
    const gradId = `scpsg${metricIdx}`;

    const xLabels = buckets.map((b, i) => {
        if (i % xStep !== 0 && i !== buckets.length - 1) return '';
        return `<text x="${px(i).toFixed(1)}" y="${H - 3}" text-anchor="middle" class="scp-stats-axis-label">${escHtml(b.label)}</text>`;
    }).join('');

    const dotsHTML = points.map((p, i) => vals[i] > 0
        ? `<circle class="scp-stats-dot" cx="${p[0].toFixed(2)}" cy="${p[1].toFixed(2)}" r="3" fill="${meta.color}" data-i="${i}"/>`
        : '').join('');

    const hoverCols = buckets.map((b, i) => {
        const colW = cW / Math.max(buckets.length, 1);
        const x = px(i) - colW / 2;
        return `<rect class="scp-stats-hcol" x="${x.toFixed(1)}" y="${PT}" width="${colW.toFixed(1)}" height="${cH}" fill="transparent" data-i="${i}" data-v="${vals[i]}" data-l="${escHtml(b.label)}"/>`;
    }).join('');

    const existing = container.querySelector('.scp-stats-chart-inner');
    const prevLine = existing?.querySelector('.scp-stats-line-path');
    const prevArea = existing?.querySelector('.scp-stats-area-path');

    const linePath = buildLinePath(points);
    const areaPath = buildAreaPath(points);

    if (prevLine && prevArea) {
        const svgEl2 = existing.querySelector('.scp-stats-svg');
        const defs = svgEl2?.querySelector('defs');
        if (defs) {
            defs.innerHTML = `<linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="${meta.color}" stop-opacity="0.22"/>
                <stop offset="100%" stop-color="${meta.color}" stop-opacity="0.01"/>
            </linearGradient>`;
            prevArea.setAttribute('fill', `url(#${gradId})`);
        }
        prevLine.style.stroke = meta.color;

        const parsePoints = (pathStr) => {
            const matches = pathStr.match(/[ML]([\d.]+),([\d.]+)/g) || [];
            return matches.map(m => { const [x, y] = m.slice(1).split(',').map(Number); return [x, y]; });
        };
        const oldPts = parsePoints(prevLine.getAttribute('d') || '');
        const newPts = points;

        const oldDotEls = existing.querySelectorAll('.scp-stats-dot');
        oldDotEls.forEach(d => d.remove());

        const dotGroup = existing.querySelector('.scp-stats-xlabels');
        points.forEach((p, i) => {
            if (vals[i] <= 0) return;
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('class', 'scp-stats-dot');
            circle.setAttribute('cx', p[0].toFixed(2));

            const startY = oldPts[i] ? oldPts[i][1] : (PT + cH);
            circle.setAttribute('cy', startY.toString());

            circle.setAttribute('r', '3');
            circle.setAttribute('fill', meta.color);
            circle.setAttribute('data-i', i);
            circle.style.opacity = oldPts[i] ? '1' : '0';

            if (dotGroup) svgEl2.insertBefore(circle, dotGroup);
            else svgEl2.appendChild(circle);
        });

        const DURATION = 480;
        const start = performance.now();
        const lerp = (a, b, t) => a + (b - a) * t;
        const ease = t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

        const dotEls = Array.from(existing.querySelectorAll('.scp-stats-dot'));
        const animFrame = (now) => {
            const t = ease(Math.min(1, (now - start) / DURATION));
            const interpolated = newPts.map((np, i) => {
                const op = oldPts[i] || [np[0], PT + cH];
                return [lerp(op[0], np[0], t), lerp(op[1], np[1], t)];
            });

            prevLine.setAttribute('d', buildLinePath(interpolated));
            prevArea.setAttribute('d', buildAreaPath(interpolated));

            dotEls.forEach((d) => {
                if (d) {
                    const idx = parseInt(d.getAttribute('data-i') || '0');
                    d.style.transition = 'none';
                    d.setAttribute('cy', interpolated[idx][1].toFixed(2));
                    d.style.opacity = '1';
                }
            });

            if (t < 1) requestAnimationFrame(animFrame);
        };
        requestAnimationFrame(animFrame);

        const labelsEl = existing.querySelector('.scp-stats-xlabels');
        if (labelsEl) labelsEl.innerHTML = xLabels;

        const existingSvg = existing.querySelector('.scp-stats-svg');
        if (existingSvg) {
            existingSvg.querySelectorAll('line[x1]').forEach(l => l.remove());
            existingSvg.querySelectorAll('text.scp-stats-axis-label').forEach(t => t.remove());
            yTicks.forEach(({ y, lbl }) => {
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                line.setAttribute('x1', PL); line.setAttribute('y1', y.toFixed(1));
                line.setAttribute('x2', W - PR); line.setAttribute('y2', y.toFixed(1));
                line.setAttribute('stroke', 'rgba(255,255,255,0.06)'); line.setAttribute('stroke-width', '1');
                const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                text.setAttribute('x', PL - 4); text.setAttribute('y', (y + 4).toFixed(1));
                text.setAttribute('text-anchor', 'end'); text.setAttribute('class', 'scp-stats-axis-label');
                text.textContent = lbl;
                existingSvg.insertBefore(line, existingSvg.firstChild);
                existingSvg.insertBefore(text, existingSvg.firstChild);
            });
        }
    } else {
        container.innerHTML = `
<div class="scp-stats-chart-inner">
  <svg class="scp-stats-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${meta.color}" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="${meta.color}" stop-opacity="0.01"/>
      </linearGradient>
    </defs>
    ${yTicks.map(t => `<line x1="${PL}" y1="${t.y.toFixed(1)}" x2="${W - PR}" y2="${t.y.toFixed(1)}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/><text x="${PL - 4}" y="${(t.y + 4).toFixed(1)}" text-anchor="end" class="scp-stats-axis-label">${t.lbl}</text>`).join('')}
    <path class="scp-stats-area-path" d="${areaPath}" fill="url(#${gradId})"/>
    <path class="scp-stats-line-path" d="${linePath}" fill="none" stroke="${meta.color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="transition:stroke 0.35s ease"/>
    ${dotsHTML}
    <g class="scp-stats-xlabels">${xLabels}</g>
    ${hoverCols}
  </svg>
  <div class="scp-stats-tooltip" id="scp-stats-tt" style="display:none"></div>
</div>`;

        const svgPaths = container.querySelectorAll('.scp-stats-line-path, .scp-stats-area-path');
        svgPaths.forEach(p => { p.style.opacity = '0'; p.style.transition = 'opacity 0.4s ease'; });
        requestAnimationFrame(() => svgPaths.forEach(p => { p.style.opacity = '1'; }));

        const dots = container.querySelectorAll('.scp-stats-dot');
        dots.forEach((d) => {
            const finalCy = parseFloat(d.getAttribute('cy'));
            d.setAttribute('cy', (PT + cH).toString());
            d.style.opacity = '0';
            setTimeout(() => {
                d.style.transition = `cy 0.4s ease-out, opacity 0.3s ease-out`;
                d.setAttribute('cy', finalCy.toFixed(2));
                d.style.opacity = '1';
            }, 20);
        });
    }

    const svgEl = container.querySelector('.scp-stats-svg');
    const tt = container.querySelector('#scp-stats-tt') || container.querySelector('.scp-stats-tooltip');
    if (!svgEl || !tt) return;

    const oldHoverCols = svgEl.querySelectorAll('.scp-stats-hcol');
    oldHoverCols.forEach(r => r.remove());
    const hoverFrag = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    hoverFrag.innerHTML = hoverCols;
    svgEl.appendChild(hoverFrag);

    let _lastI = -1;
    svgEl.addEventListener('pointermove', e => {
        const r = svgEl.getBoundingClientRect();
        const svgX = (e.clientX - r.left) / r.width * W;
        const relX = svgX - PL;
        const rawIdx = relX / cW * (buckets.length - 1);
        const idx = Math.max(0, Math.min(buckets.length - 1, Math.round(rawIdx)));
        if (idx === _lastI) return;
        _lastI = idx;
        const val = vals[idx];
        tt.style.display = '';
        tt.innerHTML = `<span class="scp-stats-tt-label">${escHtml(buckets[idx].label)}</span><span class="scp-stats-tt-val" style="color:${meta.color}">${_fmtNum(val)}</span>`;
        const dotPxX = px(idx) / W * r.width;
        const dotPxY = py(val) / H * r.height;
        const ttW = 90;
        let left = dotPxX - ttW / 2;
        left = Math.max(0, Math.min(left, r.width - ttW));
        tt.style.left = `${left}px`;
        tt.style.top = `${Math.max(0, dotPxY - 42)}px`;
        svgEl.querySelectorAll('.scp-stats-dot').forEach((d, i) => d.setAttribute('r', i === idx ? '4.5' : '3'));
    });
    svgEl.addEventListener('pointerleave', () => {
        tt.style.display = 'none';
        _lastI = -1;
        svgEl.querySelectorAll('.scp-stats-dot').forEach(d => d.setAttribute('r', '3'));
    });

    if ('ontouchstart' in window || window.innerWidth <= 900) {
        requestAnimationFrame(() => {
            const inner = container.querySelector('.scp-stats-chart-inner');
            if (inner) inner.scrollLeft = inner.scrollWidth;
        });
    }
}
