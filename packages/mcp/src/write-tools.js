'use strict';

/**
 * Write tools. Disabled unless the operator passes --allow-write. Writes happen only inside the
 * workspace allow-list, never overwrite without overwrite:true, and are atomic (tmp + rename/link).
 */

const { WorkspaceError } = require('./workspace');
const { listNodes } = require('./model');

const MAX_ITEMS = 5000;
const MAX_DEPTH = 20;

function countAndCheck(items, depth, acc) {
  if (!Array.isArray(items)) throw new WorkspaceError('"item" must be an array', 'EBADARG');
  if (depth > MAX_DEPTH) throw new WorkspaceError(`Folders are nested deeper than ${MAX_DEPTH} levels`, 'EBADARG');
  for (const it of items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw new WorkspaceError('Every item must be an object', 'EBADARG');
    acc.n += 1;
    if (acc.n > MAX_ITEMS) throw new WorkspaceError(`Too many items (max ${MAX_ITEMS})`, 'EBADARG');
    if (typeof it.name !== 'string') throw new WorkspaceError('Every item needs a "name" string', 'EBADARG');
    if (Array.isArray(it.item)) countAndCheck(it.item, depth + 1, acc);
    else if (!it.request || typeof it.request !== 'object') throw new WorkspaceError(`Item "${it.name.slice(0, 60)}" has neither "item" nor "request"`, 'EBADARG');
  }
}

/** Minimal structural validation of a Postman Collection v2.0/v2.1 document. */
function validatePostmanCollection(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new WorkspaceError('collection must be an object', 'EBADARG');
  if (!c.info || typeof c.info !== 'object' || typeof c.info.name !== 'string' || c.info.name.trim() === '') {
    throw new WorkspaceError('collection.info.name (non-empty string) is required', 'EBADARG');
  }
  if (c.info.schema !== undefined && !(typeof c.info.schema === 'string' && /collection\/v2\.[01]/.test(c.info.schema))) {
    throw new WorkspaceError('Only Postman Collection v2.0/v2.1 is supported (info.schema)', 'EBADARG');
  }
  countAndCheck(c.item, 0, { n: 0 });
  if (c.variable !== undefined && !Array.isArray(c.variable)) throw new WorkspaceError('"variable" must be an array', 'EBADARG');
  if (c.event !== undefined && !Array.isArray(c.event)) throw new WorkspaceError('"event" must be an array', 'EBADARG');
}

const tools = [
  {
    name: 'import_collection',
    title: 'Write a Postman collection file into the workspace',
    description: 'Save a Postman Collection v2.0/v2.1 JSON document as a file inside the workspace folder so it can be listed and run. WRITE tool: available only when the server was started with --allow-write. Never replaces an existing file unless overwrite is true, and then only a file that already is a recognised collection. The collection\'s scripts are not executed by this call, but they WILL run if the collection is later run with run_collection/run_request.',
    enabled: (o) => o.allowWrite === true,
    disabledMessage: 'Writing is disabled on this server (read-only). The operator must start it with --allow-write.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['file', 'collection'],
      properties: {
        file: { type: 'string', minLength: 6, maxLength: 512, description: 'Relative target path inside the workspace, ending in .json (e.g. "api/users.postman_collection.json"). The folder must already exist.' },
        collection: { type: 'object', description: 'The Postman Collection v2.0/v2.1 document (info + item[]).' },
        workspace: { type: 'string', minLength: 1, maxLength: 100, description: 'Workspace label (required only when several --workspace folders are configured; see list_collections).' },
        overwrite: { type: 'boolean', description: 'Replace an existing recognised collection file (default false).' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async handler(args, ctx) {
      validatePostmanCollection(args.collection);
      const text = `${JSON.stringify(args.collection, null, 2)}\n`;
      const r = await ctx.workspaces.writeJsonAtomic(args.workspace || null, args.file, text, { overwrite: args.overwrite === true });
      const nodes = listNodes(args.collection);
      ctx.log(`import_collection wrote ${r.file} (${r.bytes} bytes${r.replaced ? ', replaced' : ''})`);
      return {
        file: r.file,
        bytes: r.bytes,
        replaced: r.replaced,
        requests: nodes.filter((n) => n.type === 'request').length,
        folders: nodes.filter((n) => n.type === 'folder').length,
      };
    },
  },
];

module.exports = { tools, validatePostmanCollection };
