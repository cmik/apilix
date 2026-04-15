import type { CollectionItem } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WsdlOperation {
  name: string;
  soapAction: string;
  namespace: string;
  inputParts: Array<{ name: string; type: string }>;
  /** Document-literal: the XSD element that becomes the SOAP body child. */
  bodyElement?: string;
  /** Named complex type map (for recursive field expansion). */
  complexTypes?: Record<string, Array<{ name: string; type: string }>>;
}

// ─── Detection ────────────────────────────────────────────────────────────────

/** Returns true when the text is likely WSDL XML (by filename or content). */
export function isWsdlContent(text: string, filename?: string): boolean {
  if (filename?.toLowerCase().endsWith('.wsdl')) return true;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('<')) return false;
  return (
    text.includes('http://schemas.xmlsoap.org/wsdl/') ||
    text.includes('http://www.w3.org/ns/wsdl') ||
    (text.includes('<definitions') && text.includes('wsdl'))
  );
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parses all named <complexType> declarations from the inline XSD.
 * Returns a map from type name → child element fields.
 */
function parseComplexTypes(
  doc: Document,
): Record<string, Array<{ name: string; type: string }>> {
  const types: Record<string, Array<{ name: string; type: string }>> = {};
  doc.querySelectorAll('complexType').forEach(ct => {
    const typeName = ct.getAttribute('name');
    if (!typeName) return;
    const container =
      ct.querySelector('sequence, all, choice') ??
      ct.querySelector('complexContent > extension > sequence');
    if (!container) return;
    const fields = Array.from(container.children)
      .filter(c => c.localName === 'element')
      .map(c => {
        const raw = c.getAttribute('type') ?? '';
        return { name: c.getAttribute('name') ?? '', type: raw.includes(':') ? raw.split(':').pop()! : raw };
      })
      .filter(f => f.name);
    if (fields.length > 0) types[typeName] = fields;
  });
  return types;
}

/**
 * Parses top-level <element> declarations from <types><schema>.
 * Resolves fields either from inline complexType or a referenced named complexType.
 */
function parseSchemaElements(
  doc: Document,
  complexTypes: Record<string, Array<{ name: string; type: string }>>,
): Record<string, Array<{ name: string; type: string }>> {
  const elements: Record<string, Array<{ name: string; type: string }>> = {};
  doc.querySelectorAll('types schema').forEach(schema => {
    Array.from(schema.children).forEach(el => {
      if (el.localName !== 'element') return;
      const name = el.getAttribute('name');
      if (!name) return;
      // Inline complexType
      const container =
        el.querySelector('complexType > sequence, complexType > all, complexType > choice') ??
        el.querySelector('complexType > complexContent > extension > sequence');
      if (container) {
        const fields = Array.from(container.children)
          .filter(c => c.localName === 'element')
          .map(c => {
            const raw = c.getAttribute('type') ?? '';
            return { name: c.getAttribute('name') ?? '', type: raw.includes(':') ? raw.split(':').pop()! : raw };
          })
          .filter(f => f.name);
        if (fields.length > 0) elements[name] = fields;
        return;
      }
      // type="tns:SomeComplexType" reference
      const typeAttr = el.getAttribute('type') ?? '';
      if (typeAttr) {
        const typeName = typeAttr.includes(':') ? typeAttr.split(':').pop()! : typeAttr;
        const resolved = complexTypes[typeName];
        if (resolved) elements[name] = resolved;
      }
    });
  });
  return elements;
}

