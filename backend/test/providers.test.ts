import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.APP_ORIGIN = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
process.env.GOOGLE_CLIENT_ID = 'google-client';
process.env.GOOGLE_CLIENT_SECRET = 'google-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/auth/google/callback';
process.env.MICROSOFT_CLIENT_ID = 'microsoft-client';
process.env.MICROSOFT_CLIENT_SECRET = 'microsoft-secret';
process.env.MICROSOFT_REDIRECT_URI = 'http://localhost:3000/auth/microsoft/callback';

const { fetchDelta, writeRemote } = await import('../src/providers.js');

test('maps Google People API contacts and returns the expiring sync token', async () => {
  const originalFetch = globalThis.fetch;
  let requested = '';
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested = String(input);
    return Response.json({
      connections: [{
        resourceName: 'people/c1', etag: 'etag1',
        names: [{ givenName: 'Ada', familyName: 'Lovelace', displayName: 'Ada Lovelace' }],
        emailAddresses: [{ value: 'ada@example.test' }], phoneNumbers: [{ value: '+1 555 0100' }],
        organizations: [{ name: 'Analytical Engines' }], biographies: [{ value: 'Notes' }]
      }],
      nextSyncToken: 'google-sync-token'
    });
  }) as typeof fetch;
  try {
    const result = await fetchDelta('google', { accessToken: 'access', expiresAt: Date.now() + 3_600_000 }, null);
    assert.match(requested, /requestSyncToken=true/);
    assert.equal(result.delta.cursor, 'google-sync-token');
    assert.deepEqual(result.delta.changed[0], {
      id: 'people/c1',
      etag: 'etag1',
      data: {
        firstName: 'Ada', lastName: 'Lovelace', displayName: 'Ada Lovelace',
        email: 'ada@example.test', phone: '+1 555 0100', company: 'Analytical Engines', notes: 'Notes'
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('restarts a Google full sync when its seven-day delta token expires', async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('syncToken=expired')) return Response.json({ error: 'expired' }, { status: 410 });
    return Response.json({ connections: [], nextSyncToken: 'replacement-token' });
  }) as typeof fetch;
  try {
    const result = await fetchDelta(
      'google', { accessToken: 'access', expiresAt: Date.now() + 3_600_000 }, 'expired'
    );
    assert.equal(requested.length, 2);
    assert.match(requested[1]!, /requestSyncToken=true/);
    assert.equal(result.delta.cursor, 'replacement-token');
    assert.equal(result.delta.fullSync, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('discovers and syncs the Microsoft Contacts folder through Graph delta', async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/contactFolders?')) {
      return Response.json({ value: [{ id: 'folder-id', displayName: 'Contacts' }] });
    }
    return Response.json({
      value: [{
        id: 'contact-id', changeKey: 'key-1', givenName: 'Katherine', surname: 'Johnson',
        emailAddresses: [{ address: 'kj@example.test' }], mobilePhone: '555-0111',
        '@odata.type': '#microsoft.graph.contact'
      }],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=next'
    });
  }) as typeof fetch;
  try {
    const result = await fetchDelta('microsoft', { accessToken: 'access', expiresAt: Date.now() + 3_600_000 }, null);
    assert.match(requested[1]!, /contactFolders\/folder-id\/contacts\/delta/);
    assert.equal(result.delta.cursor, 'https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=next');
    assert.equal(result.delta.changed[0]?.data.firstName, 'Katherine');
    assert.equal(result.delta.changed[0]?.data.email, 'kj@example.test');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('discovers Apple CardDAV and maps vCard fields without discarding the raw document', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(input)}`);
    const body = String(init?.body ?? '');
    if (body.includes('current-user-principal')) {
      return new Response('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/wrong-resource/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>', { status: 207 });
    }
    if (body.includes('addressbook-home-set')) {
      return new Response('<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:response><d:href>/wrong-principal-resource/</d:href><d:propstat><d:prop><c:addressbook-home-set><d:href>/home/</d:href></c:addressbook-home-set></d:prop></d:propstat></d:response></d:multistatus>', { status: 207 });
    }
    if (body.includes('resourcetype')) {
      return new Response('<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:response><d:href>/home/book/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:addressbook/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>', { status: 207 });
    }
    return new Response('<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:response><d:href>/home/book/c1.vcf</d:href><d:propstat><d:prop><d:getetag>"v1"</d:getetag><c:address-data>BEGIN:VCARD&#13;&#10;VERSION:3.0&#13;&#10;UID:c1&#13;&#10;FN:Grace Hopper&#13;&#10;N:Hopper;Grace;;;&#13;&#10;EMAIL:grace@example.test&#13;&#10;X-KEEP:preserved&#13;&#10;END:VCARD</c:address-data></d:prop></d:propstat></d:response><d:sync-token>token-1</d:sync-token></d:multistatus>', { status: 207 });
  }) as typeof fetch;
  try {
    const result = await fetchDelta('icloud', { username: 'apple@example.test', appPassword: 'app-password' }, null);
    assert.equal(calls.length, 4);
    assert.match(calls[1]!, /\/principal\/$/);
    assert.match(calls[2]!, /\/home\/$/);
    assert.equal(result.delta.cursor, 'token-1');
    assert.equal(result.delta.fullSync, true);
    assert.equal(result.delta.changed[0]?.data.firstName, 'Grace');
    assert.equal(result.delta.changed[0]?.data.email, 'grace@example.test');
    assert.match(result.delta.changed[0]?.document ?? '', /X-KEEP:preserved/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('preserves unmapped CardDAV fields and additional email addresses on update', async () => {
  const originalFetch = globalThis.fetch;
  let written = '';
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    written = String(init?.body ?? '');
    assert.equal(new Headers(init?.headers).get('if-match'), '"version-2"');
    return new Response(null, { status: 204, headers: { etag: '"version-3"' } });
  }) as typeof fetch;
  try {
    const previous = [
      'BEGIN:VCARD', 'VERSION:3.0', 'UID:c1', 'FN:Old Name', 'N:Name;Old;;;',
      'EMAIL:old@example.test', 'EMAIL:other@example.test', 'X-KEEP:keep-me', 'END:VCARD'
    ].join('\r\n');
    const result = await writeRemote(
      'icloud',
      { username: 'apple@example.test', appPassword: 'app-password', addressBookUrl: 'https://contacts.icloud.com/book/' },
      'https://contacts.icloud.com/book/c1.vcf',
      { firstName: 'New', lastName: 'Name', email: 'new@example.test' },
      '"version-2"',
      previous
    );
    assert.match(written, /EMAIL;TYPE=INTERNET:new@example\.test/);
    assert.match(written, /EMAIL:other@example\.test/);
    assert.match(written, /X-KEEP:keep-me/);
    assert.equal(result.etag, '"version-3"');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
