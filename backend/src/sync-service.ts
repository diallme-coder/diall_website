import { pool } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import {
  deleteRemote, fetchDelta, normalizeProviderData, writeRemote,
  type ContactData, type ProviderCredentials, type ProviderName, type RemoteContact
} from './providers.js';
import { planSync, type SyncConflict, type SyncOperation } from './sync-plan.js';

type Preview = {
  operations: SyncOperation[];
  conflicts: SyncConflict[];
  baseCursor: string | null;
  cursor: string | null;
};

function assertProvider(value: string): asserts value is ProviderName {
  if (!['google', 'microsoft', 'icloud'].includes(value)) throw new Error('Unsupported contact provider.');
}

export async function makeSyncPreview(accountId: string, connectionId: string): Promise<{ runId: string; preview: Preview }> {
  const connectionResult = await pool.query(
    `SELECT id, provider, encrypted_credentials, sync_cursor, sync_lock_run_id, sync_locked_at
       FROM provider_connections WHERE id=$1 AND account_id=$2`,
    [connectionId, accountId]
  );
  if (!connectionResult.rowCount) throw Object.assign(new Error('Connection not found.'), { status: 404 });
  const connection = connectionResult.rows[0];
  if (connection.sync_lock_run_id && connection.sync_locked_at
    && Date.now() - new Date(connection.sync_locked_at).getTime() < 120_000) {
    throw Object.assign(new Error('A sync is already being applied for this connection.'), { status: 409 });
  }
  assertProvider(connection.provider);
  const credentials = decrypt<ProviderCredentials>(connection.encrypted_credentials);
  const { delta, credentials: renewedCredentials } = await fetchDelta(connection.provider, credentials, connection.sync_cursor);

  const linksResult = await pool.query(
    `SELECT l.contact_id, l.external_id, l.base_data, l.etag, l.remote_document, c.data, c.updated_at, c.deleted_at
       FROM provider_links l JOIN contacts c ON c.id=l.contact_id
      WHERE l.connection_id=$1 AND c.account_id=$2`,
    [connectionId, accountId]
  );
  const links = linksResult.rows.map((row) => ({
    contactId: row.contact_id as string, externalId: row.external_id as string,
    baseData: row.base_data as ContactData,
    etag: row.etag as string | undefined,
    document: row.remote_document as string | undefined
  }));
  const localRows = await pool.query(
    'SELECT id, data, updated_at, deleted_at FROM contacts WHERE account_id=$1',
    [accountId]
  );
  const locals = localRows.rows.map((row) => ({
    id: row.id as string, data: row.data as ContactData,
    updatedAt: new Date(row.updated_at).toISOString(), deleted: Boolean(row.deleted_at)
  }));
  const remoteById = new Map<string, RemoteContact>();
  if (!delta.fullSync) {
    for (const link of links) remoteById.set(link.externalId, {
      id: link.externalId, data: link.baseData, etag: link.etag, document: link.document
    });
  }
  for (const id of delta.deleted) remoteById.delete(id);
  for (const item of delta.changed) remoteById.set(item.id, item);

  const plan = planSync(locals, links, [...remoteById.values()]);
  const preview: Preview = { ...plan, baseCursor: connection.sync_cursor, cursor: delta.cursor };
  await pool.query('DELETE FROM sync_runs WHERE account_id=$1 AND expires_at<now()', [accountId]);
  const credentialsSaved = await pool.query(
    `UPDATE provider_connections
        SET encrypted_credentials=$1,sync_lock_run_id=NULL,sync_locked_at=NULL,updated_at=now()
      WHERE id=$2 AND account_id=$3 AND sync_cursor IS NOT DISTINCT FROM $4
        AND (sync_lock_run_id IS NULL OR sync_locked_at<now()-interval '2 minutes')
        AND encrypted_credentials=$5
      RETURNING id`,
    [encrypt(renewedCredentials), connectionId, accountId, connection.sync_cursor, connection.encrypted_credentials]
  );
  if (!credentialsSaved.rowCount) {
    throw Object.assign(new Error('Connection changed during preview; create a new sync preview.'), { status: 409 });
  }
  const saved = await pool.query(
    `INSERT INTO sync_runs(account_id, connection_id, preview, expires_at)
     VALUES ($1,$2,$3,now()+interval '30 minutes') RETURNING id`,
    [accountId, connectionId, preview]
  );
  return { runId: saved.rows[0].id, preview };
}

type Choice = { conflictId: string; choice: 'local' | 'remote' };

