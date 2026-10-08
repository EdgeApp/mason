import type { DatabaseSync } from 'node:sqlite'

export function migrateAuth(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE identities (
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), provider TEXT NOT NULL,
      issuer TEXT NOT NULL, subject TEXT NOT NULL, email TEXT, email_verified INTEGER NOT NULL CHECK(email_verified IN (0,1)),
      UNIQUE(provider,issuer,subject)
    ) STRICT;
    CREATE TABLE sessions (
      hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), permission_version INTEGER NOT NULL,
      csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX session_accounts ON sessions(account_id);
    CREATE TABLE oauth_transactions (
      hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, provider TEXT NOT NULL, issuer TEXT NOT NULL,
      verifier TEXT NOT NULL, nonce TEXT NOT NULL, return_path TEXT NOT NULL, expires_at INTEGER NOT NULL,
      previous_session TEXT
    ) STRICT;
    CREATE TABLE invitations (
      id INTEGER PRIMARY KEY, provider TEXT NOT NULL, issuer TEXT NOT NULL, email TEXT NOT NULL,
      creator INTEGER NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)), claimed_account INTEGER REFERENCES accounts(id)
    ) STRICT;
    CREATE UNIQUE INDEX pending_invitation ON invitations(provider,issuer,email) WHERE revoked=0 AND claimed_account IS NULL;
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY, actor INTEGER REFERENCES accounts(id), action TEXT NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL
    ) STRICT;
    PRAGMA user_version=2;
    COMMIT;`)
}
