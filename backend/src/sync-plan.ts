import type { ContactData } from './providers.js';

export type LocalContact = { id: string; data: ContactData; updatedAt?: string; deleted: boolean };
export type LinkedContact = { contactId: string; externalId: string; baseData: ContactData; etag?: string; document?: string };
export type RemoteState = { id: string; data: ContactData; etag?: string; document?: string };
export type SyncOperation = {
  kind: 'import' | 'export' | 'baseline' | 'deleteLocal' | 'deleteRemote' | 'detach';
  contactId: string;
  externalId?: string;
  data?: ContactData;
  document?: string;
  etag?: string;
  updatedAt?: string;
};
export type SyncConflict = {
  id: string;
  kind: 'bothChanged' | 'remoteDeleted' | 'localDeleted';
  contactId: string;
  externalId: string;
  local: ContactData;
  remote?: ContactData;
  remoteDocument?: string;
  etag?: string;
  updatedAt?: string;
};

const managed = (data: ContactData): ContactData => Object.fromEntries(
  ['firstName', 'lastName', 'displayName', 'email', 'phone', 'company', 'notes']
    .filter((key) => typeof data[key] === 'string' && data[key])
    .map((key) => [key, data[key]])
);
const equal = (left: ContactData, right: ContactData): boolean =>
  JSON.stringify(managed(left)) === JSON.stringify(managed(right));

export function planSync(
  locals: LocalContact[], links: LinkedContact[], remote: RemoteState[]
): { operations: SyncOperation[]; conflicts: SyncConflict[] } {
  const localById = new Map(locals.map((contact) => [contact.id, contact]));
  const linkByLocal = new Map(links.map((link) => [link.contactId, link]));
  const linkByExternal = new Map(links.map((link) => [link.externalId, link]));
  const remoteById = new Map(remote.map((contact) => [contact.id, contact]));
  const operations: SyncOperation[] = [];
  const conflicts: SyncConflict[] = [];

  for (const link of links) {
    const local = localById.get(link.contactId);
    const providerContact = remoteById.get(link.externalId);
    if (!local) {
      operations.push({ kind: 'detach', contactId: link.contactId, externalId: link.externalId });
      continue;
    }
    if (!providerContact) {
      if (local.deleted) {
        operations.push({ kind: 'detach', contactId: local.id, externalId: link.externalId });
      } else if (!equal(local.data, link.baseData)) {
        conflicts.push({
          id: local.id, kind: 'remoteDeleted', contactId: local.id, externalId: link.externalId,
          local: local.data, etag: link.etag, updatedAt: local.updatedAt
        });
      } else {
        operations.push({ kind: 'deleteLocal', contactId: local.id, externalId: link.externalId, updatedAt: local.updatedAt });
      }
      continue;
    }
    if (local.deleted) {
      if (!equal(providerContact.data, link.baseData)) {
        conflicts.push({
          id: local.id, kind: 'localDeleted', contactId: local.id, externalId: link.externalId,
          local: local.data, remote: providerContact.data, etag: providerContact.etag,
          updatedAt: local.updatedAt, remoteDocument: providerContact.document
        });
      } else {
        operations.push({
          kind: 'deleteRemote', contactId: local.id, externalId: link.externalId,
          etag: providerContact.etag, updatedAt: local.updatedAt
        });
      }
      continue;
    }

    const localChanged = !equal(local.data, link.baseData);
    const remoteChanged = !equal(providerContact.data, link.baseData);
    if (localChanged && remoteChanged) {
      if (equal(local.data, providerContact.data)) {
        operations.push({
          kind: 'baseline', contactId: local.id, externalId: link.externalId,
          data: providerContact.data, etag: providerContact.etag, document: providerContact.document
        });
      } else {
        conflicts.push({
          id: local.id, kind: 'bothChanged', contactId: local.id, externalId: link.externalId,
          local: local.data, remote: providerContact.data, etag: providerContact.etag,
          updatedAt: local.updatedAt, remoteDocument: providerContact.document
        });
      }
    } else if (remoteChanged && !localChanged) {
      operations.push({
        kind: 'import', contactId: local.id, externalId: link.externalId,
        data: providerContact.data, etag: providerContact.etag, document: providerContact.document, updatedAt: local.updatedAt
      });
    } else if (localChanged && !remoteChanged) {
      operations.push({
        kind: 'export', contactId: local.id, externalId: link.externalId,
        data: local.data, etag: providerContact.etag ?? link.etag, updatedAt: local.updatedAt
      });
    }
  }

  for (const providerContact of remote) {
    if (!linkByExternal.has(providerContact.id)) {
      operations.push({
        kind: 'import', contactId: '', externalId: providerContact.id,
        data: providerContact.data, etag: providerContact.etag, document: providerContact.document
      });
    }
  }
  for (const local of locals) {
    if (!local.deleted && !linkByLocal.has(local.id)) {
      operations.push({ kind: 'export', contactId: local.id, data: local.data, updatedAt: local.updatedAt });
    }
  }
  return { operations, conflicts };
}
