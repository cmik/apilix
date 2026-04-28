import { useApp, parseCollectionFile, parseEnvironmentFile, generateId } from '../store';
import { parseHurlFile, HURL_METHOD_REGEX } from './hurlUtils';
import {
  parseOpenApiSpec,
  filterOpenApiItemsByRequestIds,
  applyOpenApiHostReplacements,
  assignFreshIds,
  type OpenApiImportOptions,
} from './openApiUtils';
import { parseHarFile } from './harUtils';
import { parseWsdlToCollection, isWsdlContent } from './wsdlUtils';
import { tryParseInsomniaText } from './insomniaUtils';
import { useToast } from '../components/Toast';

/**
 * Returns an async function that parses and imports a collection/environment/spec
 * from raw text. All formats supported by ImportModal are handled.
 *
 * Returns `true` on successful import, `false` if an error occurred (shown via toast).
 *
 * @param targetCollectionId - Optional: collection id to append HURL items into.
 */
export function useImportFile() {
  const { state, dispatch } = useApp();
  const toast = useToast();

  return async function importFile(
    text: string,
    filename?: string,
    sourceUrl?: string,
    targetCollectionId?: string,
    openApiOptions?: OpenApiImportOptions,
  ): Promise<boolean> {

    // ── Insomnia v4 (JSON) or v5 (YAML/JSON) ────────────────────────────────
    const insomniaResult = tryParseInsomniaText(text);
    if (insomniaResult) {
      try {
        const { collections, environments } = insomniaResult;
        collections.forEach(col => dispatch({ type: 'ADD_COLLECTION', payload: col }));
        environments.forEach(env => dispatch({ type: 'ADD_ENVIRONMENT', payload: env }));
        toast.success(
          `Insomnia import: ${collections.length} collection(s), ${environments.length} environment(s).`
        );
        return true;
      } catch (e) {
        toast.error(`Insomnia parse error: ${(e as Error).message}`);
        return false;
      }
    }

    // ── WSDL (must come before JSON parsing) ────────────────────────────────
    if (isWsdlContent(text, filename)) {
      try {
        const { collectionName, items } = parseWsdlToCollection(text, sourceUrl);
        const newColId = generateId();
        dispatch({
          type: 'ADD_COLLECTION',
          payload: {
            _id: newColId,
            info: {
              name: collectionName,
              schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
            },
            item: items,
          },
        });
        toast.success(`Collection "${collectionName}" with ${items.length} operation(s) imported from WSDL!`);
        return true;
      } catch (e) {
        toast.error(`WSDL parse error: ${(e as Error).message}`);
        return false;
      }
    }

    // ── OpenAPI / Swagger (by extension or content) ──────────────────────────
    const isOpenApiFile =
      filename?.toLowerCase().endsWith('.yaml') ||
      filename?.toLowerCase().endsWith('.yml') ||
      (filename?.toLowerCase().endsWith('.json') && (() => {
        try { const j = JSON.parse(text); return !!(j.openapi || j.swagger); } catch { return false; }
      })());

    if (isOpenApiFile) {
      try {
        const { collectionName, items, collectionAuth } = parseOpenApiSpec(text, filename);
        const selectedIds = openApiOptions?.selectedRequestIds;
        const hostReplacements = openApiOptions?.hostReplacements;

        let importedItems = items;
        if (Array.isArray(selectedIds)) {
          if (selectedIds.length === 0) {
            toast.error('No OpenAPI requests selected for import.');
            return false;
          }
          importedItems = filterOpenApiItemsByRequestIds(importedItems, selectedIds);
        }
        if (hostReplacements && hostReplacements.length > 0) {
          importedItems = applyOpenApiHostReplacements(importedItems, hostReplacements);
        }
        importedItems = assignFreshIds(importedItems);

        const newColId = generateId();
        dispatch({
          type: 'ADD_COLLECTION',
          payload: {
            _id: newColId,
            info: {
              name: collectionName,
              schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
            },
            item: importedItems,
            ...(collectionAuth && { auth: collectionAuth }),
          },
        });
        const total = importedItems.reduce((sum, i) => sum + (i.item ? i.item.length : 1), 0);
        toast.success(`Collection "${collectionName}" with ${total} request(s) imported!`);
        return true;
      } catch (e) {
        toast.error(`OpenAPI parse error: ${(e as Error).message}`);
        return false;
      }
    }

    // ── HAR (by extension or log.entries structure) ──────────────────────────
    const isHarFile =
      filename?.toLowerCase().endsWith('.har') ||
      (!filename && (() => {
        try { const j = JSON.parse(text); return !!(j?.log?.entries); } catch { return false; }
      })());
    if (isHarFile) {
      try {
        const items = parseHarFile(text);
        if (items.length === 0) {
          toast.error('No requests found in HAR file.');
          return false;
        }
        const newColId = generateId();
        const colName = filename ? filename.replace(/\.har$/i, '') : 'HAR Import';
        dispatch({
          type: 'ADD_COLLECTION',
          payload: {
            _id: newColId,
            info: {
              name: colName,
              schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
            },
            item: items,
          },
        });
        const total = items.reduce((sum, i) => sum + (i.item ? i.item.length : 1), 0);
        toast.success(`Collection "${colName}" with ${total} request(s) imported!`);
        return true;
      } catch (e) {
        toast.error(`HAR parse error: ${(e as Error).message}`);
        return false;
      }
    }

    // ── HURL (by extension, or content heuristic) ────────────────────────────
    const isHurlFile = filename?.toLowerCase().endsWith('.hurl');
    if (isHurlFile || (!text.trimStart().startsWith('{') && HURL_METHOD_REGEX.test(text))) {
      const col = targetCollectionId
        ? state.collections.find(c => c._id === targetCollectionId)
        : undefined;
      const items = parseHurlFile(text);
      if (items.length === 0) {
        if (isHurlFile) {
          toast.error('No valid HURL requests found in file.');
          return false;
        }
        // Not a HURL file and heuristic matched but produced nothing → fall through to JSON
      } else {
        if (col) {
          dispatch({ type: 'UPDATE_COLLECTION', payload: { ...col, item: [...col.item, ...items] } });
          toast.success(`${items.length} request(s) from HURL file added to "${col.info.name}".`);
        } else {
          const newColId = generateId();
          const colName = filename ? filename.replace(/\.hurl$/i, '') : 'HURL Import';
          dispatch({
            type: 'ADD_COLLECTION',
            payload: {
              _id: newColId,
              info: {
                name: colName,
                schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
              },
              item: items,
            },
          });
          toast.success(`Collection "${colName}" with ${items.length} request(s) imported!`);
        }
        return true;
      }
    }

    // ── JSON: Postman Collection, Postman Environment, or OpenAPI JSON ────────
    try {
      const json = JSON.parse(text);
      if (json.info && json.item) {
        const { collection: col, version, validationWarnings } = await parseCollectionFile(json);
        dispatch({ type: 'ADD_COLLECTION', payload: col });
        const versionLabel = `Postman Collection v${version}`;
        if (validationWarnings.length > 0) {
          toast.warning(`"${col.info.name}" imported as ${versionLabel} with ${validationWarnings.length} schema warning(s):\n• ${validationWarnings.join('\n• ')}`, 8000);
        } else {
          toast.success(`"${col.info.name}" imported as ${versionLabel}.`);
        }
        return true;
      } else if (json.name && Array.isArray(json.values)) {
        const env = parseEnvironmentFile(json);
        dispatch({ type: 'ADD_ENVIRONMENT', payload: env });
        toast.success(`Environment "${env.name}" imported!`);
        return true;
      } else if (json.openapi || json.swagger) {
        try {
          const { collectionName, items, collectionAuth } = parseOpenApiSpec(text);
          const selectedIds = openApiOptions?.selectedRequestIds;
          const hostReplacements = openApiOptions?.hostReplacements;

          let importedItems = items;
          if (Array.isArray(selectedIds)) {
            if (selectedIds.length === 0) {
              toast.error('No OpenAPI requests selected for import.');
              return false;
            }
            importedItems = filterOpenApiItemsByRequestIds(importedItems, selectedIds);
          }
          if (hostReplacements && hostReplacements.length > 0) {
            importedItems = applyOpenApiHostReplacements(importedItems, hostReplacements);
          }
          importedItems = assignFreshIds(importedItems);

          const newColId = generateId();
          dispatch({
            type: 'ADD_COLLECTION',
            payload: {
              _id: newColId,
              info: {
                name: collectionName,
                schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
              },
              item: importedItems,
              ...(collectionAuth && { auth: collectionAuth }),
            },
          });
          const total = importedItems.reduce((sum, i) => sum + (i.item ? i.item.length : 1), 0);
          toast.success(`Collection "${collectionName}" with ${total} request(s) imported!`);
          return true;
        } catch (e) {
          toast.error(`OpenAPI parse error: ${(e as Error).message}`);
          return false;
        }
      } else {
        toast.error('Unrecognised format. Expected a Postman Collection v2.0/v2.1, Environment JSON, HURL, or OpenAPI/Swagger spec.');
        return false;
      }
    } catch (e) {
      toast.error(`Invalid JSON: ${(e as Error).message}`);
      return false;
    }
  };
}
