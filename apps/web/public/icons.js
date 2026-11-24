/**
 * One drawn icon set: 16px grid, 1.5 stroke, round caps, currentColor.
 * Unicode glyphs and emoji are not an icon system — they render differently on every
 * platform and are read aloud by screen readers.
 */
const P = {
  session: '<path d="M3 4.5h10M3 8h10M3 11.5h6"/>',
  board: '<rect x="2" y="2.5" width="3.6" height="11" rx="1"/><rect x="6.2" y="2.5" width="3.6" height="7" rx="1"/><rect x="10.4" y="2.5" width="3.6" height="9" rx="1"/>',
  flow: '<circle cx="4" cy="4" r="1.8"/><circle cx="12" cy="8" r="1.8"/><circle cx="4" cy="12" r="1.8"/><path d="M5.5 4.8 10.4 7.2M10.4 8.8 5.5 11.2"/>',
  trigger: '<path d="M8.6 1.8 3.4 9h3.6l-1.2 5.2L13 7h-3.8z"/>',
  repo: '<path d="M3.5 2.5h7a1.5 1.5 0 0 1 1.5 1.5v9.5H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M12 11.5H5a1.5 1.5 0 0 0 0 3"/>',
  terminal: '<rect x="1.8" y="3" width="12.4" height="10" rx="1.6"/><path d="M4.6 6.6 6.8 8.4l-2.2 1.8M8.6 10.6h3"/>',
  plugin: '<path d="M6 2.5v2.2M10 2.5v2.2M4.2 4.7h7.6v4a3.8 3.8 0 0 1-7.6 0z"/><path d="M8 12.5v1.8"/>',
  credits: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8v6.4M9.9 6.2a2 2 0 0 0-3.8.6c0 1.9 3.8 1 3.8 2.8a2 2 0 0 1-3.8.6"/>',
  blueprint: '<rect x="2" y="2.5" width="12" height="11" rx="1.4"/><path d="M2 6h12M6 6v7.5"/>',
  lock: '<rect x="3.4" y="7" width="9.2" height="6.6" rx="1.4"/><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7"/>',
  check: '<path d="M3 8.4 6.3 11.6 13 4.8"/>',
  cross: '<path d="M4 4l8 8M12 4l-8 8"/>',
  pause: '<path d="M6 4v8M10 4v8"/>',
  dot: '<circle cx="8" cy="8" r="3"/>',
  chevron: '<path d="M6 4l4 4-4 4"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  upload: '<path d="M8 11V3.2M5 6.2 8 3.2l3 3"/><path d="M2.8 10.5v1.8A1.7 1.7 0 0 0 4.5 14h7a1.7 1.7 0 0 0 1.7-1.7v-1.8"/>',
  sparkle: '<path d="M8 2.2l1.5 4.3L13.8 8l-4.3 1.5L8 13.8l-1.5-4.3L2.2 8l4.3-1.5z"/>',
  shield: '<path d="M8 2.2 13 4v4c0 3-2.1 5.2-5 5.8C5.1 13.2 3 11 3 8V4z"/>',
  clock: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.4 1.6"/>',
};

export function icon(name, { size = 16, cls = "" } = {}) {
  const d = P[name] ?? P.dot;
  return (
    `<svg class="icn ${cls}" width="${size}" height="${size}" viewBox="0 0 16 16" ` +
    `fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`
  );
}

export const ICON_NAMES = Object.keys(P);
