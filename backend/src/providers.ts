import { XMLParser } from 'fast-xml-parser';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

export type ProviderName = 'google' | 'microsoft' | 'icloud';
export type ContactData = Record<string, unknown>;
export type RemoteContact = { id: string; data: ContactData; etag?: string; document?: string };
export type ProviderCredentials = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  username?: string;
  appPassword?: string;
  addressBookUrl?: string;
};
export type ProviderDelta = {
  changed: RemoteContact[];
  deleted: string[];
  cursor: string | null;
  fullSync: boolean;
};

const fetchJson = async (url: string, init?: RequestInit): Promise<any> => {
  const target = new URL(url);
  if (target.origin !== 'https://graph.microsoft.com'
    && target.origin !== 'https://people.googleapis.com'
    && target.origin !== 'https://oauth2.googleapis.com'
    && !target.hostname.endsWith('.microsoftonline.com')) {
    throw new Error('Unexpected provider request host.');
  }
  const response = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) });
  if (!response.ok) {
    const error = new Error(`Provider request failed (${response.status})`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  return response.status === 204 ? undefined : response.json();
};

async function bearerFetch(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) }
  });
}

async function refreshAccessToken(provider: 'google' | 'microsoft', credentials: ProviderCredentials): Promise<ProviderCredentials> {
  if (credentials.accessToken && (credentials.expiresAt ?? 0) > Date.now() + 60_000) return credentials;
  if (!credentials.refreshToken) throw new Error('Provider authorization expired; reconnect this account.');

  const google = provider === 'google';
  const endpoint = google
    ? 'https://oauth2.googleapis.com/token'
    : `https://login.microsoftonline.com/${encodeURIComponent(config.microsoft.tenantId)}/oauth2/v2.0/token`;
  const client = google ? config.google : config.microsoft;
  const form = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: 'refresh_token'
  });
  if (!google) form.set('scope', 'offline_access User.Read Contacts.ReadWrite');
  const result = await fetchJson(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form
  });
  return {
    ...credentials,
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? credentials.refreshToken,
    expiresAt: Date.now() + Number(result.expires_in) * 1000
  };
}

const canonical = (value: ContactData): ContactData => {
  const output: ContactData = {};
  for (const key of ['firstName', 'lastName', 'displayName', 'email', 'phone', 'company', 'notes']) {
    const field = value[key];
    if (typeof field === 'string' && field.trim()) output[key] = field.trim();
  }
  return output;
};

function fromGoogle(person: any): ContactData {
  const name = person.names?.[0] ?? {};
  return canonical({
    firstName: name.givenName, lastName: name.familyName, displayName: name.displayName,
    email: person.emailAddresses?.[0]?.value, phone: person.phoneNumbers?.[0]?.value,
    company: person.organizations?.[0]?.name, notes: person.biographies?.[0]?.value
  });
}

function fromMicrosoft(contact: any): ContactData {
  return canonical({
    firstName: contact.givenName, lastName: contact.surname, displayName: contact.displayName,
    email: contact.emailAddresses?.[0]?.address, phone: contact.mobilePhone ?? contact.businessPhones?.[0],
    company: contact.companyName, notes: contact.personalNotes
  });
}

const xmlParser = new XMLParser({
  removeNSPrefix: true, ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text',
  parseTagValue: false, trimValues: true
});

function findKey(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== 'object') return [];
  const found: unknown[] = [];
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    if (name.toLowerCase() === key.toLowerCase()) found.push(child);
    found.push(...findKey(child, key));
  }
  return found;
}

function scalar(value: any): string | undefined {
  const decode = (text: string) => text
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  if (typeof value === 'string') return decode(value);
  if (value && typeof value === 'object' && typeof value['#text'] === 'string') return decode(value['#text']);
  return undefined;
}

