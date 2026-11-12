import type { DocRequestModel, DocSnippetLanguage } from '../types';
import { CODE_GEN_LANGUAGES, type CodeGenParams } from './codeGen';
import { buildCurlCommand } from './curlUtils';

const REDACTED = '<redacted>';

function isPlaceholder(value: string): boolean {
  return value === REDACTED || value.includes('{{');
}

function authValue(req: DocRequestModel, key: string): string {
  return req.auth?.fields?.find(f => f.key === key)?.value ?? '';
}

/**
 * Convert a (redacted) documentation request model into the CodeGenParams shape
 * used by the existing snippet generators. Values are never un-redacted here.
 */
export function docRequestToCodeGenParams(req: DocRequestModel): CodeGenParams {
  const headers: CodeGenParams['headers'] = req.headers.map(h => ({ key: h.key, value: h.value }));
  let url = req.fullUrl;

  let authType = 'noauth';
  let authBearer = '';
  let authBasicUser = '';
  let authBasicPass = '';
  let authApiKeyName = '';
  let authApiKeyValue = '';

  const auth = req.auth;
  if (auth?.type === 'bearer') {
    authType = 'bearer';
    authBearer = authValue(req, 'token');
  } else if (auth?.type === 'basic') {
    const user = authValue(req, 'username');
    const pass = authValue(req, 'password');
    if (isPlaceholder(user) || isPlaceholder(pass)) {
      // Avoid base64-encoding placeholder text; show an explicit header instead.
      headers.unshift({ key: 'Authorization', value: 'Basic <credentials>' });
    } else {
      authType = 'basic';
      authBasicUser = user;
      authBasicPass = pass;
    }
  } else if (auth?.type === 'apikey') {
    const value = authValue(req, 'value');
    if (auth.in === 'query') {
      const pair = `${auth.name ?? ''}=${value}`;
      url += (url.includes('?') ? '&' : '?') + pair;
    } else {
      authType = 'apikey';
      authApiKeyName = auth.name ?? '';
      authApiKeyValue = value;
    }
  } else if (auth?.type === 'oauth2') {
    headers.unshift({ key: 'Authorization', value: 'Bearer <access_token>' });
  }

  const body = req.body;
  return {
    method: req.method,
    url,
    headers,
    bodyMode: body?.mode ?? 'none',
    bodyRaw: body?.mode === 'raw' ? body.raw ?? '' : '',
    bodyFormData: body?.mode === 'formdata' ? (body.fields ?? []).map(f => ({ key: f.key, value: f.value })) : [],
    bodyUrlEncoded: body?.mode === 'urlencoded' ? (body.fields ?? []).map(f => ({ key: f.key, value: f.value })) : [],
    bodyGraphqlQuery: body?.graphql?.query ?? '',
    bodyGraphqlVariables: body?.graphql?.variables ?? '',
    authType,
    authBearer,
    authBasicUser,
    authBasicPass,
    authApiKeyName,
    authApiKeyValue,
  };
}

/** Snippet languages for docs export: cURL plus every language in CODE_GEN_LANGUAGES. */
export const DOC_SNIPPET_LANGUAGES: DocSnippetLanguage[] = [
  { id: 'curl', label: 'cURL', generate: req => buildCurlCommand(docRequestToCodeGenParams(req)) },
  ...CODE_GEN_LANGUAGES.map(lang => ({
    id: lang.id,
    label: lang.label,
    generate: (req: DocRequestModel) => lang.generate(docRequestToCodeGenParams(req)),
  })),
];