/** Parses WSDL 1.1 XML and returns a list of operations with their metadata. */
export function parseWsdl(xml: string): WsdlOperation[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  if (doc.querySelector('parsererror')) return [];

  const ops: WsdlOperation[] = [];

  // Walk binding > operation elements (covers both prefixed and non-prefixed)
  const bindingOps = Array.from(
    doc.querySelectorAll('binding > operation, binding operation')
  );

  // Resolve XSD schema structure for field expansion
  const complexTypes = parseComplexTypes(doc);
  const schemaElements = parseSchemaElements(doc, complexTypes);

  // Build message-name → parts map (tracking element= vs type= references)
  interface RawPart { name: string; type: string; elementRef: string | null; }
  const messageRawParts: Record<string, RawPart[]> = {};
  doc.querySelectorAll('message').forEach(msg => {
    const msgName = msg.getAttribute('name') ?? '';
    const parts = Array.from(msg.querySelectorAll('part')).map(p => ({
      name: p.getAttribute('name') ?? '',
      type: p.getAttribute('type') ?? '',
      elementRef: p.getAttribute('element') ?? null,
    }));
    messageRawParts[msgName] = parts;
  });

  const targetNs =
    doc.documentElement.getAttribute('targetNamespace') ??
    doc.documentElement.getAttribute('xmlns:tns') ??
    '';

  for (const op of bindingOps) {
    const opName = op.getAttribute('name') ?? '';
    if (!opName) continue;

    const soapOpEl =
      op.querySelector('operation[soapAction]') ??
      op.querySelector('[soapAction]');
    const soapAction = soapOpEl?.getAttribute('soapAction') ?? '';

    const ptOp = doc.querySelector(`portType > operation[name="${opName}"]`);
    let inputParts: Array<{ name: string; type: string }> = [];
    let bodyElement: string | undefined;

    if (ptOp) {
      const inputEl = ptOp.querySelector('input');
      const msgAttr = inputEl?.getAttribute('message') ?? '';
      const msgName = msgAttr.includes(':') ? msgAttr.split(':').pop()! : msgAttr;
      const rawParts = messageRawParts[msgName] ?? [];

      if (rawParts.length === 1 && rawParts[0].elementRef) {
        // Document-literal: single part with element reference
        const elRef = rawParts[0].elementRef;
        const elLocal = elRef.includes(':') ? elRef.split(':').pop()! : elRef;
        bodyElement = elLocal;
        inputParts = schemaElements[elLocal] ?? [];
      } else {
        // RPC-style or multi-part: use part names directly
        inputParts = rawParts.map(p => ({
          name: p.name,
          type: p.type.includes(':') ? p.type.split(':').pop()! : p.type,
        }));
      }
    }

    ops.push({ name: opName, soapAction, namespace: targetNs, inputParts, bodyElement, complexTypes });
  }

  return ops;
}

// ─── Envelope builder ─────────────────────────────────────────────────────────

// Primitive XSD type names — these are rendered as leaf values, not expanded
const XSD_PRIMITIVES = new Set([
  'string', 'int', 'integer', 'long', 'short', 'byte',
  'float', 'double', 'decimal', 'boolean',
  'date', 'time', 'dateTime', 'duration',
  'anyURI', 'base64Binary', 'hexBinary', 'anyType', '',
]);

/**
 * Recursively builds XML for a list of fields.
 * When a field type is a known complex type it is expanded inline.
 * depth controls indentation (starts at 3 = 6 spaces inside body element).
 */
function buildFieldsXml(
  fields: Array<{ name: string; type: string }>,
  complexTypes: Record<string, Array<{ name: string; type: string }>>,
  depth: number,
  visited: Set<string>,
): string {
  const pad = '  '.repeat(depth);
  return fields
    .map(f => {
      const childFields = complexTypes[f.type];
      if (childFields && !XSD_PRIMITIVES.has(f.type) && !visited.has(f.type)) {
        const inner = buildFieldsXml(childFields, complexTypes, depth + 1, new Set([...visited, f.type]));
        return `${pad}<${f.name}>\n${inner}\n${pad}</${f.name}>`;
      }
      return `${pad}<${f.name}>${f.type || 'string'}</${f.name}>`;
    })
    .join('\n');
}