export async function applySync(
  accountId: string, connectionId: string, runId: string, choices: Choice[]
): Promise<{ applied: true; imported: number; exported: number; deleted: number }> {
  const savedPreview = await pool.query(
    `SELECT preview FROM sync_runs
      WHERE id=$1 AND account_id=$2 AND connection_id=$3 AND expires_at>now()`,
    [runId, accountId, connectionId]
  );
  if (!savedPreview.rowCount) throw Object.assign(new Error('Preview not found or expired.'), { status: 404 });
  const preview = savedPreview.rows[0].preview as Preview;
  const choiceById = new Map(choices.map((item) => [item.conflictId, item.choice]));
  if (choices.length !== preview.conflicts.length || preview.conflicts.some((conflict) =>
    !['local', 'remote'].includes(choiceById.get(conflict.id) ?? ''))) {
    throw Object.assign(new Error('Choose a local or provider version for every conflict.'), { status: 400 });
  }
  const expectedConflictIds = new Set(preview.conflicts.map((item) => item.id));
  if (choices.some((item) => !expectedConflictIds.has(item.conflictId))) {
    throw Object.assign(new Error('Conflict choice does not belong to this preview.'), { status: 400 });
  }

  const claimClient = await pool.connect();
  let connection: { provider: ProviderName; encrypted_credentials: Buffer };
  try {
    await claimClient.query('BEGIN');
    const connectionResult = await claimClient.query(
      `SELECT provider,encrypted_credentials,sync_cursor,sync_lock_run_id,sync_locked_at
         FROM provider_connections WHERE id=$1 AND account_id=$2 FOR UPDATE`,
      [connectionId, accountId]
    );
    if (!connectionResult.rowCount) throw Object.assign(new Error('Connection not found.'), { status: 404 });
    const row = connectionResult.rows[0];
    assertProvider(row.provider);
    if (row.sync_cursor !== preview.baseCursor) {
      throw Object.assign(new Error('Preview is stale; create a new sync preview.'), { status: 409 });
    }
    if (row.sync_lock_run_id && row.sync_locked_at
      && Date.now() - new Date(row.sync_locked_at).getTime() < 120_000) {
      throw Object.assign(new Error('A sync is already being applied for this connection.'), { status: 409 });
    }
    const runClaim = await claimClient.query(
      `UPDATE sync_runs SET status='applying',updated_at=now()
        WHERE id=$1 AND account_id=$2 AND connection_id=$3 AND expires_at>now() AND applied_at IS NULL
          AND (status='pending' OR (status='applying' AND updated_at<now()-interval '2 minutes'))`,
      [runId, accountId, connectionId]
    );
    if (!runClaim.rowCount) {
      const current = await claimClient.query(
        'SELECT status,applied_at FROM sync_runs WHERE id=$1 AND account_id=$2 AND connection_id=$3 AND expires_at>now()',
        [runId, accountId, connectionId]
      );
      if (!current.rowCount) throw Object.assign(new Error('Preview not found or expired.'), { status: 404 });
      const message = current.rows[0].applied_at ? 'This preview has already been applied.' : 'This preview is already being applied.';
      throw Object.assign(new Error(message), { status: 409 });
    }
    await claimClient.query(
      'UPDATE provider_connections SET sync_lock_run_id=$1,sync_locked_at=now() WHERE id=$2 AND account_id=$3',
      [runId, connectionId, accountId]
    );
    await claimClient.query('COMMIT');
    connection = { provider: row.provider as ProviderName, encrypted_credentials: row.encrypted_credentials };
  } catch (error) {
    await claimClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    claimClient.release();
  }
  const credentialBuffer = connection.encrypted_credentials;
  let credentials = decrypt<ProviderCredentials>(credentialBuffer);

  const provider = connection.provider;
  const counters = { imported: 0, exported: 0, deleted: 0 };

  async function loadContact(id: string) {
    const row = await pool.query(
      'SELECT id, data, updated_at, deleted_at FROM contacts WHERE id=$1 AND account_id=$2',
      [id, accountId]
    );
    if (!row.rowCount) return null;
    return {
      id: row.rows[0].id as string,
      data: row.rows[0].data as ContactData,
      updatedAt: new Date(row.rows[0].updated_at).toISOString(),
      deleted: Boolean(row.rows[0].deleted_at)
    };
  }
  async function persistCredentials() {
    const persisted = await pool.query(
      'UPDATE provider_connections SET encrypted_credentials=$1,sync_locked_at=now(),updated_at=now() WHERE id=$2 AND account_id=$3 AND sync_lock_run_id=$4',
      [encrypt(credentials), connectionId, accountId, runId]
    );
    if (!persisted.rowCount) throw Object.assign(new Error('Sync lock expired; create a new sync preview.'), { status: 409 });
  }
  async function renewLock() {
    const updated = await pool.query(
      'UPDATE provider_connections SET sync_locked_at=now() WHERE id=$1 AND account_id=$2 AND sync_lock_run_id=$3',
      [connectionId, accountId, runId]
    );
    if (!updated.rowCount) throw Object.assign(new Error('Sync lock expired; create a new sync preview.'), { status: 409 });
  }
  async function checkUnchanged(id: string, expected?: string) {
    if (!expected) return;
    const current = await loadContact(id);
    if (!current || current.updatedAt !== expected) {
      throw Object.assign(new Error('A contact changed after preview; create a new sync preview.'), { status: 409 });
    }
  }
  async function saveLink(contactId: string, externalId: string, data: ContactData, etag?: string, document?: string) {
    await pool.query(
      `INSERT INTO provider_links(connection_id, contact_id, external_id, base_data, etag, remote_document)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT(connection_id, contact_id) DO UPDATE
       SET external_id=EXCLUDED.external_id, base_data=EXCLUDED.base_data, etag=EXCLUDED.etag,
           remote_document=COALESCE(EXCLUDED.remote_document, provider_links.remote_document)`,
      [connectionId, contactId, externalId, normalizeProviderData(data), etag ?? null, document == null ? null : JSON.stringify(document)]
    );
  }
  async function importContact(
    externalId: string, data: ContactData, etag?: string, preferredId?: string, updatedAt?: string, document?: string
  ) {
    const linked = await pool.query(
      'SELECT contact_id FROM provider_links WHERE connection_id=$1 AND external_id=$2',
      [connectionId, externalId]
    );
    const existingId = preferredId || linked.rows[0]?.contact_id;
    let contactId: string;
    if (existingId) {
      const current = await loadContact(existingId);
      if (!current) throw Object.assign(new Error('Linked contact no longer exists.'), { status: 409 });
      const alreadyApplied = updatedAt !== undefined && current.updatedAt !== updatedAt
        && !current.deleted
        && JSON.stringify(normalizeProviderData(current.data)) === JSON.stringify(normalizeProviderData(data));
      if (updatedAt !== undefined && current.updatedAt !== updatedAt && !alreadyApplied) {
        throw Object.assign(new Error('A contact changed after preview; create a new sync preview.'), { status: 409 });
      }
      if (!alreadyApplied) {
        await pool.query(
          `UPDATE contacts SET data=(data-ARRAY['firstName','lastName','displayName','email','phone','company','notes']::text[])
                || $1::jsonb,deleted_at=NULL,updated_at=now()
            WHERE id=$2 AND account_id=$3`,
          [normalizeProviderData(data), existingId, accountId]
        );
      }
      contactId = existingId;
    } else {
      const inserted = await pool.query(
        `WITH new_contact AS (
           INSERT INTO contacts(account_id,data) VALUES ($1,$2) RETURNING id
         )
         INSERT INTO provider_links(connection_id,contact_id,external_id,base_data,etag,remote_document)
         SELECT $3,id,$4,$2,$5,$6 FROM new_contact RETURNING contact_id`,
        [
          accountId, normalizeProviderData(data), connectionId, externalId, etag ?? null,
          document == null ? null : JSON.stringify(document)
        ]
      );
      contactId = inserted.rows[0].contact_id;
    }
    if (existingId) await saveLink(contactId, externalId, data, etag, document);
    counters.imported++;
  }
  async function exportContact(
    contactId: string, data: ContactData, externalId?: string, etag?: string, updatedAt?: string
  ) {
    await checkUnchanged(contactId, updatedAt);
    const current = await loadContact(contactId);
    if (!current || current.deleted) {
      throw Object.assign(new Error('Contact was deleted after preview; create a new sync preview.'), { status: 409 });
    }
    const existingLink = await pool.query(
      'SELECT external_id, etag, remote_document FROM provider_links WHERE connection_id=$1 AND contact_id=$2',
      [connectionId, contactId]
    );
    const targetId = externalId ?? existingLink.rows[0]?.external_id ?? null;
    const targetEtag = etag ?? existingLink.rows[0]?.etag;
    const document = existingLink.rows[0]?.remote_document as string | undefined;
    const written = await writeRemote(provider, credentials, targetId, normalizeProviderData(current.data), targetEtag, document);
    credentials = written.credentials;
    await persistCredentials();
    await saveLink(contactId, written.id, current.data, written.etag, written.document);
    counters.exported++;
  }
  async function removeLink(contactId: string) {
    await pool.query('DELETE FROM provider_links WHERE connection_id=$1 AND contact_id=$2', [connectionId, contactId]);
  }
  async function deleteProviderContact(externalId: string, etag?: string) {
    credentials = await deleteRemote(provider, credentials, externalId, etag);
    await persistCredentials();
  }

  try {
    for (const operation of preview.operations) {
      await renewLock();
      switch (operation.kind) {
        case 'import':
          await importContact(
            operation.externalId!, operation.data!, operation.etag, operation.contactId || undefined,
            operation.updatedAt, operation.document
          );
          break;
        case 'export':
          await exportContact(operation.contactId, operation.data!, operation.externalId, operation.etag, operation.updatedAt);
          break;
        case 'baseline':
          await saveLink(operation.contactId, operation.externalId!, operation.data!, operation.etag, operation.document);
          break;
        case 'deleteLocal':
          {
            const local = await loadContact(operation.contactId);
            if (!local?.deleted) {
              await checkUnchanged(operation.contactId, operation.updatedAt);
              await pool.query(
                'UPDATE contacts SET deleted_at=now(), updated_at=now() WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL',
                [operation.contactId, accountId]
              );
            }
          }
          await removeLink(operation.contactId);
          counters.deleted++;
          break;
        case 'deleteRemote':
          await checkUnchanged(operation.contactId, operation.updatedAt);
          await deleteProviderContact(operation.externalId!, operation.etag);
          await removeLink(operation.contactId);
          counters.deleted++;
          break;
        case 'detach':
          await removeLink(operation.contactId);
          break;
      }
    }

    for (const conflict of preview.conflicts) {
      await renewLock();
      const choice = choiceById.get(conflict.id)!;
      if (conflict.kind === 'bothChanged') {
        if (choice === 'remote') {
          await importContact(
            conflict.externalId, conflict.remote!, conflict.etag, conflict.contactId, conflict.updatedAt,
            conflict.remoteDocument
          );
        } else {
          await exportContact(conflict.contactId, conflict.local, conflict.externalId, conflict.etag, conflict.updatedAt);
        }
      } else if (conflict.kind === 'remoteDeleted') {
        if (choice === 'remote') {
          await pool.query(
            'UPDATE contacts SET deleted_at=now(), updated_at=now() WHERE id=$1 AND account_id=$2',
            [conflict.contactId, accountId]
          );
          await removeLink(conflict.contactId);
          counters.deleted++;
        } else {
          await removeLink(conflict.contactId);
          await exportContact(conflict.contactId, conflict.local, undefined, undefined, conflict.updatedAt);
        }
      } else if (choice === 'local') {
        await deleteProviderContact(conflict.externalId, conflict.etag);
        await removeLink(conflict.contactId);
        await pool.query(
          'UPDATE contacts SET deleted_at=now(), updated_at=now() WHERE id=$1 AND account_id=$2',
          [conflict.contactId, accountId]
        );
        counters.deleted++;
      } else {
        await importContact(
          conflict.externalId, conflict.remote!, conflict.etag, conflict.contactId, conflict.updatedAt,
          conflict.remoteDocument
        );
      }
    }

    const released = await pool.query(
      `UPDATE provider_connections SET encrypted_credentials=$1,sync_cursor=$2,cursor_valid=$3,
              sync_lock_run_id=NULL,sync_locked_at=NULL,updated_at=now()
        WHERE id=$4 AND account_id=$5 AND sync_lock_run_id=$6`,
      [encrypt(credentials), preview.cursor, Boolean(preview.cursor), connectionId, accountId, runId]
    );
    if (!released.rowCount) throw Object.assign(new Error('Sync lock expired; create a new sync preview.'), { status: 409 });
    const completed = await pool.query(
      `UPDATE sync_runs SET status='applied', applied_at=now(), updated_at=now()
        WHERE id=$1 AND account_id=$2 AND status='applying'`,
      [runId, accountId]
    );
    if (!completed.rowCount) throw Object.assign(new Error('Sync preview expired during apply.'), { status: 409 });
  } catch (error) {
    await pool.query(
      'UPDATE provider_connections SET sync_lock_run_id=NULL,sync_locked_at=NULL WHERE id=$1 AND account_id=$2 AND sync_lock_run_id=$3',
      [connectionId, accountId, runId]
    ).catch(() => undefined);
    await pool.query(
      `UPDATE sync_runs SET status='pending',updated_at=now()
        WHERE id=$1 AND account_id=$2 AND status='applying' AND applied_at IS NULL`,
      [runId, accountId]
    ).catch(() => undefined);
    throw error;
  }
  return { applied: true, ...counters };
}
