import 'dotenv/config';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const production = process.env.NODE_ENV === 'production';
const origin = required('APP_ORIGIN').replace(/\/$/, '');
const parsedOrigin = new URL(origin);
if (parsedOrigin.origin !== origin || parsedOrigin.pathname !== '/'
  || parsedOrigin.username || parsedOrigin.password || (production && parsedOrigin.protocol !== 'https:')) {
  throw new Error('APP_ORIGIN must be an origin-only URL, using HTTPS in production.');
}

const encryptionKey = (): Buffer => {
  const key = Buffer.from(required('ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes encoded as base64');
  return key;
};

function callbackUri(name: 'GOOGLE_REDIRECT_URI' | 'MICROSOFT_REDIRECT_URI', path: string): string {
  const value = required(name);
  const uri = new URL(value);
  if (uri.pathname !== path || uri.search || uri.hash
    || uri.username || uri.password
    || (production && uri.protocol !== 'https:')
    || (!production && !['https:', 'http:'].includes(uri.protocol))) {
    throw new Error(`${name} must be an HTTPS ${path} URL in production.`);
  }
  return value;
}

export const config = {
  production,
  port: (() => {
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
    return port;
  })(),
  origin,
  databaseUrl: required('DATABASE_URL'),
  encryptionKey: encryptionKey(),
  google: {
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    redirectUri: callbackUri('GOOGLE_REDIRECT_URI', '/auth/google/callback')
  },
  microsoft: {
    clientId: required('MICROSOFT_CLIENT_ID'),
    clientSecret: required('MICROSOFT_CLIENT_SECRET'),
    tenantId: process.env.MICROSOFT_TENANT_ID ?? 'common',
    redirectUri: callbackUri('MICROSOFT_REDIRECT_URI', '/auth/microsoft/callback')
  }
};