function all(value: unknown): any[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

const unescapeVcard = (text: string): string => text.replace(/\\[nN]/g, '\n').replace(/\\([,;\\])/g, '$1');
const escapeVcard = (text: string): string => text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

function fromVcard(text: string): ContactData {
  const fields: Record<string, string[]> = {};
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).split(';')[0]?.toUpperCase();
    if (key) (fields[key] ??= []).push(line.slice(colon + 1));
  }
  const nameParts = (fields.N?.[0] ?? '').split(';');
  const firstName = unescapeVcard(nameParts[1] ?? '');
  const lastName = unescapeVcard(nameParts[0] ?? '');
  const email = fields.EMAIL?.[0]?.replace(/^[^:]*:/, '');
  const phone = fields.TEL?.[0]?.replace(/^[^:]*:/, '');
  const org = fields.ORG?.[0]?.split(';')[0];
  const note = fields.NOTE?.[0];
  return canonical({
    firstName, lastName, displayName: unescapeVcard(fields.FN?.[0] ?? ''),
    email: email ? unescapeVcard(email) : undefined, phone: phone ? unescapeVcard(phone) : undefined,
    company: org ? unescapeVcard(org) : undefined, notes: note ? unescapeVcard(note) : undefined
  });
}

function toVcard(contact: ContactData, uid: string, previous?: string): string {
  const text = (value: unknown) => typeof value === 'string' ? escapeVcard(value) : '';
  const first = text(contact.firstName), last = text(contact.lastName);
  const display = text(contact.displayName) || [first, last].filter(Boolean).join(' ');
  let emailCount = 0, phoneCount = 0, orgCount = 0, noteCount = 0;
  const preserved = previous ? previous.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter((line) => {
    const property = line.slice(0, line.indexOf(':')).split(';')[0]?.toUpperCase();
    if (!property || ['BEGIN', 'END', 'VERSION', 'FN', 'N'].includes(property)) return false;
    if (property === 'EMAIL') return emailCount++ > 0;
    if (property === 'TEL') return phoneCount++ > 0;
    if (property === 'ORG') return orgCount++ > 0;
    if (property === 'NOTE') return noteCount++ > 0;
    return true;
  }) : [];
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  if (!preserved.some((line) => line.toUpperCase().startsWith('UID:'))) lines.push(`UID:${escapeVcard(uid)}`);
  lines.push(...preserved, `FN:${display}`, `N:${last};${first};;;`);
  if (contact.email) lines.push(`EMAIL;TYPE=INTERNET:${text(contact.email)}`);
  if (contact.phone) lines.push(`TEL;TYPE=CELL:${text(contact.phone)}`);
  if (contact.company) lines.push(`ORG:${text(contact.company)}`);
  if (contact.notes) lines.push(`NOTE:${text(contact.notes)}`);
  lines.push('END:VCARD', '');
  return lines.join('\r\n');
}

async function appleRequest(
  credentials: ProviderCredentials, url: string, method: string, body?: string, extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !/(^|\.)icloud\.com$/i.test(target.hostname)) {
    throw new Error('Apple CardDAV returned an unexpected host.');
  }
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.appPassword}`).toString('base64')}`;
  const response = await fetch(target, {
    method, redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
    headers: {
      authorization,
      ...(body ? { 'content-type': 'application/xml; charset=utf-8' } : {}),
      ...(body ? { depth: '1' } : {}),
      ...extraHeaders
    },
    body
  });
  const finalUrl = new URL(response.url || target.toString());
  if (finalUrl.protocol !== 'https:' || !/(^|\.)icloud\.com$/i.test(finalUrl.hostname)) {
    throw new Error('Apple CardDAV redirected to an unexpected host.');
  }
  return response;
}

