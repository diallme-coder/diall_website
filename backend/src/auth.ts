import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { pool } from './db.js';
import { config } from './config.js';
import { constantTimeEqual, decrypt, encrypt, randomToken, sha256 } from './crypto.js';

declare global {
  namespace Express {
    interface Request {
      accountId?: string;
      csrfToken?: string;
      sessionToken?: string;
    }
  }
}

type OAuthProvider = 'google' | 'microsoft';
const cookieOptions = {
  httpOnly: true, secure: config.production, sameSite: 'lax' as const, path: '/'
};
const oauthEndpoints = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    jwks: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
    issuer: ['https://accounts.google.com', 'accounts.google.com']
  },
  microsoft: {
    authorize: `https://login.microsoftonline.com/${encodeURIComponent(config.microsoft.tenantId)}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${encodeURIComponent(config.microsoft.tenantId)}/oauth2/v2.0/token`,
    jwks: createRemoteJWKSet(new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys'))
  }
};

const clientSettings = (provider: OAuthProvider) => provider === 'google'
  ? config.google
  : config.microsoft;

const validProvider = (value: string): value is OAuthProvider => value === 'google' || value === 'microsoft';

export async function requireSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.session;
    if (typeof token !== 'string' || token.length < 32) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const result = await pool.query(
      'SELECT account_id, csrf_token FROM sessions WHERE token_hash = $1 AND expires_at > now()',
      [sha256(token)]
    );
    if (!result.rowCount) {
      res.clearCookie('session', cookieOptions);
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    req.accountId = result.rows[0].account_id;
    req.csrfToken = result.rows[0].csrf_token;
    req.sessionToken = token;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const submitted = req.get('x-csrf-token') ?? '';
  if (!req.csrfToken || !constantTimeEqual(submitted, req.csrfToken)) {
    res.status(403).json({ error: 'CSRF token missing or invalid.' });
    return;
  }
  next();
}

export async function createSession(accountId: string, res: Response, previousToken?: unknown): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  if (typeof previousToken === 'string') {
    await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(previousToken)]);
  }
  const token = randomToken();
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO sessions(token_hash, account_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4)',
    [sha256(token), accountId, csrfToken, expiresAt]
  );
  res.cookie('session', token, { ...cookieOptions, expires: expiresAt });
}

export async function startOAuth(req: Request, res: Response): Promise<void> {
  await pool.query('DELETE FROM oauth_states WHERE expires_at < now()');
  const providerName = String(req.params.provider);
  if (!validProvider(providerName)) {
    res.status(404).json({ error: 'Unsupported sign-in provider.' });
    return;
  }
  const mode = req.query.mode === 'connect' ? 'connect' : 'login';
  if (mode === 'connect' && !req.accountId) {
    res.status(401).json({ error: 'Authentication required to connect an account.' });
    return;
  }
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  await pool.query(
    'INSERT INTO oauth_states(state_hash, provider, mode, account_id, nonce, encrypted_verifier, expires_at) VALUES ($1,$2,$3,$4,$5,$6,now()+interval \'10 minutes\')',
    [sha256(state), providerName, mode, mode === 'connect' ? req.accountId : null, nonce, encrypt({ verifier })]
  );
  res.cookie('oauth_state', state, { ...cookieOptions, maxAge: 10 * 60 * 1000 });
  const settings = clientSettings(providerName);
  const scopes = providerName === 'google'
    ? (mode === 'connect' ? 'openid email profile https://www.googleapis.com/auth/contacts' : 'openid email profile')
    : (mode === 'connect' ? 'openid profile email offline_access User.Read Contacts.ReadWrite' : 'openid profile email User.Read');
  const authorize = new URL(oauthEndpoints[providerName].authorize);
  authorize.search = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: settings.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: scopes,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(providerName === 'google' && mode === 'connect' ? { access_type: 'offline', prompt: 'consent' } : {})
  }).toString();
  res.redirect(302, authorize.toString());
}

