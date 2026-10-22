// "Info" mode: less obvious labels become links that explain the feature on hover or tap.
import { h } from './controls.js';

export function setupHelp(help, { enabled = false, onToggle } = {}) {
  const pop = document.getElementById('helpPop');
  const title = document.getElementById('helpTitle');
  const text = document.getElementById('helpText');
  const btn = document.getElementById('infoBtn');
  const hover = matchMedia('(hover: hover) and (pointer: fine)');
  let openFor = null;
  let pinned = false;

  function show(target, key) {
    const item = help[key];
    if (!item) return;
    title.textContent = item.title;
    text.textContent = item.text;
    pop.hidden = false;
    openFor = target;
    const r = target.getBoundingClientRect();
    const w = pop.offsetWidth;
    const left = Math.min(window.innerWidth - w - 12, Math.max(12, r.left + r.width / 2 - w / 2));
    const below = r.bottom + 10 + pop.offsetHeight < window.innerHeight;
    pop.style.left = `${left + window.scrollX}px`;
    pop.style.top = `${(below ? r.bottom + 10 : r.top - pop.offsetHeight - 10) + window.scrollY}px`;
    pop.dataset.side = below ? 'below' : 'above';
  }

  function hide() {
    pop.hidden = true;
    openFor = null;
    pinned = false;
  }

  function wire(target, key) {
    target.addEventListener('click', (e) => {
      if (!document.body.classList.contains('info-on')) return;
      e.preventDefault();
      e.stopPropagation();
      if (openFor === target && pinned) return hide();
      show(target, key);
      pinned = true;
    });
    target.addEventListener('keydown', (e) => {
      if (!document.body.classList.contains('info-on') || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      target.click();
    });
    target.addEventListener('mouseenter', () => {
      if (hover.matches && document.body.classList.contains('info-on') && !pinned) show(target, key);
    });
    target.addEventListener('mouseleave', () => { if (!pinned && openFor === target) hide(); });
  }

  // Labels turn into links; buttons get a "?" chip right after them.
  document.querySelectorAll('[data-label]').forEach((el) => {
    const key = el.dataset.label;
    if (!help[key]) return;
    el.classList.add('help-link');
    el.append(h('span', { class: 'help-q', 'aria-hidden': 'true', text: '?' }));
    wire(el, key);
  });
  document.querySelectorAll('[data-help-after]').forEach((el) => {
    const key = el.dataset.helpAfter;
    if (!help[key]) return;
    const chip = h('button', { type: 'button', class: 'help-chip', 'aria-label': `About ${help[key].title}`, text: '?' });
    el.after(chip);
    wire(chip, key);
  });

  function set(on) {
    document.body.classList.toggle('info-on', on);
    btn.setAttribute('aria-pressed', String(on));
    document.querySelectorAll('.help-link').forEach((el) => {
      if (on) { el.setAttribute('tabindex', '0'); el.setAttribute('role', 'button'); }
      else { el.removeAttribute('tabindex'); el.removeAttribute('role'); }
    });
    if (!on) hide();
  }

  btn.addEventListener('click', () => {
    const on = !document.body.classList.contains('info-on');
    set(on);
    onToggle?.(on);
  });
  document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target)) hide(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  window.addEventListener('resize', hide);
  set(enabled);
}