/** Generates a starter SOAP envelope for an operation. */
export function buildEnvelope(op: WsdlOperation, version: '1.1' | '1.2'): string {
  const ns = op.namespace ? ` xmlns:tns="${op.namespace}"` : '';
  const bodyEl = op.bodyElement ?? op.name;
  const ct = op.complexTypes ?? {};

  let paramsXml: string;
  if (op.inputParts.length === 0) {
    paramsXml = `      <!-- parameters -->`;
  } else if (op.bodyElement) {
    // Document-literal: expand fields recursively, unqualified names
    paramsXml = buildFieldsXml(op.inputParts, ct, 3, new Set());
  } else {
    // RPC-style: parts use tns: prefix, self-closing placeholder
    paramsXml = op.inputParts.map(p => `      <tns:${p.name}/>`).join('\n');
  }

  if (version === '1.2') {
    return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"${ns}>
  <soap12:Header/>
  <soap12:Body>
    <tns:${bodyEl}>
${paramsXml}
    </tns:${bodyEl}>
  </soap12:Body>
</soap12:Envelope>`;
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"${ns}>
  <soap:Header/>
  <soap:Body>
    <tns:${bodyEl}>
${paramsXml}
    </tns:${bodyEl}>
  </soap:Body>
</soap:Envelope>`;
}

/** Returns a blank SOAP envelope template for the given version. */
export function defaultEnvelope(version: '1.1' | '1.2'): string {
  if (version === '1.2') {
    return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Header/>
  <soap12:Body>
    <!-- your operation here -->
  </soap12:Body>
</soap12:Envelope>`;
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header/>
  <soap:Body>
    <!-- your operation here -->
  </soap:Body>
</soap:Envelope>`;
}

// ─── Collection builder ───────────────────────────────────────────────────────

/**
 * Converts a WSDL 1.1 document into a collection structure.
 * Returns one folder per service, with one request per operation.
 */
export function parseWsdlToCollection(
  xml: string,
  wsdlUrl?: string,
): { collectionName: string; items: CollectionItem[] } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  if (doc.querySelector('parsererror')) {
    throw new Error('Invalid XML — could not parse WSDL');
  }

  // Service name from <service name="...">
  const serviceEl = doc.querySelector('service');
  const collectionName = serviceEl?.getAttribute('name') ?? 'SOAP Service';

  // Endpoint URL from the first <soap:address location="..."> or <soap12:address location="...">
  const addressEl = doc.querySelector('[location]');
  const endpointUrl =
    addressEl?.getAttribute('location') ??
    (wsdlUrl ? wsdlUrl.replace(/[?#].*$/, '') : '');

  // SOAP version: detect by whether a soap12:binding element is actually declared.
  // We check the raw XML for the WSDL SOAP 1.2 namespace being used as a binding —
  // NOT just the soap-envelope namespace (which can appear in schema sections of any WSDL).
  // Default to SOAP 1.1 when ambiguous; most real-world services are SOAP 1.1.
  const isSoap12 =
    xml.includes('http://schemas.xmlsoap.org/wsdl/soap12/') &&
    /<[^>]*soap12:[^>]*binding/i.test(xml);
  const version: '1.1' | '1.2' = isSoap12 ? '1.2' : '1.1';

  const operations = parseWsdl(xml);

  if (operations.length === 0) {
    throw new Error('No SOAP operations found in WSDL (or unsupported WSDL format)');
  }

  // Deduplicate: some WSDLs expose multiple bindings for the same operation
  const seen = new Set<string>();
  const uniqueOps = operations.filter(op => {
    if (seen.has(op.name)) return false;
    seen.add(op.name);
    return true;
  });

  const requestItems: CollectionItem[] = uniqueOps.map(op => {
    const envelope = buildEnvelope(op, version);

    const headers: Array<{ key: string; value: string }> = [];
    if (version === '1.2') {
      headers.push({
        key: 'Content-Type',
        value: `application/soap+xml; charset=utf-8${op.soapAction ? `; action="${op.soapAction}"` : ''}`,
      });
    } else {
      headers.push({ key: 'Content-Type', value: 'text/xml; charset=utf-8' });
      if (op.soapAction) headers.push({ key: 'SOAPAction', value: `"${op.soapAction}"` });
    }

    return {
      name: op.name,
      request: {
        method: 'POST',
        url: { raw: endpointUrl },
        header: headers,
        body: {
          mode: 'raw',
          raw: envelope,
          options: { raw: { language: 'xml' } },
          soap: { action: op.soapAction, version, wsdlUrl: wsdlUrl },
        },
      },
    };
  });

  // Return request items directly under the collection — no redundant subfolder
  return { collectionName, items: requestItems };
}
