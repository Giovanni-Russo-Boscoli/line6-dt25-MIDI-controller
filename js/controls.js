// UI controls. Each factory returns { el, set(value) } and calls onInput(value) on user changes.

const SVG = 'http://www.w3.org/2000/svg';
const START = -135; // degrees, knob sweep is 270 degrees
const SWEEP = 270;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}
export { h };

function s(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function polar(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx, cy, r, from, to) {
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

/** Amp-style 0-10 readout for a 0-127 value. */
export function dial(value, min = 0, max = 127) {
  return (((value - min) / (max - min)) * 10).toFixed(1);
}

export function knob(p, onInput, { size = 'md' } = {}) {
  const min = p.min ?? 0;
  const max = p.max ?? 127;
  let value = p.default ?? min;

  const svg = s('svg', { viewBox: '0 0 100 100', class: 'knob-svg', 'aria-hidden': 'true' });
  svg.append(
    s('path', { d: arcPath(50, 50, 44, START, START + SWEEP), class: 'knob-track' }),
  );
  const arc = s('path', { class: 'knob-arc' });
  svg.append(arc);
  svg.append(s('circle', { cx: 50, cy: 50, r: 33, class: 'knob-skirt' }));
  svg.append(s('circle', { cx: 50, cy: 50, r: 26, class: 'knob-cap' }));
  const pointer = s('line', { x1: 50, y1: 50, x2: 50, y2: 22, class: 'knob-pointer' });
  svg.append(pointer);

  const readout = h('output', { class: 'knob-value' });
  const dialEl = h('div', {
    class: `knob knob-${size}`,
    role: 'slider',
    tabindex: '0',
    'aria-label': p.label,
    'aria-valuemin': min,
    'aria-valuemax': max,
    'data-param': p.id,
  }, svg);
  const el = h('div', { class: 'knob-wrap' }, dialEl, h('span', { class: 'knob-label', 'data-label': p.id, text: p.label }), readout);

  function render() {
    const t = (value - min) / (max - min);
    const deg = START + t * SWEEP;
    arc.setAttribute('d', t > 0.001 ? arcPath(50, 50, 44, START, deg) : '');
    pointer.setAttribute('transform', `rotate(${deg} 50 50)`);
    readout.textContent = dial(value, min, max);
    dialEl.setAttribute('aria-valuenow', value);
    dialEl.setAttribute('aria-valuetext', `${readout.textContent} (${value})`);
  }

  function commit(v) {
    const nv = Math.min(max, Math.max(min, Math.round(v)));
    if (nv === value) return;
    value = nv;
    render();
    onInput(value);
  }

  // Vertical drag, like most amp sims. Shift or a second finger gives fine control.
  let drag = null;
  dialEl.addEventListener('pointerdown', (e) => {
    dialEl.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, x: e.clientX, start: value };
    dialEl.classList.add('active');
    e.preventDefault();
  });
  dialEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const range = max - min;
    const px = e.shiftKey ? 600 : 180; // pixels for full sweep
    const delta = (drag.y - e.clientY) + (e.clientX - drag.x) * 0.5;
    commit(drag.start + (delta / px) * range);
  });
  const end = () => { drag = null; dialEl.classList.remove('active'); };
  dialEl.addEventListener('pointerup', end);
  dialEl.addEventListener('pointercancel', end);
  dialEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    commit(value + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 1 : 3));
  }, { passive: false });
  dialEl.addEventListener('dblclick', () => commit(p.default ?? Math.round((min + max) / 2)));
  dialEl.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 1;
    const map = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: 13, PageDown: -13 };
    if (e.key in map) commit(value + map[e.key]);
    else if (e.key === 'Home') commit(min);
    else if (e.key === 'End') commit(max);
    else return;
    e.preventDefault();
  });

  render();
  return { el, set(v) { value = v; render(); } };
}

