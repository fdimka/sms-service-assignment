import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from './domain.js';
import type { Employee, EmployeeContactInput, EmployeeIdentity, ListQuery, Message, MessageInput, MessageStatus } from './domain.js';

const columns = `id, to_number AS "to", body, status, provider_id AS providerId,
  error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt,
  employee_first_name AS employeeFirstName, employee_last_name AS employeeLastName,
  employee_address AS employeeAddress`;

type MessageRow = Omit<Message, 'employee'> & {
  employeeFirstName: string | null; employeeLastName: string | null; employeeAddress: string | null;
};

function messageFromRow(value: unknown): Message | undefined {
  if (!value) return undefined;
  const { employeeFirstName, employeeLastName, employeeAddress, ...message } = value as MessageRow;
  return { ...message, employee: employeeFirstName === null ? null : {
    firstName: employeeFirstName, lastName: employeeLastName!, address: employeeAddress!,
  } };
}

const employeeSelection = `SELECT e.first_name AS firstName, e.last_name AS lastName,
  e.address, json_group_array(p.phone_number) AS phones FROM employees e
  JOIN employee_phones p USING(first_name, last_name, address)`;
const employeeGrouping = 'GROUP BY e.first_name, e.last_name, e.address';

function employeeFromRow(value: unknown): Employee {
  const row = value as EmployeeIdentity & { phones: string };
  return { firstName: row.firstName, lastName: row.lastName, address: row.address,
    phones: (JSON.parse(row.phones) as string[]).sort() };
}

const transitions: Record<MessageStatus, readonly MessageStatus[]> = {
  queued: ['sending'], sending: ['accepted', 'failed', 'unknown'],
  accepted: ['delivered', 'failed', 'unknown'], delivered: [], failed: [], unknown: [],
};

