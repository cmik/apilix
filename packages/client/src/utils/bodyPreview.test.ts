import { describe, it, expect } from 'vitest';
import { buildBodyPreview, highlightUnresolved } from './bodyPreview';

// ─── helpers ─────────────────────────────────────────────────────────────────

const vars = { baseUrl: 'https://api.example.com', token: 'abc123', name: 'Alice' };

function base() {
  return {
    bodyRaw: '',
    bodyRawLang: 'json',
    bodyUrlEncoded: [] as Array<{ key: string; value: string; disabled?: boolean }>,
    bodyFormData: [] as Array<{ key: string; value: string; type?: string; disabled?: boolean }>,
    bodyGraphqlVariables: '',
  };
}

// ─── buildBodyPreview ─────────────────────────────────────────────────────────

describe('buildBodyPreview', () => {
  it('returns kind:none for bodyMode none', () => {
    expect(buildBodyPreview({ ...base(), bodyMode: 'none' }, vars)).toEqual({ kind: 'none' });
  });

  it('returns kind:file for bodyMode file', () => {
    expect(buildBodyPreview({ ...base(), bodyMode: 'file' }, vars)).toEqual({ kind: 'file' });
  });

  it('returns kind:none for unknown bodyMode', () => {
    expect(buildBodyPreview({ ...base(), bodyMode: 'unknown' }, vars)).toEqual({ kind: 'none' });
  });

  // ── raw ──

  it('raw: resolves all variables', () => {
    const result = buildBodyPreview(
      { ...base(), bodyMode: 'raw', bodyRaw: '{"url":"{{baseUrl}}","token":"{{token}}"}', bodyRawLang: 'json' },
      vars,
    );
    expect(result).toEqual({
      kind: 'text',
      text: '{"url":"https://api.example.com","token":"abc123"}',
      language: 'json',
    });
  });

  it('raw: leaves unresolved placeholder intact', () => {
    const result = buildBodyPreview(
      { ...base(), bodyMode: 'raw', bodyRaw: '{"name":"{{missing}}"}', bodyRawLang: 'text' },
      vars,
    );
    expect(result.kind).toBe('text');
    if (result.kind === 'text') {
      expect(result.text).toBe('{"name":"{{missing}}"}');
      expect(result.language).toBe('text');
    }
  });

  it('raw: passes through language from bodyRawLang', () => {
    const result = buildBodyPreview(
      { ...base(), bodyMode: 'raw', bodyRaw: '<root/>', bodyRawLang: 'xml' },
      vars,
    );
    expect(result.kind === 'text' && result.language).toBe('xml');
  });

  // ── soap ──

  it('soap: resolves variables and always returns language xml', () => {
    const result = buildBodyPreview(
      { ...base(), bodyMode: 'soap', bodyRaw: '<token>{{token}}</token>', bodyRawLang: 'text' },
      vars,
    );
    expect(result).toEqual({
      kind: 'text',
      text: '<token>abc123</token>',
      language: 'xml',
    });
  });

  // ── urlencoded ──

  it('urlencoded: resolves keys and values', () => {
    const result = buildBodyPreview(
      {
        ...base(),
        bodyMode: 'urlencoded',
        bodyUrlEncoded: [
          { key: '{{name}}', value: '{{token}}' },
          { key: 'static', value: 'value' },
        ],
      },
      vars,
    );
    expect(result.kind).toBe('kv');
    if (result.kind === 'kv') {
      expect(result.rows[0]).toEqual({ key: 'Alice', value: 'abc123', disabled: false });
      expect(result.rows[1]).toEqual({ key: 'static', value: 'value', disabled: false });
    }
  });

  it('urlencoded: builds correct serialized query string', () => {
    const result = buildBodyPreview(
      {
        ...base(),
        bodyMode: 'urlencoded',
        bodyUrlEncoded: [
          { key: 'name', value: 'Alice' },
          { key: 'token', value: 'abc123' },
        ],
      },
      vars,
    );
    expect(result.kind === 'kv' && result.serialized).toBe('name=Alice&token=abc123');
  });

  it('urlencoded: excludes disabled rows from serialized output', () => {
    const result = buildBodyPreview(
      {
        ...base(),
        bodyMode: 'urlencoded',
        bodyUrlEncoded: [
          { key: 'active', value: 'yes' },
          { key: 'skip', value: 'no', disabled: true },
        ],
      },
      vars,
    );
    expect(result.kind === 'kv' && result.serialized).toBe('active=yes');
    if (result.kind === 'kv') {
      expect(result.rows.find(r => r.key === 'skip')?.disabled).toBe(true);
    }
  });

  it('urlencoded: empty rows produce empty serialized string', () => {
    const result = buildBodyPreview({ ...base(), bodyMode: 'urlencoded' }, vars);
    expect(result.kind === 'kv' && result.serialized).toBe('');
  });

  // ── formdata ──

  it('formdata: resolves text rows', () => {
    const result = buildBodyPreview(
      {
        ...base(),
        bodyMode: 'formdata',
        bodyFormData: [{ key: '{{name}}', value: '{{token}}', type: 'text' }],
      },
      vars,
    );
    expect(result.kind).toBe('form');
    if (result.kind === 'form') {
      expect(result.rows[0]).toEqual({ key: 'Alice', value: 'abc123', type: 'text', disabled: false });
    }
  });

  it('formdata: file rows show filename in brackets', () => {
    const result = buildBodyPreview(
      {
        ...base(),
        bodyMode: 'formdata',
        bodyFormData: [{ key: 'upload', value: 'photo.png', type: 'file' }],
      },
      vars,
    );
    expect(result.kind === 'form' && result.rows[0].value).toBe('[photo.png]');
    expect(result.kind === 'form' && result.rows[0].type).toBe('file');
  });

  it('formdata: file rows with empty value show [file]', () => {
    const result = buildBodyPreview(
      {
        ...base(),
        bodyMode: 'formdata',
        bodyFormData: [{ key: 'upload', value: '', type: 'file' }],
      },
      vars,
    );
    expect(result.kind === 'form' && result.rows[0].value).toBe('[file]');
  });

  it('formdata: respects disabled flag', () => {
    const result = buildBodyPreview(
      {
        ...base(),
        bodyMode: 'formdata',
        bodyFormData: [{ key: 'k', value: 'v', disabled: true }],
      },
      vars,
    );
    expect(result.kind === 'form' && result.rows[0].disabled).toBe(true);
  });

  it('formdata: row with no type field defaults to text', () => {
    const result = buildBodyPreview(
      {
        ...base(),
        bodyMode: 'formdata',
        bodyFormData: [{ key: 'field', value: 'value' }], // no type property
      },
      vars,
    );
    expect(result.kind).toBe('form');
    if (result.kind === 'form') {
      expect(result.rows[0].type).toBe('text');
      expect(result.rows[0].value).toBe('value'); // resolved as text, not [file]
    }
  });

  // ── graphql ──

  it('graphql: resolves variables JSON', () => {
    const result = buildBodyPreview(
      {
        ...base(),
        bodyMode: 'graphql',
        bodyGraphqlVariables: '{"token":"{{token}}"}',
      },
      vars,
    );
    expect(result).toEqual({ kind: 'text', text: '{"token":"abc123"}', language: 'json' });
  });

  it('graphql: returns empty text when variables are empty', () => {
    const result = buildBodyPreview({ ...base(), bodyMode: 'graphql' }, vars);
    expect(result).toEqual({ kind: 'text', text: '', language: 'json' });
  });

  // ── empty vars map ──

  it('raw: leaves all placeholders unresolved when vars map is empty', () => {
    const result = buildBodyPreview(
      { ...base(), bodyMode: 'raw', bodyRaw: '{"a":"{{x}}","b":"{{y}}"}', bodyRawLang: 'json' },
      {},
    );
    expect(result.kind === 'text' && result.text).toBe('{"a":"{{x}}","b":"{{y}}"}');
  });

  // ── raw with empty body ──

  it('raw: returns empty text for empty bodyRaw', () => {
    const result = buildBodyPreview({ ...base(), bodyMode: 'raw', bodyRaw: '', bodyRawLang: 'json' }, vars);
    expect(result).toEqual({ kind: 'text', text: '', language: 'json' });
  });

  it('soap: returns empty text for empty bodyRaw', () => {
    const result = buildBodyPreview({ ...base(), bodyMode: 'soap', bodyRaw: '' }, vars);
    expect(result).toEqual({ kind: 'text', text: '', language: 'xml' });
  });

  // ── urlencoded special chars ──

  it('urlencoded: percent-encodes special characters in serialized output', () => {
    const result = buildBodyPreview(
      {
        ...base(),
        bodyMode: 'urlencoded',
        bodyUrlEncoded: [{ key: 'greeting', value: 'hello world' }],
      },
      {},
    );
    // URLSearchParams encodes spaces as +
    expect(result.kind === 'kv' && result.serialized).toBe('greeting=hello+world');
  });

  it('urlencoded: row with empty key is excluded from serialized but present in rows', () => {
    const result = buildBodyPreview(
      {
        ...base(),
        bodyMode: 'urlencoded',
        bodyUrlEncoded: [
          { key: '', value: 'orphan' },
          { key: 'present', value: 'yes' },
        ],
      },
      {},
    );
    expect(result.kind).toBe('kv');
    if (result.kind === 'kv') {
      expect(result.rows).toHaveLength(2);          // both rows preserved
      expect(result.serialized).toBe('present=yes'); // empty-key row excluded
    }
  });

  // ── formdata mixed rows ──

  it('formdata: handles mixed text and file rows in same array', () => {
    const result = buildBodyPreview(
      {
        ...base(),
        bodyMode: 'formdata',
        bodyFormData: [
          { key: 'caption', value: '{{name}}', type: 'text' },
          { key: 'avatar', value: 'photo.png', type: 'file' },
          { key: 'hidden', value: 'x', disabled: true },
        ],
      },
      vars,
    );
    expect(result.kind).toBe('form');
    if (result.kind === 'form') {
      expect(result.rows).toHaveLength(3);
      expect(result.rows[0]).toEqual({ key: 'caption', value: 'Alice', type: 'text', disabled: false });
      expect(result.rows[1]).toEqual({ key: 'avatar', value: '[photo.png]', type: 'file', disabled: false });
      expect(result.rows[2].disabled).toBe(true);
    }
  });
});

