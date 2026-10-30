// The least-privilege app login (tech-stack.md G5, task 44 Q3). The Azure
// db-migrate job runs the migrations as the server admin, then calls this to
// create or update the login named in DATABASE_URL: DML on the application
// tables and sequences, and ownership of the `pgboss` schema, so app start can
// run `boss.start()` and `createQueue()` (J5) without any DDL right on `public`.
import pg from "pg";

/** PostgreSQL role names this code accepts; anything else is refused, not quoted around. */
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export type AppLogin = { role: string; password: string };

type Queryable = Pick<pg.Pool, "query">;

/** The user and password of a connection string; the role name must be a plain identifier. */
export function appLoginFrom(connectionString: string): AppLogin {
  const url = new URL(connectionString);
  const role = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!ROLE_NAME.test(role)) throw new Error("DATABASE_URL must name the app login as a lower-case identifier");
  if (!password) throw new Error("DATABASE_URL must contain the app login's password");
  return { role, password };
}

/**
 * Creates the app login or resets its password, and grants its rights.
 * Idempotent: every statement is safe to repeat. Runs as the admin login that
 * owns the schema, so the default privileges cover tables later migrations add.
 */
export async function provisionAppRole(admin: Queryable, login: AppLogin): Promise<void> {
  const role = pg.escapeIdentifier(login.role);
  const password = pg.escapeLiteral(login.password);
  const { rows } = await admin.query<{ exists: boolean; database: string }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists, current_database() AS database",
    [login.role],
  );
  const database = pg.escapeIdentifier(rows[0].database);

  // DDL can't take bind parameters; the name and password are escaped above.
  await admin.query(
    rows[0].exists
      ? `ALTER ROLE ${role} WITH LOGIN NOINHERIT PASSWORD ${password}`
      : `CREATE ROLE ${role} WITH LOGIN NOINHERIT PASSWORD ${password}`,
  );
  await admin.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await admin.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
  );
  await admin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);
  // Since PostgreSQL 16 a schema can only be given to a role the creator can
  // SET ROLE to. The Azure admin isn't a superuser, so it takes membership in
  // the role it created (it holds ADMIN OPTION on it).
  await admin.query(`GRANT ${role} TO CURRENT_USER`);
  await admin.query(`CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION ${role}`);
}

/** Runs `fn` while the app login may create schemas in this database, and revokes that right afterwards. */
export async function withDatabaseCreate(admin: Queryable, login: AppLogin, fn: () => Promise<void>): Promise<void> {
  const role = pg.escapeIdentifier(login.role);
  const { rows } = await admin.query<{ database: string }>("SELECT current_database() AS database");
  const database = pg.escapeIdentifier(rows[0].database);
  await admin.query(`GRANT CREATE ON DATABASE ${database} TO ${role}`);
  try {
    await fn();
  } finally {
    await admin.query(`REVOKE CREATE ON DATABASE ${database} FROM ${role}`);
  }
}