export class MessageStore {
  private readonly db: DatabaseSync;
  private readonly statements;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 3000;
      PRAGMA foreign_keys = ON;
    `);
    try {
      this.initializeSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.statements = {
      insert: this.db.prepare(`INSERT INTO messages
        (id, to_number, body, status, idempotency_key, created_at, updated_at,
         employee_first_name, employee_last_name, employee_address)
        VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`),
      byId: this.db.prepare(`SELECT ${columns} FROM messages WHERE id = ?`),
      byKey: this.db.prepare(`SELECT ${columns} FROM messages WHERE idempotency_key = ?`),
      list: this.db.prepare(`SELECT ${columns} FROM messages ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`),
      filtered: this.db.prepare(`SELECT ${columns} FROM messages WHERE status = ?
        ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`),
      claim: this.db.prepare(`UPDATE messages SET status = 'sending', updated_at = ?
        WHERE id = (SELECT id FROM messages WHERE status = 'queued' ORDER BY created_at, id LIMIT 1)
        AND status = 'queued' RETURNING ${columns}`),
      transition: this.db.prepare(`UPDATE messages SET status = ?, provider_id = ?, error_code = ?, updated_at = ?
        WHERE id = ? AND status = ?`),
      recover: this.db.prepare(`UPDATE messages SET status = 'unknown', error_code = 'INTERRUPTED_SEND',
        updated_at = ? WHERE status = 'sending'`),
      accepted: this.db.prepare(`SELECT ${columns} FROM messages WHERE status = 'accepted'
        ORDER BY last_checked_at, created_at, id LIMIT ?`),
      checked: this.db.prepare(`UPDATE messages SET last_checked_at = ? WHERE id = ? AND status = 'accepted'`),
      insertEmployee: this.db.prepare(`INSERT INTO employees(first_name, last_name, address)
        VALUES(?, ?, ?) ON CONFLICT DO NOTHING`),
      insertPhone: this.db.prepare(`INSERT INTO employee_phones(first_name, last_name, address, phone_number)
        VALUES(?, ?, ?, ?) ON CONFLICT DO NOTHING`),
      employee: this.db.prepare(`${employeeSelection}
        WHERE e.first_name = ? AND e.last_name = ? AND e.address = ? ${employeeGrouping}`),
      employees: this.db.prepare(`${employeeSelection} ${employeeGrouping}
        ORDER BY e.last_name, e.first_name, e.address LIMIT ? OFFSET ?`),
      employeeCount: this.db.prepare('SELECT count(*) AS total FROM employees'),
      contact: this.db.prepare(`SELECT 1 AS found FROM employee_phones
        WHERE first_name = ? AND last_name = ? AND address = ? AND phone_number = ?`),
      health: this.db.prepare('SELECT 1 AS ok'),
    };
  }

  private initializeSchema(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        to_number TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','sending','accepted','delivered','failed','unknown')),
        provider_id TEXT,
        error_code TEXT,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_checked_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS messages_by_status ON messages(status, created_at, id);
      CREATE INDEX IF NOT EXISTS messages_by_created ON messages(created_at, id);
      CREATE INDEX IF NOT EXISTS messages_for_polling ON messages(status, last_checked_at, created_at, id);
      CREATE TABLE IF NOT EXISTS employees (
        first_name TEXT NOT NULL, last_name TEXT NOT NULL, address TEXT NOT NULL,
        PRIMARY KEY(first_name, last_name, address)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS employee_phones (
        first_name TEXT NOT NULL, last_name TEXT NOT NULL, address TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        PRIMARY KEY(first_name, last_name, address, phone_number),
        FOREIGN KEY(first_name, last_name, address) REFERENCES employees(first_name, last_name, address)
      ) STRICT;
      `);
      // Add nullable snapshots without rebuilding or dropping the original messages table.
      const names = new Set(this.db.prepare('PRAGMA table_info(messages)').all().map(row => row.name));
      for (const column of ['employee_first_name', 'employee_last_name', 'employee_address']) {
        if (!names.has(column)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${column} TEXT`);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  create(input: MessageInput, key: string | null): { message: Message; created: boolean } {
    const previous = key ? messageFromRow(this.statements.byKey.get(key)) : undefined;
    if (previous) {
      this.assertSamePayload(previous, input);
      return { message: previous, created: false };
    }
    if (input.employee && !this.statements.contact.get(
      input.employee.firstName, input.employee.lastName, input.employee.address, input.to,
    )) throw new HttpError(400, 'EMPLOYEE_CONTACT_NOT_FOUND', 'Register this phone for the selected employee before sending.');
    const id = randomUUID();
    const now = new Date().toISOString();
    const inserted = this.statements.insert.run(id, input.to, input.body, key, now, now,
      input.employee?.firstName ?? null, input.employee?.lastName ?? null, input.employee?.address ?? null);
    const message = messageFromRow(inserted.changes ? this.statements.byId.get(id) : this.statements.byKey.get(key))!;
    this.assertSamePayload(message, input);
    return { message, created: Number(inserted.changes) === 1 };
  }

  private assertSamePayload(message: Message, input: MessageInput): void {
    const current = message.employee;
    const requested = input.employee ?? null;
    const sameEmployee = current === null ? requested === null : requested !== null
      && current.firstName === requested.firstName && current.lastName === requested.lastName
      && current.address === requested.address;
    if (message.to !== input.to || message.body !== input.body
      || !sameEmployee) {
      throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used for a different payload.');
    }
  }

  get(id: string): Message | undefined {
    return messageFromRow(this.statements.byId.get(id));
  }

  list(query: ListQuery): Message[] {
    return (query.status
      ? this.statements.filtered.all(query.status, query.limit, query.offset)
      : this.statements.list.all(query.limit, query.offset)).map(row => messageFromRow(row)!);
  }

  claimNext(): Message | undefined {
    return messageFromRow(this.statements.claim.get(new Date().toISOString()));
  }

  transition(id: string, from: MessageStatus, to: MessageStatus, providerId: string | null, errorCode: string | null): void {
    if (!transitions[from].includes(to)) throw new Error(`Invalid message transition: ${from} -> ${to}`);
    const result = this.statements.transition.run(to, providerId, errorCode, new Date().toISOString(), id, from);
    if (Number(result.changes) !== 1) throw new Error(`Message ${id} is no longer ${from}`);
  }

  recoverInterrupted(): number {
    return Number(this.statements.recover.run(new Date().toISOString()).changes);
  }

  awaitingReceipts(limit: number): Message[] {
    return this.statements.accepted.all(limit).map(row => messageFromRow(row)!);
  }

  recordReceiptCheck(id: string): void {
    this.statements.checked.run(new Date().toISOString(), id);
  }

  addEmployeeContact(input: EmployeeContactInput): { employee: Employee; contactCreated: boolean } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.statements.insertEmployee.run(input.firstName, input.lastName, input.address);
      const result = this.statements.insertPhone.run(input.firstName, input.lastName, input.address, input.phone);
      const employee = employeeFromRow(this.statements.employee.get(input.firstName, input.lastName, input.address));
      this.db.exec('COMMIT');
      return { employee, contactCreated: Number(result.changes) === 1 };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listEmployees(query: Pick<ListQuery, 'limit' | 'offset'>) {
    const items = this.statements.employees.all(query.limit, query.offset).map(employeeFromRow);
    return { items, limit: query.limit, offset: query.offset, total: Number(this.statements.employeeCount.get()!.total) };
  }

  checkHealth(): void { this.statements.health.get(); }
  close(): void { this.db.close(); }
}