/** Two-position switch (Class A/AB, Triode/Pentode ...). Stores raw CC value. */
export function toggle(p, onInput) {
  let value = p.off;
  const offBtn = h('button', { type: 'button', class: 'seg', text: p.offLabel });
  const onBtn = h('button', { type: 'button', class: 'seg', text: p.onLabel });
  const group = h('div', { class: 'segmented two', role: 'radiogroup', 'aria-label': p.label, 'data-param': p.id }, offBtn, onBtn);
  const el = h('div', { class: 'field' }, h('span', { class: 'field-label', 'data-label': p.id, text: p.label }), group);
  if (p.hint) el.append(h('span', { class: 'field-hint', text: p.hint }));
  if (p.model) el.append(h('span', { class: 'badge', text: `${p.model} only` }));
  const isOn = () => value >= 64;
  function render() {
    offBtn.setAttribute('aria-checked', String(!isOn()));
    onBtn.setAttribute('aria-checked', String(isOn()));
    offBtn.setAttribute('role', 'radio');
    onBtn.setAttribute('role', 'radio');
    group.classList.toggle('is-on', isOn());
  }
  offBtn.addEventListener('click', () => { if (isOn()) { value = p.off; render(); onInput(value); } });
  onBtn.addEventListener('click', () => { if (!isOn()) { value = p.on; render(); onInput(value); } });
  render();
  return { el, set(v) { value = v; render(); } };
}

/** N-way segmented selector for small lists (NFL topology). */
export function segmented(p, options, onInput) {
  let value = 0;
  const btns = options.map((label, i) =>
    h('button', { type: 'button', class: 'seg', role: 'radio', text: label, onclick: () => {
      if (value !== i) { value = i; render(); onInput(value); }
    } }));
  const group = h('div', { class: `segmented n${options.length}`, role: 'radiogroup', 'aria-label': p.label, 'data-param': p.id }, ...btns);
  const el = h('div', { class: 'field' }, h('span', { class: 'field-label', 'data-label': p.id, text: p.label }), group);
  function render() {
    btns.forEach((b, i) => b.setAttribute('aria-checked', String(i === value)));
    group.style.setProperty('--idx', value);
  }
  render();
  return { el, set(v) { value = v; render(); } };
}

/** Model browser: prev/next arrows around a native select (great on phones). */
export function picker(p, options, onInput, { variant = '' } = {}) {
  let value = 0;
  const select = h('select', { 'aria-label': p.label, 'data-param': p.id });
  options.forEach((label, i) => select.append(h('option', { value: i, text: `${String(i).padStart(2, '0')}  ${label}` })));
  const name = h('span', { class: 'picker-name' });
  const index = h('span', { class: 'picker-index' });
  const prev = h('button', { type: 'button', class: 'picker-arrow', 'aria-label': `Previous ${p.label}`, text: '‹' });
  const next = h('button', { type: 'button', class: 'picker-arrow', 'aria-label': `Next ${p.label}`, text: '›' });
  const face = h('div', { class: 'picker-face' }, index, name, select);
  const el = h('div', { class: `picker ${variant}` },
    h('span', { class: 'field-label', 'data-label': p.id, text: p.label }),
    h('div', { class: 'picker-row' }, prev, face, next));
  const listeners = [];
  function render() {
    select.value = String(value);
    name.textContent = options[value];
    index.textContent = String(value).padStart(2, '0');
    listeners.forEach((fn) => fn(value));
  }
  function commit(v) {
    const nv = (v + options.length) % options.length;
    if (nv === value) return;
    value = nv;
    render();
    onInput(value);
  }
  select.addEventListener('change', () => commit(Number(select.value)));
  prev.addEventListener('click', () => commit(value - 1));
  next.addEventListener('click', () => commit(value + 1));
  render();
  return { el, set(v) { value = v; render(); }, onRender(fn) { listeners.push(fn); fn(value); } };
}

/** Stompbox-style footswitch with LED. */
export function stomp(p, onInput) {
  let value = p.on;
  const led = h('span', { class: 'led' });
  const btn = h('button', { type: 'button', class: 'stomp', 'aria-pressed': 'true', 'data-param': p.id },
    led, h('span', { class: 'stomp-label', text: p.label }));
  function render() {
    const on = value >= 64;
    btn.setAttribute('aria-pressed', String(on));
    btn.querySelector('.stomp-label').textContent = `${p.label} ${on ? 'On' : 'Off'}`;
  }
  btn.addEventListener('click', () => { value = value >= 64 ? p.off : p.on; render(); onInput(value); });
  render();
  return { el: btn, set(v) { value = v; render(); } };
}
