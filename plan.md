# Status Board — Backend, Persistence, Version History & MCP Implementation

## 1. Problem We Are Solving

We have an existing single-file HTML status board for Lit & More. The UI and client-side board logic have already been designed and implemented by another developer.

The board allows the team to view and edit shared project information such as:

* Areas
* Projects
* Project owner
* Status
* Notes
* Updated date
* "Flag for Kris" marker

The current HTML uses Claude Artifact-specific browser storage through:

* `window.storage.get(...)`
* `window.storage.set(...)`

That storage mechanism will NOT work when the HTML is hosted normally.

Our task is therefore **not to redesign or rebuild the status board UI**.

Our task is to build the backend infrastructure that allows the existing frontend to persist its board data reliably, provide version history, and eventually allow an automated Claude/Cowork process to safely read and update the board.

The final system should support two clients:

1. Human users editing the board through the browser.
2. An automated Claude/Cowork agent updating the board through MCP.

---

# 2. Required Deliverables

We must deliver all of the following:

### A. REST API

Implement:

```text
GET /api/board
PUT /api/board
```

### GET /api/board

Return the current board data as JSON.

### PUT /api/board

Accept the complete board object from the frontend.

Before replacing the current board:

1. Save the existing board to `board_history`.
2. Validate the incoming payload.
3. Store the new board.
4. Return the updated board and appropriate metadata.

The API should treat the board as a single shared document for v1.

We do NOT need per-field updates or complex synchronization.

The expected model is:

```text
Frontend
   ↓
PUT entire board
   ↓
Backend
   ↓
validate
   ↓
save previous version
   ↓
replace current version
```

---

# 3. Database

Use:

* PostgreSQL
* Neon PostgreSQL
* Drizzle ORM

unless there is a strong technical reason discovered during implementation to use another approach.

Keep the schema intentionally simple.

At minimum we need:

## board

A single current board record containing:

* id
* board data as JSON/JSONB
* created/updated timestamps

## board_history

Stores previous board versions.

At minimum:

* id
* board data as JSON/JSONB
* timestamp

The history table should allow us to determine what the board looked like before an automated or human update.

Do not over-engineer this into a complicated audit system unless testing reveals that something more is required.

---

# 4. Expected Board Data

The frontend already produces a board object approximately like:

```json
{
  "areas": [
    {
      "name": "Legal ops / trial support",
      "projects": [
        {
          "id": "fl-sweep",
          "name": "Florida Trial Sweep",
          "owner": "Barbrah Shiundu",
          "status": "amber",
          "note": "text...",
          "updated": "2026-07-07",
          "flag": true
        }
      ]
    }
  ]
}
```

The backend should preserve this structure rather than unnecessarily transforming it.

The database should store the board as JSONB.

However, the API must still perform basic validation so malformed data is not blindly persisted.

Inspect the actual supplied HTML/frontend when available and use its real board shape as the authoritative client contract.

---

# 5. Frontend Integration

The existing HTML must eventually be changed from Claude-specific storage to normal API calls.

Do NOT redesign the UI.

Replace the relevant storage operations with calls equivalent to:

```text
GET /api/board
```

for initial loading and:

```text
PUT /api/board
```

for saving changes.

The frontend should continue behaving as the developer originally designed it.

Do not introduce unnecessary frontend architectural changes.

---

# 6. CORS / Deployment

The API must support requests from the actual hosted status-board frontend.

Prefer serving the frontend and API from the same origin if practical because this eliminates unnecessary CORS complexity.

If they are deployed separately, configure CORS explicitly for the known frontend origin.

Do NOT use:

```text
Access-Control-Allow-Origin: *
```

in the production implementation unless there is a demonstrated reason and the security implications are understood.

---

# 7. Authentication / Security

Authentication is explicitly out of scope for the first version unless the existing deployment environment already provides authentication.

However:

* Do not expose secrets to the browser.
* Do not expose the Neon database directly to the frontend.
* Keep database credentials server-side.
* Do not hard-code credentials.
* Use environment variables.
* Do not expose unrestricted database endpoints.

The status board contains internal project information, so the final deployment should not casually expose the API publicly.

If authentication is not implemented in v1, clearly document that limitation.

---

# 8. MCP Server

After the REST API is working and tested, implement a small MCP server for Claude/Cowork automation.

The MCP server should expose exactly two initial tools:

### get_board()

Returns the current board JSON.

Equivalent conceptually to:

```text
GET /api/board
```

### update_board(data)

Accepts a board object.

It must:

1. Validate the board.
2. Preserve the current board in `board_history`.
3. Write the new board.
4. Return confirmation and the resulting board state.

The MCP layer should NOT create a second database implementation.

It should use the same backend/database logic as the REST API.

The goal is:

```text
Browser
   ↓
REST API
   ↓
Shared service/database layer
   ↑
MCP
   ↑
Claude/Cowork
```

There must be one source of truth.

---

# 9. Important Architecture Requirement

Do not implement the REST API and MCP server as two independent systems.

Create a shared application/service layer for board operations.

For example:

```text
boardService.getBoard()
boardService.updateBoard()
boardService.saveHistory()
boardService.validateBoard()
```

Then:

```text
REST API → boardService
MCP      → boardService
```

This prevents the browser and AI automation from behaving differently.

---

# 10. Testing Is Mandatory

Testing must happen continuously during development.

Do NOT build everything first and test only at the end.

Follow this sequence:

## Step 1 — Database

Create the Neon/Drizzle schema.

Test:

* Database connection
* Migration
* Insert current board
* Read current board
* Insert history record
* Update current board

Do not proceed until these work.

---

## Step 2 — Board validation

