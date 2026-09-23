// Interface language for the dashboard and the worker. English text in the code is the
// lookup key; i18n-zh.mjs holds the Simplified Chinese for each key. A key without a
// translation falls back to English, and test/i18n.test.mjs fails when that happens.
// {0}, {1}… are placeholders filled from the extra arguments, in any order.

import ZH from './i18n-zh.mjs';

export const DEFAULT_LOCALE = 'zh-CN';
let locale = DEFAULT_LOCALE;

// 'zh…' → Chinese; 'en…' and 'ms' (Malay briefs, English screens) → English; else the default.
export function normaliseLocale(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v.startsWith('zh')) return 'zh-CN';
  if (v.startsWith('en') || v.startsWith('ms')) return 'en';
  return DEFAULT_LOCALE;
}

export function setLocale(value) {
  locale = normaliseLocale(value);
  if (typeof document !== 'undefined') document.documentElement.lang = locale === 'zh-CN' ? 'zh-CN' : 'en';
  return locale;
}

export function getLocale() { return locale; }

// Worker runs: a DASHBOARD_LANGUAGE override (tests, maintainers) wins over the owner's choice.
export function useWorkerLocale(profileLocale) {
  const override = typeof process !== 'undefined' ? process.env.DASHBOARD_LANGUAGE : '';
  return setLocale(override || profileLocale || DEFAULT_LOCALE);
}

// Intl locale for dates and numbers shown to the owner.
export function intlLocale() { return locale === 'zh-CN' ? 'zh-CN' : 'en-MY'; }

function fill(text, args) {
  return args.length ? text.replace(/\{(\d+)\}/g, (m, i) => (args[i] === undefined || args[i] === null ? m : String(args[i]))) : text;
}

// Leading/trailing spaces stay with the call site so text around links keeps its spacing.
function lookup(en) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(en);
  const zh = ZH[m[2]];
  return zh === undefined ? null : (locale === 'zh-CN' ? `${m[1]}${zh}${m[3]}` : null);
}

// Plain text: Chinese only.
export function tr(en, ...args) {
  if (locale !== 'zh-CN') return fill(en, args);
  return fill(lookup(en) ?? en, args);
}

// Menu items, buttons and named controls: 中文（English）, so the English name in the
// guide and in search results still matches.
export function tl(en, ...args) {
  const english = fill(en, args).trim();
  if (locale !== 'zh-CN') return english;
  const zh = lookup(en);
  if (zh === null) return english;
  // Keep decorations (“+ ”, “ ↗”, “…”, “ ×”) outside the brackets: + 新增待办（Add task）
  const pre = /^(\+\s)/.exec(english)?.[1] || '';
  const post = /(\s?[↗…×])$/.exec(english)?.[1] || '';
  const core = s => s.trim().slice(pre && s.trim().startsWith(pre) ? pre.length : 0).replace(/\s?[↗…×]$/, '').trim();
  return `${pre}${core(fill(zh, args))}（${core(english)}）${post}`;
}

// Joins whole sentences: no space between Chinese sentences.
export function sentences(...parts) {
  const kept = parts.filter(Boolean);
  return locale === 'zh-CN' ? kept.join('') : kept.join(' ');
}

export function hasTranslation(en) { return Object.prototype.hasOwnProperty.call(ZH, String(en).trim()); }
