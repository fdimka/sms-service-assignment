# - Created by Dmitry Fridman -

     Time of work effort on the test task approximatlly 4-5 hours.

# Employee SMS service

-     A local SMS service with employee contacts, a basic send form and
        a live message log.

  ** Requests are saved in SQLite before a background worker sends them.
  ** Provider acceptance and delivery are separate states;
  ** Uncertain sends are not retried automatically;
  ** There are an employee model and ultra simple browser page;

## Run

Install **Node.js 24 LTS**, with npm.
From the `sms-service` folder:

```powershell
npm run local
```

This installs the locked dependencies, builds TypeScript and starts the API and
browser page at **http://127.0.0.1:3000/**.
The bundled substitute provider runs at `http://127.0.0.1:4010` and sends no real SMS.
Installation needs internet access.
Later runs can use `npm start`.
Stop with Ctrl+C.

SQLite is saved in `data/messages.sqlite`.
No Docker or separate database server is needed.
Optional overrides are in `.env.example`; copy it to `.env` if needed.
`npm run dev -- --host 127.0.0.1 --port 3001 --strictPort` also supports an explicit local port.
The default host remains loopback.

## Browser workflow

1. Open http://127.0.0.1:3000/.
2. Save an employee's first name, last name, address and phone. Save the same
   identity with a different phone to add another number. Shared numbers are allowed.
3. Select the employee and one destination number. Write a message or insert a
   short preset using **Insert sample text**, then send it.
4. Follow its status in the log. Filter by status, refresh manually, pause the
   two-second automatic refresh, or page through older messages.

The preset button uses local example text, not an AI API.
The page supports one SMS to one chosen contact per submission.
It does not broadcast to every number.

## Employee identity

An employee is identified by the **combination of first name, last name and
address**. There is no employee number or employee UUID.
The database stores a composite employee key and separate contact rows.
One employee can have several phone numbers, and different employees can share the same number.
Identity fields are normalized to Unicode NFC, trimmed, and have internal
whitespace collapsed.
Each employee-linked message stores an identity snapshot.
Its selected phone must already be registered to that employee.
The original phone-only API remains supported; it produces `employee: null` and never guesses a person from a number.

## API

POST /employees - Accept {firstName,lastName,address,phone} add/group a contact; return 201, or 200 for an existing contact;
GET /employees - Return {items,limit,offset,total} with each employee's phones array;
POST /messages - Accept {to,body} and optional employee: {firstName,lastName,address}; return 202 with `{id,status}` and a Location header;
GET /messages/:id - Return the stored message, identity snapshot and status; 404 if absent;
GET /messages - Return {items,limit,offset}; optional status, limit and offset;
GET /health - Check the database; does not claim provider availability;

A message's UUID identifies the message, not an employee.
The provider's receipt ID and the request's optional `Idempotency-Key` have separate purposes.
Same key and payload returns the original message.
Reusing the key with changed text, destination or employee returns 409 (without a key, requests are independent).
The browser disables an in-flight send, reuses the key for an unchanged retry
after a network error, and clears text after a confirmed submission.
Its retry key is kept for the page session and server-side keys are persistent.

States: queued, sending, accepted, delivered, failed, unknown.
Phone syntax is `+` followed by 8-15 digits, starting non-zero.
Unicode code points and cannot be only whitespace.  
Errors use `{error:{code,message}}`.

## Decisions and boundaries

The small UI was added to monitor and track the process to see that it works E2E as planned.
UI local review, is without authentication or public hosting.
Authentication and deployment are excluded by the task requerment.
Campaigns, automated failover, send retries and production alerting are not implemented.

- **TypeScript, Fastify and SQLite:** few dependencies, parameterized SQL, and
  local persistence without extra infrastructure. The frontend is plain HTML,
  CSS and JavaScript served by the same Fastify process.

- **Persist before sending:** a successful POST confirms storage, not delivery.
  The messages table is also the durable local queue.

- **Conservative recovery:** a send timeout or interrupted sending row becomes
  unknown. It may need reconciliation; a blind retry could duplicate an SMS.

- **One process per database:** one serial worker and synchronous SQLite are
  intentional local limits.

- **Provider unchanged:** the attachment did not include the promised provider.
  The bundled HTTP substitute and its contract remain the same. Integrating
  their provider still requires verifying the actual contract and adapter.

- **Historical snapshots:** employee details on messages remain separate from
  the directory, so future directory changes need not rewrite history. Directory
  edits/deletion, employee imports and identity changes are outside this version.

## Check

```powershell
npm test
npm run check
npm run smoke
```

The suite includes 53 tests covering:  
employee grouping,
shared numbers,
identity-aware idempotency,
persistence,
legacy schema upgrade,
UI asset routes,
The smoke command checks real HTTP requests and a server restart with a temporary database.

## AI use and time

ChatGPT was used to:
interpret requirements,
generate the tests for code,
help with browser page and documentation,
run checks,  
fix issues found during verification.
It helped keep the implementation consistent with the stated contracts and exercise integration failure paths.