async function appleDiscover(credentials: ProviderCredentials): Promise<string> {
  const root = 'https://contacts.icloud.com/.well-known/carddav';
  const propfind = (props: string) => `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:prop>${props}</d:prop></d:propfind>`;
  const homeProps = '<d:current-user-principal><d:href/></d:current-user-principal>';
  let response = await appleRequest(credentials, root, 'PROPFIND', propfind(homeProps));
  if (!response.ok && response.status !== 207) throw new Error(`Apple CardDAV discovery failed (${response.status}).`);
  let xml = xmlParser.parse(await response.text());
  const principalProperty = findKey(xml, 'current-user-principal')[0];
  let principal = scalar(findKey(principalProperty, 'href')[0]);
  if (!principal) throw new Error('Apple CardDAV did not return a user principal.');
  let principalUrl = new URL(principal, response.url || root).toString();
  const home = await appleRequest(credentials, principalUrl, 'PROPFIND', propfind('<c:addressbook-home-set><d:href/></c:addressbook-home-set>'));
  if (!home.ok && home.status !== 207) throw new Error(`Apple CardDAV home discovery failed (${home.status}).`);
  xml = xmlParser.parse(await home.text());
  const homeProperty = findKey(xml, 'addressbook-home-set')[0];
  const homeUrl = scalar(findKey(homeProperty, 'href')[0]);
  if (!homeUrl) throw new Error('Apple CardDAV did not return an address book home.');
  const books = await appleRequest(credentials, new URL(homeUrl, principalUrl).toString(), 'PROPFIND',
    propfind('<d:resourcetype/><d:displayname/><d:current-user-privilege-set/>'));
  if (!books.ok && books.status !== 207) throw new Error(`Apple address-book discovery failed (${books.status}).`);
  xml = xmlParser.parse(await books.text());
  const addressbooks = findKey(xml, 'addressbook');
  if (!addressbooks.length) throw new Error('No Apple address book was found for this account.');
  const bookNodes = findKey(xml, 'response').flatMap(all);
  const candidate = bookNodes.find((node) => findKey(node, 'addressbook').length > 0) ?? bookNodes[0];
  const href = candidate ? scalar(findKey(candidate, 'href')[0]) : undefined;
  if (!href) throw new Error('Apple CardDAV did not return an address-book URL.');
  const result = new URL(href, new URL(homeUrl, principalUrl));
  if (result.protocol !== 'https:' || !/(^|\.)icloud\.com$/i.test(result.hostname)) throw new Error('Apple CardDAV returned an unexpected address-book URL.');
  return result.toString();
}

export async function validateAppleCredentials(credentials: ProviderCredentials): Promise<string> {
  return appleDiscover(credentials);
}

