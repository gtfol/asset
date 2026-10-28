import type { CSSProperties } from 'react';
import type { Account } from '../shared/core';
import { accountIdentity, type InstitutionConnection } from '../shared/account-presentation';

export function AccountCard({ account, connections = [] }: { account: Account; connections?: InstitutionConnection[] }) {
  const identity = accountIdentity(account, connections);
  return <span className="bank-card" style={{ '--bank-color': identity.color } as CSSProperties}>
    <span className="bank-card-institution"><span className="bank-monogram" aria-hidden="true">{identity.mark}</span>{identity.name}</span>
    <span className="bank-card-bottom"><span>{account.name}</span>{account.mask && <span>•• {account.mask}</span>}</span>
  </span>;
}