async function getAccount(provider: OAuthProvider, subject: string, email: string | null): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT account_id FROM identities WHERE provider = $1 AND subject = $2 FOR UPDATE',
      [provider, subject]
    );
    if (existing.rowCount) {
      await client.query('COMMIT');
      return existing.rows[0].account_id;
    }
    let account: { id: string } | undefined;
    if (email) {
      const byEmail = await client.query('SELECT id FROM accounts WHERE lower(email) = lower($1) FOR UPDATE', [email]);
      account = byEmail.rows[0];
    }
    if (!account) {
      const inserted = await client.query('INSERT INTO accounts(email) VALUES ($1) RETURNING id', [email]);
      account = inserted.rows[0];
    }
    if (!account?.id) throw new Error('Could not create account for verified identity.');
    const linked = await client.query(
      'INSERT INTO identities(provider, subject, account_id) VALUES ($1,$2,$3) ON CONFLICT (provider, subject) DO NOTHING RETURNING account_id',
      [provider, subject, account.id]
    );
    if (!linked.rowCount) {
      await client.query('ROLLBACK');
      const winner = await pool.query('SELECT account_id FROM identities WHERE provider=$1 AND subject=$2', [provider, subject]);
      if (!winner.rowCount) throw new Error('Identity registration race; retry sign-in.');
      return winner.rows[0].account_id;
    }
    await client.query('COMMIT');
    return account.id;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((error as { code?: string }).code === '23505' && email) {
      const existing = await pool.query('SELECT id FROM accounts WHERE lower(email)=lower($1)', [email]);
      if (existing.rowCount) return getAccount(provider, subject, email);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function finishOAuth(req: Request, res: Response): Promise<void> {
  const providerName = String(req.params.provider);
  if (!validProvider(providerName)) {
    res.status(404).send('Unsupported provider.');
    return;
  }
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const cookieState = req.cookies?.oauth_state;
  res.clearCookie('oauth_state', cookieOptions);
  if (!state || typeof cookieState !== 'string' || !constantTimeEqual(state, cookieState)) {
    res.status(400).send('Sign-in state validation failed.');
    return;
  }
  const stateResult = await pool.query(
    'DELETE FROM oauth_states WHERE state_hash=$1 AND provider=$2 AND expires_at>now() RETURNING mode, account_id, nonce, encrypted_verifier',
    [sha256(state), providerName]
  );
  if (!stateResult.rowCount || typeof req.query.code !== 'string') {
    res.status(400).send('Sign-in request expired or invalid.');
    return;
  }
  const flow = stateResult.rows[0];
  const { verifier } = decrypt<{ verifier: string }>(flow.encrypted_verifier);
  if (flow.mode === 'connect' && !flow.account_id) {
    res.status(400).send('Invalid provider connection request.');
    return;
  }
  const settings = clientSettings(providerName);
  const tokenForm = new URLSearchParams({
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
    redirect_uri: settings.redirectUri,
    grant_type: 'authorization_code',
    code: req.query.code,
    code_verifier: verifier
  });
  const tokenResponse = await fetch(oauthEndpoints[providerName].token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenForm,
    signal: AbortSignal.timeout(20_000)
  });
  if (!tokenResponse.ok) throw new Error('Identity provider rejected the authorization code.');
  const tokens = await tokenResponse.json() as {
    access_token: string; refresh_token?: string; expires_in?: number; id_token?: string; scope?: string
  };
  if (!tokens.id_token || !tokens.access_token) throw new Error('Identity provider omitted required tokens.');
  if (flow.mode === 'connect') {
    const requiredScope = providerName === 'google' ? 'https://www.googleapis.com/auth/contacts' : 'Contacts.ReadWrite';
    if (!tokens.scope?.split(/\s+/).includes(requiredScope) || !tokens.refresh_token) {
      throw new Error('Provider did not grant contact access and offline sync permission.');
    }
  }
  const { payload } = await jwtVerify(tokens.id_token, oauthEndpoints[providerName].jwks, {
    audience: settings.clientId,
    ...(providerName === 'google' ? { issuer: oauthEndpoints.google.issuer } : {})
  });
  if (!constantTimeEqual(String(payload.nonce ?? ''), flow.nonce) || typeof payload.sub !== 'string') {
    throw new Error('Identity token nonce or subject validation failed.');
  }

  let subject = payload.sub;
  let verifiedEmail: string | null = null;
  if (providerName === 'google') {
    if (payload.email_verified !== true || typeof payload.email !== 'string') {
      throw new Error('Google must provide a verified email address.');
    }
    verifiedEmail = payload.email.toLowerCase();
  } else {
    const tenantId = String(payload.tid ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(tenantId)
      || payload.iss !== `https://login.microsoftonline.com/${tenantId}/v2.0`
      || payload.ver !== '2.0') {
      throw new Error('Microsoft identity issuer validation failed.');
    }
    const meResponse = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(20_000)
    });
    if (!meResponse.ok) throw new Error('Could not validate Microsoft account identity.');
    const profile = await meResponse.json() as { id?: string };
    if (!profile.id || (payload.oid && payload.oid !== profile.id)) throw new Error('Microsoft account identity mismatch.');
    subject = `${tenantId}:${profile.id}`;
  }

  if (flow.mode === 'connect') {
    const credentials = encrypt({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + Number(tokens.expires_in ?? 3600) * 1000
    });
    await pool.query(
      `INSERT INTO provider_connections(account_id, provider, label, encrypted_credentials)
       VALUES ($1,$2,$3,$4)`,
      [flow.account_id, providerName, providerName === 'google' ? 'Google Contacts' : 'Microsoft Contacts', credentials]
    );
    res.redirect(303, `${config.origin}/?provider_connected=${providerName}`);
    return;
  }

  const accountId = await getAccount(providerName, subject, verifiedEmail);
  await createSession(accountId, res, req.cookies?.session);
  res.redirect(303, `${config.origin}/?signed_in=1`);
}

export async function logout(req: Request, res: Response): Promise<void> {
  if (req.sessionToken) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(req.sessionToken)]);
  res.clearCookie('session', cookieOptions);
  res.status(204).end();
}