async function appleDelta(credentials: ProviderCredentials, cursor: string | null): Promise<ProviderDelta> {
  const addressBookUrl = credentials.addressBookUrl ?? await appleDiscover(credentials);
  const safeCursor = cursor?.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') ?? '';
  const syncReport = `<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:sync-token>${safeCursor}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/><c:address-data/></d:prop></d:sync-collection>`;
  let response = await appleRequest(credentials, addressBookUrl, 'REPORT', syncReport);
  if ([403, 405, 409, 501].includes(response.status)) {
    if (cursor) return appleDelta(credentials, null);
    const query = `<?xml version="1.0"?><c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><c:address-data/></d:prop><c:filter/></c:addressbook-query>`;
    response = await appleRequest(credentials, addressBookUrl, 'REPORT', query);
  }
  if ((response.status === 403 || response.status === 409) && cursor) {
    return appleDelta(credentials, null);
  }
  if (!response.ok && response.status !== 207) throw new Error(`Apple CardDAV sync failed (${response.status}).`);
  const xml = xmlParser.parse(await response.text());
  const statuses = findKey(xml, 'status').map(scalar).join(' ');
  if (cursor && (findKey(xml, 'valid-sync-token').length > 0 || /HTTP\/1\.[01] (403|409)/.test(statuses))) {
    return appleDelta(credentials, null);
  }
  const responses = findKey(xml, 'response').flatMap(all);
  const changed: RemoteContact[] = [];
  const deleted: string[] = [];
  for (const node of responses) {
    const href = scalar(findKey(node, 'href')[0]);
    if (!href) continue;
    const id = new URL(href, addressBookUrl).toString();
    const status = findKey(node, 'status').map(scalar).join(' ');
    if (status.includes('404')) { deleted.push(id); continue; }
    const card = scalar(findKey(node, 'address-data')[0]);
    const etag = scalar(findKey(node, 'getetag')[0]);
    if (card) changed.push({ id, data: fromVcard(card), etag, document: card });
  }
  let token = scalar(findKey(xml, 'sync-token').at(-1)) ?? cursor;
  if (!token) {
    const tokenQuery = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:sync-token/></d:prop></d:propfind>`;
    const tokenResponse = await appleRequest(credentials, addressBookUrl, 'PROPFIND', tokenQuery);
    if (tokenResponse.ok || tokenResponse.status === 207) {
      token = scalar(findKey(xmlParser.parse(await tokenResponse.text()), 'sync-token').at(-1)) ?? null;
    }
  }
  return { changed, deleted, cursor: token ?? null, fullSync: !cursor };
}

export async function fetchDelta(
  provider: ProviderName, credentials: ProviderCredentials, cursor: string | null
): Promise<{ delta: ProviderDelta; credentials: ProviderCredentials }> {
  if (provider === 'icloud') {
    const addressBookUrl = credentials.addressBookUrl ?? await appleDiscover(credentials);
    credentials = { ...credentials, addressBookUrl };
    const delta = await appleDelta(credentials, cursor);
    delta.fullSync = !cursor;
    return { delta, credentials };
  }
  credentials = await refreshAccessToken(provider, credentials);
  if (provider === 'google') {
    const url = new URL('https://people.googleapis.com/v1/people/me/connections');
    url.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers,organizations,biographies');
    url.searchParams.set('pageSize', '1000');
    if (cursor) url.searchParams.set('syncToken', cursor);
    else url.searchParams.set('requestSyncToken', 'true');
    const changed: RemoteContact[] = [];
    const deleted: string[] = [];
    let nextPage: string | undefined;
    let nextSyncToken: string | null = cursor;
    try {
      do {
        if (nextPage) url.searchParams.set('pageToken', nextPage);
        const page = await fetchJson(url.toString(), { headers: { authorization: `Bearer ${credentials.accessToken}` } });
        for (const person of page.connections ?? []) {
          if (person.metadata?.deleted) deleted.push(person.resourceName);
          else changed.push({ id: person.resourceName, data: fromGoogle(person), etag: person.etag });
        }
        nextPage = page.nextPageToken;
        if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
      } while (nextPage);
    } catch (error) {
      if ((error as { status?: number }).status !== 410 || !cursor) throw error;
      return fetchDelta(provider, credentials, null);
    }
    return { delta: { changed, deleted, cursor: nextSyncToken, fullSync: !cursor }, credentials };
  }

  let root = cursor;
  if (!root) {
    let folderUrl: string | undefined = 'https://graph.microsoft.com/v1.0/me/contactFolders?$select=id,displayName';
    let folder: any;
    while (folderUrl && !folder) {
      if (new URL(folderUrl).origin !== 'https://graph.microsoft.com') throw new Error('Microsoft Graph returned an unexpected continuation URL.');
      const folders = await fetchJson(folderUrl, {
      headers: { authorization: `Bearer ${credentials.accessToken}` }
      });
      folder = folders.value?.find((item: any) => item.displayName?.toLowerCase() === 'contacts');
      folderUrl = folders['@odata.nextLink'];
    }
    if (!folder?.id) throw new Error('Microsoft Graph did not return a contacts folder.');
    root = `https://graph.microsoft.com/v1.0/me/contactFolders/${encodeURIComponent(folder.id)}/contacts/delta?$select=id,givenName,surname,displayName,emailAddresses,mobilePhone,businessPhones,companyName,personalNotes`;
  }
  const changed: RemoteContact[] = [];
  const deleted: string[] = [];
  let next: string | undefined = root;
  let deltaLink: string | null = cursor;
  try {
    while (next) {
      if (new URL(next).origin !== 'https://graph.microsoft.com') throw new Error('Microsoft Graph returned an unexpected continuation URL.');
      const page = await fetchJson(next, { headers: { authorization: `Bearer ${credentials.accessToken}` } });
      for (const item of page.value ?? []) {
        if (item['@removed']) deleted.push(item.id);
        else changed.push({ id: item.id, data: fromMicrosoft(item), etag: item.changeKey });
      }
      next = page['@odata.nextLink'];
      if (page['@odata.deltaLink']) deltaLink = page['@odata.deltaLink'];
    }
  } catch (error) {
    if ((error as { status?: number }).status === 410 && cursor) return fetchDelta(provider, credentials, null);
    throw error;
  }
  return { delta: { changed, deleted, cursor: deltaLink, fullSync: !cursor }, credentials };
}

