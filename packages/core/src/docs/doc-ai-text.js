'use strict';

/**
 * Neutralise text written by a language model before it enters a document.
 *
 * Model output is untrusted: an injected instruction can make it emit a Markdown image or link
 * whose URL carries data (names, endpoints) to a third party as soon as the export is opened.
 * Descriptions are meant to be plain prose, so anything that can fetch or navigate is flattened
 * to its visible text. Pure, no I/O.
 */

const MAX_PASSES = 10;

/**
 * Remove HTML comments, tags and autolinks with a character scanner (no regex), then drop the
 * chevron of any unclosed opener (`<` followed by `!`, `?`, `/` or a letter). Linear time: the
 * last `>` and last `-->` are located once, so an unclosed opener never rescans the tail.
 * Splicing across a removal can form a new opener; neutralizeAiText loops to a fixed point.
 */
function stripHtml(s) {
  const lastGt = s.lastIndexOf('>');
  const lastCommentEnd = s.lastIndexOf('-->');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch !== '<') { out += ch; i++; continue; }
    if (s.startsWith('!--', i + 1) && i + 4 <= lastCommentEnd) {
      i = s.indexOf('-->', i + 4) + 3;
      continue;
    }
    const next = s[i + 1] || '';
    const isLetter = /[A-Za-z]/.test(next);
    const closable = isLetter || (next === '/' && /[A-Za-z]/.test(s[i + 2] || ''));
    if (closable && i < lastGt) {
      i = s.indexOf('>', i) + 1;
      continue;
    }
    if (isLetter || next === '!' || next === '?' || next === '/') { i++; continue; }
    out += ch;
    i++;
  }
  return out;
}

function neutralizeOnce(s) {
  return stripHtml(s)
    // Reference definitions: `[id]: https://...`
    .replace(/^[ \t]*\[[^\]\n]*\]:[ \t]*\S.*$/gm, '')
    // Images and links, inline and reference style: keep the visible text only.
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/!\[([^\]\n]*)\]\[[^\]\n]*\]/g, '$1')
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\[([^\]\n]*)\]\[[^\]\n]*\]/g, '$1')
    // Bare URLs of any scheme, and scheme-less `www.` hosts.
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"')\]]*/g, '')
    .replace(/\b(?:data|javascript|vbscript|file):[^\s<>"')\]]*/gi, '')
    .replace(/\bwww\.[^\s<>"')\]]+/gi, '');
}

/**
 * @param {unknown} text
 * @returns {string} Plain prose: no images, links, URLs or HTML. Whitespace is collapsed.
 */
function neutralizeAiText(text) {
  if (typeof text !== 'string') return '';
  let s = text;
  // Repeat: removing one construct can splice the surrounding text into a new one.
  for (let i = 0; i < MAX_PASSES; i++) {
    const next = neutralizeOnce(s);
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, ' ').trim();
}

module.exports = { neutralizeAiText };
