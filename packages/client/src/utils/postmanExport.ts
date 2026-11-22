import type { AppCollection, ResponseSchema } from '../types';
import { schemasUsedByItems } from './responseSchemas';

/**
 * Postman Collection v2.1 export of an Apilix collection. Apilix-only data rides in `apilix`
 * extension fields (ignored by Postman): request links live in `item[].request.apilix`, the schemas
 * those links (transitively) use in the top-level `apilix.schemas`.
 */
export function buildPostmanExport(col: AppCollection, schemas: ResponseSchema[] = []) {
  const used = schemasUsedByItems(col.item, schemas);
  return {
    info: {
      name: col.info.name,
      description: col.info.description,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      _postman_id: col._id,
    },
    item: col.item,
    auth: col.auth,
    event: col.event,
    variable: col.variable,
    ...(used.length > 0 ? { apilix: { ...(col.apilix ?? {}), schemas: used } } : {}),
  };
}