// ─── highlightUnresolved ──────────────────────────────────────────────────────

describe('highlightUnresolved', () => {
  it('returns single unresolved:false segment for plain text', () => {
    expect(highlightUnresolved('hello world')).toEqual([
      { text: 'hello world', unresolved: false },
    ]);
  });

  it('marks {{ }} placeholder as unresolved', () => {
    const segs = highlightUnresolved('Bearer {{token}}');
    expect(segs).toEqual([
      { text: 'Bearer ', unresolved: false },
      { text: '{{token}}', unresolved: true },
    ]);
    // no trailing empty segment — filtered out
  });

  it('handles adjacent placeholders', () => {
    const segs = highlightUnresolved('{{a}}{{b}}');
    // empty boundary strings are filtered out
    expect(segs).toEqual([
      { text: '{{a}}', unresolved: true },
      { text: '{{b}}', unresolved: true },
    ]);
  });

  it('handles text between multiple placeholders', () => {
    const segs = highlightUnresolved('{{x}} and {{y}} done');
    const unresolvedTexts = segs.filter(s => s.unresolved).map(s => s.text);
    expect(unresolvedTexts).toEqual(['{{x}}', '{{y}}']);
    const normalTexts = segs.filter(s => !s.unresolved).map(s => s.text);
    expect(normalTexts).toEqual([' and ', ' done']); // leading empty filtered out
  });

  it('returns a single empty segment for empty string', () => {
    expect(highlightUnresolved('')).toEqual([{ text: '', unresolved: false }]);
  });

  it('does not mark closed/resolved placeholder as unresolved', () => {
    // After resolution, text no longer has {{ }} → no unresolved segments
    const segs = highlightUnresolved('Bearer abc123');
    expect(segs.every(s => !s.unresolved)).toBe(true);
  });

  it('single placeholder with no surrounding text is marked unresolved', () => {
    expect(highlightUnresolved('{{token}}')).toEqual([
      { text: '{{token}}', unresolved: true },
    ]);
  });

  it('malformed placeholder missing closing braces is treated as plain text', () => {
    const segs = highlightUnresolved('Bearer {{unclosed');
    expect(segs).toEqual([{ text: 'Bearer {{unclosed', unresolved: false }]);
  });

  it('empty braces {{}} are treated as plain text (regex requires at least one char)', () => {
    const segs = highlightUnresolved('value={{}}');
    expect(segs).toEqual([{ text: 'value={{}}', unresolved: false }]);
  });

  it('extra braces around a placeholder: regex greedily matches from first {{ pair', () => {
    // {{{var}}} — regex sees {{ at position 0, [^}]+ matches {var, }} closes at positions 6-7
    // So the captured segment is '{{{var}}' (unresolved) and the trailing '}' is plain text
    const segs = highlightUnresolved('{{{var}}}');
    expect(segs).toEqual([
      { text: '{{{var}}', unresolved: true },
      { text: '}', unresolved: false },
    ]);
  });
});


