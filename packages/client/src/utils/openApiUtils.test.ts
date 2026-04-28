import { describe, it, expect } from 'vitest';
import {
  parseOpenApiSpecWithPreview,
  filterOpenApiItemsByRequestIds,
  applyOpenApiHostReplacements,
} from './openApiUtils';

const SPEC = `openapi: 3.0.0
info:
  title: Demo API
  version: 1.0.0
servers:
  - url: https://api.example.com/v1
paths:
  /users:
    get:
      summary: List users
      tags: [Users]
  /users/{id}:
    get:
      summary: Get user
      tags: [Users]
  /orders:
    post:
      summary: Create order
      tags: [Orders]
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
security:
  - bearerAuth: []
`;

describe('parseOpenApiSpecWithPreview', () => {
  it('returns preview requests and detected hosts', () => {
    const parsed = parseOpenApiSpecWithPreview(SPEC);
    expect(parsed.collectionName).toBe('Demo API');
    expect(parsed.requestPreviews).toHaveLength(3);
    expect(parsed.detectedHosts).toContain('https://api.example.com');
    expect(parsed.collectionAuth?.type).toBe('bearer');
  });
});

describe('filterOpenApiItemsByRequestIds', () => {
  it('keeps selected requests and prunes empty folders', () => {
    const parsed = parseOpenApiSpecWithPreview(SPEC);
    const usersReq = parsed.requestPreviews.find(req => req.path === '/users' && req.method === 'GET');

    expect(usersReq?.id).toBeTruthy();

    const filtered = filterOpenApiItemsByRequestIds(parsed.items, [usersReq!.id]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('Users');
    expect(filtered[0].item).toHaveLength(1);
    expect(filtered[0].item?.[0].request?.method).toBe('GET');
  });
});

describe('applyOpenApiHostReplacements', () => {
  it('replaces detected host with provided token', () => {
    const parsed = parseOpenApiSpecWithPreview(SPEC);
    const rewritten = applyOpenApiHostReplacements(parsed.items, [
      { from: 'https://api.example.com', to: '{{baseUrl}}' },
    ]);

    const usersFolder = rewritten.find(item => item.name === 'Users');
    const firstReq = usersFolder?.item?.[0];
    const rawUrl = typeof firstReq?.request?.url === 'string'
      ? firstReq.request.url
      : firstReq?.request?.url?.raw;

    expect(rawUrl).toContain('{{baseUrl}}/v1/users');
  });

  it('leaves URLs unchanged when replacement list is empty', () => {
    const parsed = parseOpenApiSpecWithPreview(SPEC);
    const rewritten = applyOpenApiHostReplacements(parsed.items, []);
    expect(rewritten).toEqual(parsed.items);
  });
});
