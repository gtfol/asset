import { z } from 'zod';
import type { SQL } from './db.js';

export const accessMessage = 'Cloud access is limited to the owner of this Asset instance.';
export const accessDenied = () =>
  Object.assign(Error(accessMessage), { status: 403, code: 'ACCESS_RESTRICTED' });

// Unset preserves self-hosted multi-user deployments. An explicitly empty list denies everyone.
export function allowedCloudEmails(): string[] | null {
  const configured = process.env.ASSET_ALLOWED_EMAILS;
  if (configured === undefined) return null;
  const emails = configured
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (emails.some((email) => !z.email().safeParse(email).success))
    throw Error('ASSET_ALLOWED_EMAILS must contain exact email addresses');
  return [...new Set(emails)];
}

export function assertCloudEmail(email: string) {
  const allowed = allowedCloudEmails();
  if (allowed !== null && !allowed.includes(email.trim().toLowerCase())) throw accessDenied();
}

// owner and parameter are server-defined SQL fragments, never request data.
export function ownerAccessSQL(owner: string, parameter: number) {
  return `($${parameter}::text[] IS NULL OR EXISTS (
    SELECT 1 FROM users access_user WHERE access_user.id=${owner}
      AND access_user.demo=false AND access_user.google_subject IS NOT NULL
      AND lower(access_user.email)=ANY($${parameter}::text[])))`;
}

export async function ownerCanAccess(db: SQL, owner: string) {
  const emails = allowedCloudEmails();
  if (emails === null) return true;
  return !!(
    await db.query(`SELECT id FROM users WHERE id=$1 AND ${ownerAccessSQL('users.id', 2)}`, [
      owner,
      emails,
    ])
  ).rows[0];
}

export async function assertOwnerAccess(db: SQL, owner: string) {
  if (!(await ownerCanAccess(db, owner))) throw accessDenied();
}

export function hostedDemoDisabled() {
  return (
    process.env.VERCEL === '1' ||
    process.env.NODE_ENV === 'production' ||
    allowedCloudEmails() !== null
  );
}