export async function writeRemote(
  provider: ProviderName, credentials: ProviderCredentials, id: string | null, data: ContactData, etag?: string, document?: string
): Promise<{ id: string; etag?: string; credentials: ProviderCredentials; document?: string }> {
  if (provider === 'icloud') {
    const addressBookUrl = credentials.addressBookUrl ?? await appleDiscover(credentials);
    credentials = { ...credentials, addressBookUrl };
    const uid = id ? new URL(id).pathname.split('/').pop()?.replace(/\.vcf$/i, '') : randomUUID();
    const href = id ?? new URL(`${uid}.vcf`, addressBookUrl.endsWith('/') ? addressBookUrl : `${addressBookUrl}/`).toString();
    const updatedDocument = toVcard(data, uid ?? randomUUID(), document);
    const response = await appleRequest(
      credentials, href, 'PUT', updatedDocument, id && etag ? { 'if-match': etag } : {}
    );
    if (!response.ok && response.status !== 201 && response.status !== 204) throw new Error(`Apple CardDAV save failed (${response.status}).`);
    return { id: href, etag: response.headers.get('etag') ?? undefined, credentials, document: updatedDocument };
  }
  credentials = await refreshAccessToken(provider, credentials);
  if (provider === 'google') {
    const name: Record<string, unknown> = {};
    const nameFields: Array<[string, string]> = [
      ['firstName', 'givenName'], ['lastName', 'familyName'], ['displayName', 'displayName']
    ];
    for (const [field, key] of nameFields) {
      if (typeof data[field] === 'string') name[key] = data[field];
    }
    const body = {
      etag,
      names: Object.keys(name).length ? [name] : [],
      emailAddresses: data.email ? [{ value: data.email }] : [],
      phoneNumbers: data.phone ? [{ value: data.phone }] : [],
      organizations: data.company ? [{ name: data.company }] : [],
      biographies: data.notes ? [{ value: data.notes, contentType: 'TEXT_PLAIN' }] : []
    };
    const resourceName = id?.split('/').map(encodeURIComponent).join('/');
    const url = id
      ? `https://people.googleapis.com/v1/${resourceName}:updateContact?updatePersonFields=names,emailAddresses,phoneNumbers,organizations,biographies`
      : 'https://people.googleapis.com/v1/people:createContact';
    const result = await fetchJson(url, {
      method: id ? 'PATCH' : 'POST',
      headers: { authorization: `Bearer ${credentials.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { id: result.resourceName, etag: result.etag, credentials };
  }
  const base = 'https://graph.microsoft.com/v1.0/me/contacts';
  const body = {
    givenName: data.firstName ?? null, surname: data.lastName ?? null, displayName: data.displayName ?? null,
    emailAddresses: data.email ? [{ address: data.email, name: data.displayName }] : [],
    mobilePhone: data.phone ?? null, businessPhones: data.phone ? [data.phone] : [],
    companyName: data.company ?? null, personalNotes: data.notes ?? null
  };
  const url = id ? `${base}/${encodeURIComponent(id)}` : base;
  const result = await fetchJson(url, {
    method: id ? 'PATCH' : 'POST',
    headers: { authorization: `Bearer ${credentials.accessToken}`, 'content-type': 'application/json', ...(etag ? { 'if-match': etag } : {}) },
    body: JSON.stringify(body)
  });
  return { id: result.id, etag: result.changeKey, credentials };
}

export async function deleteRemote(
  provider: ProviderName, credentials: ProviderCredentials, id: string, etag?: string
): Promise<ProviderCredentials> {
  if (provider === 'icloud') {
    const response = await appleRequest(credentials, id, 'DELETE', undefined, etag ? { 'if-match': etag } : {});
    if (!response.ok && response.status !== 404) throw new Error(`Apple CardDAV delete failed (${response.status}).`);
    return credentials;
  }
  credentials = await refreshAccessToken(provider, credentials);
  const url = provider === 'google'
    ? `https://people.googleapis.com/v1/${id.split('/').map(encodeURIComponent).join('/')}:deleteContact`
    : `https://graph.microsoft.com/v1.0/me/contacts/${encodeURIComponent(id)}`;
  const response = await bearerFetch(url, credentials.accessToken!, {
    method: 'DELETE', ...(etag && provider === 'microsoft' ? { headers: { 'if-match': etag } } : {})
  });
  if (!response.ok && response.status !== 404) throw new Error(`Provider delete failed (${response.status}).`);
  return credentials;
}

export function normalizeProviderData(data: ContactData): ContactData {
  return canonical(data);
}
