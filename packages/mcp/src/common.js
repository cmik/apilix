'use strict';

const path = require('node:path');

/** Tool result helpers. */
const text = (s) => ({ type: 'text', text: s });

function okResult(data, maxChars) {
  let body = JSON.stringify(data);
  if (body.length > maxChars) {
    body = JSON.stringify({
      truncated: true,
      totalChars: body.length,
      note: 'Result exceeded the output limit and was cut. Narrow the request (smaller limit, folder, fewer iterations).',
      preview: body.slice(0, Math.max(200, maxChars - 400)),
    });
  }
  return { content: [text(body)] };
}

function failResult(message) {
  return { isError: true, content: [text(String(message))] };
}

/** Strip absolute paths from an error message so nothing outside the workspace leaks. */
function safeMessage(message, rootPaths = []) {
  let m = String(message == null ? 'Error' : message);
  for (const r of rootPaths) m = m.split(r).join('<workspace>');
  m = m.replace(/(?:[A-Za-z]:)?(?:[\\/][^\s'"`:;,)\]]+){2,}/g, '<path>');
  return m.length > 500 ? `${m.slice(0, 500)}...` : m;
}

const baseName = (p) => path.basename(p);

module.exports = { okResult, failResult, safeMessage, text, baseName };
