import { resolveVariables } from './variableResolver';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TextSegment {
  text: string;
  unresolved: boolean;
}

export type KvRow = {
  key: string;
  value: string;
  disabled: boolean;
};

export type FormRow = {
  key: string;
  value: string;
  type: 'text' | 'file';
  disabled: boolean;
};

export type BodyPreviewResult =
  | { kind: 'none' }
  | { kind: 'file' }
  | { kind: 'text'; text: string; language: string }
  | { kind: 'kv'; rows: KvRow[]; serialized: string }
  | { kind: 'form'; rows: FormRow[] };

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Split text into segments, marking {{ }} placeholders that survived variable
 * resolution as unresolved (they were not present in the variable map).
 */
export function highlightUnresolved(text: string): TextSegment[] {
  if (!text) return [{ text: '', unresolved: false }];
  const parts = text.split(/({{[^}]+}})/g);
  const segments = parts
    .map(part => ({ text: part, unresolved: /^{{[^}]+}}$/.test(part) }))
    .filter(s => s.unresolved || s.text.length > 0);
  return segments.length > 0 ? segments : [{ text: '', unresolved: false }];
}

// ─── Main preview builder ─────────────────────────────────────────────────────

export interface BodyPreviewParams {
  bodyMode: string;
  bodyRaw: string;
  bodyRawLang: string;
  bodyUrlEncoded: Array<{ key: string; value: string; disabled?: boolean }>;
  bodyFormData: Array<{ key: string; value: string; type?: string; disabled?: boolean }>;
  bodyGraphqlVariables: string;
}

/**
 * Compute a client-side preview of the resolved request body.
 * Mirrors the logic in server/executor.js buildBody(), minus actual I/O.
 */
export function buildBodyPreview(
  params: BodyPreviewParams,
  vars: Record<string, string>,
): BodyPreviewResult {
  const { bodyMode, bodyRaw, bodyRawLang, bodyUrlEncoded, bodyFormData, bodyGraphqlVariables } = params;

  switch (bodyMode) {
    case 'none':
      return { kind: 'none' };

    case 'file':
      return { kind: 'file' };

    case 'raw': {
      const text = resolveVariables(bodyRaw, vars);
      return { kind: 'text', text, language: bodyRawLang };
    }

    case 'soap': {
      const text = resolveVariables(bodyRaw, vars);
      return { kind: 'text', text, language: 'xml' };
    }

    case 'urlencoded': {
      const rows: KvRow[] = bodyUrlEncoded.map(r => ({
        key: resolveVariables(r.key, vars),
        value: resolveVariables(r.value, vars),
        disabled: !!r.disabled,
      }));
      const qs = new URLSearchParams();
      rows.filter(r => !r.disabled && r.key).forEach(r => qs.append(r.key, r.value));
      const serialized = qs.toString();
      return { kind: 'kv', rows, serialized };
    }

    case 'formdata': {
      const rows: FormRow[] = bodyFormData.map(r => {
        const isFile = r.type === 'file';
        return {
          key: resolveVariables(r.key, vars),
          value: isFile ? (r.value ? `[${r.value}]` : '[file]') : resolveVariables(r.value, vars),
          type: isFile ? 'file' : 'text',
          disabled: !!r.disabled,
        };
      });
      return { kind: 'form', rows };
    }

    case 'graphql': {
      const text = bodyGraphqlVariables ? resolveVariables(bodyGraphqlVariables, vars) : '';
      return { kind: 'text', text, language: 'json' };
    }

    default:
      return { kind: 'none' };
  }
}