Create tests for:

### Valid board

A correctly shaped board should be accepted.

### Invalid board

Malformed data should be rejected.

Test cases should include things such as:

* Missing `areas`
* Invalid project structure
* Missing required project identifiers
* Invalid status values where applicable
* Completely invalid JSON/object payload

Do not make validation unnecessarily restrictive if the real HTML contains legitimate fields not known yet.

---

## Step 3 — GET API

Test:

```text
GET /api/board
```

Verify:

* Correct HTTP status
* Correct JSON
* Correct board data
* Empty/initial state behavior

---

## Step 4 — PUT API

Test:

```text
PUT /api/board
```

Verify:

1. Request is accepted.
2. New board becomes current.
3. Previous board is inserted into history.
4. Returned data matches stored data.
5. Invalid requests do not modify the current board.

This is especially important:

> A failed update must never destroy the existing board.

---

# 11. History Testing

Explicitly test:

```text
Version A
   ↓
PUT Version B
   ↓
History contains Version A
Current = Version B
```

Then:

```text
Version B
   ↓
PUT Version C
   ↓
History contains A + B
Current = C
```

This proves that automated updates can be rolled back conceptually.

---

# 12. MCP Testing

Before connecting to a real Cowork/Claude account, test the MCP server locally.

Verify:

### get_board()

Returns exactly the current board.

### update_board()

Updates the board through the same service layer used by REST.

Verify that MCP updates also create history records.

Test:

```text
REST update
   ↓
database
   ↓
MCP get_board
```

and:

```text
MCP update
   ↓
database
   ↓
REST GET
```

Both interfaces must see the same data.

---

# 13. Integration Testing

Once the backend is stable, connect the actual `status-board.html`.

Test the complete human workflow:

```text
Open board
   ↓
GET current board
   ↓
Edit project
   ↓
Automatic save
   ↓
Refresh browser
   ↓
Change remains
```

Then test:

```text
Browser A edits
   ↓
Save
   ↓
Browser B refreshes
   ↓
Browser B sees update
```

Also test failure scenarios:

* API unavailable
* Database unavailable
* Invalid response
* Network interruption
* Failed PUT

The UI must not falsely imply that data was permanently saved when the API rejected the update.

If the existing UI does not currently communicate save failures, identify the smallest change needed to make failures visible.

---

# 14. Concurrency / Last Write Wins

Version 1 intentionally uses a simple shared-document model.

Do NOT implement complicated real-time synchronization, conflict resolution, or per-user editing.

The expected behavior is:

```text
Last successful complete-board write wins.
```

However, identify any obvious race conditions during testing.

If a simple optimistic concurrency/version field can prevent accidental overwrites without substantially complicating the system, document the option rather than implementing unnecessary complexity without approval.

---

# 15. Deployment Requirements

The final system must provide:

### API

A production URL such as:

```text
https://status.litnmore.com/api/board
```

### MCP

A production MCP endpoint/connector URL suitable for the Cowork/Claude integration.

Do not invent the final domain before deployment.

Document:

* Environment variables
* Database configuration
* Migration procedure
* API endpoints
* MCP endpoint
* Deployment steps
* How to run tests
* How to restore a previous board version
* Known v1 limitations

---

# 16. Do Not Overbuild

This is deliberately a small internal system.

Do NOT add unless required:

* User accounts
* Roles/permissions
* Real-time WebSockets
* Complex event sourcing
* Per-field database tables
* Full CMS
* Elaborate admin dashboard
* Complex conflict resolution
* Edit history UI
* AI logic for interpreting transcripts

The AI transcript interpretation belongs to the future Cowork/Claude automation.

Our responsibility is to provide the reliable system that Claude can safely read and write.

---

# 17. Definition of Done

The task is complete only when all of the following are true:

* [ ] Existing status-board HTML has been inspected.
* [ ] Board JSON contract has been confirmed against the real frontend.
* [ ] Neon PostgreSQL database is connected.
* [ ] Drizzle schema and migrations are working.
* [ ] Current board can be stored and retrieved.
* [ ] `GET /api/board` works.
* [ ] `PUT /api/board` works.
* [ ] Previous board versions are stored before updates.
* [ ] Invalid payloads are rejected safely.
* [ ] Failed updates cannot corrupt the current board.
* [ ] REST API tests pass.
* [ ] Existing HTML successfully loads board data from the API.
* [ ] Existing HTML successfully saves edits through the API.
* [ ] Browser refresh confirms persistence.
* [ ] Multiple-browser persistence has been tested.
* [ ] Save/API failure behavior has been tested.
* [ ] MCP `get_board()` works.
* [ ] MCP `update_board()` works.
* [ ] MCP uses the same service/database logic as REST.
* [ ] MCP updates create history records.
* [ ] REST and MCP can read each other's updates.
* [ ] Production API is deployed.
* [ ] Production MCP endpoint is deployed.
* [ ] Required URLs are documented for the frontend developer.
* [ ] Deployment and rollback/backup procedures are documented.

# Final Deliverables to Hand Back

The implementation should ultimately provide:

1. **Working backend API**
2. **Neon PostgreSQL + Drizzle database**
3. **Board persistence**
4. **Board version history**
5. **Updated status-board HTML using the real API**
6. **Automated tests covering database, API, validation, history, and integration**
7. **Working MCP server with `get_board()` and `update_board()`**
8. **Production API URL**
9. **Production MCP URL**
10. **Short setup/deployment documentation**

The guiding principle throughout the implementation is:

> **Build only the infrastructure required to make the existing status board persistent, reliable, and safely writable by both humans and future Claude/Cowork automation. Test every layer before building the next layer.**
