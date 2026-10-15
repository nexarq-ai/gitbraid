export class SqlStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  get<T>(key: string): T | undefined {
    const row = this.sql.exec<{ value: string }>('SELECT value FROM records WHERE key = ?', key).toArray()[0];
    return row ? JSON.parse(row.value) : undefined;
  }

  put<T>(key: string, value: T): void {
    this.sql.exec('INSERT INTO records (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  putIfAbsent<T>(key: string, value: T): void {
    this.sql.exec('INSERT INTO records (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', key, JSON.stringify(value));
  }

  insert<T>(key: string, value: T): void {
    this.sql.exec('INSERT INTO records (key, value) VALUES (?, ?)', key, JSON.stringify(value));
  }

  delete(key: string): void {
    this.sql.exec('DELETE FROM records WHERE key = ?', key);
  }

  list<T>(prefix: string): T[] {
    return this.sql.exec<{ value: string }>('SELECT value FROM records WHERE key >= ? AND key < ? ORDER BY key', prefix, `${prefix}\uffff`).toArray().map((row) => JSON.parse(row.value));
  }

  entries<T>(prefix: string): [string, T][] {
    return this.sql.exec<{ key: string; value: string }>('SELECT key, value FROM records WHERE key >= ? AND key < ? ORDER BY key', prefix, `${prefix}\uffff`).toArray().map((row) => [row.key, JSON.parse(row.value)]);
  }
}
