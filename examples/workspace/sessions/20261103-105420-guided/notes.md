# Session 20261103-105420-guided: Acme Leave (GUIDED)

## Charters (biggest risk first)
1. Approvals/permissions: who can approve/reject/cancel (R4, R6, R10). Roles: employee, employee2, manager.
2. Day counting and balance: weekends, balance cap, approved-only counting (R1, R2, R5, R7). Roles: employee, manager.
3. Request validation: reversed ranges, year boundary, bad dates/types (R3, R9). Role: employee.
4. Privacy: own list vs team list, logged-out access (R8). Roles: all + anonymous.

## Map
- UI (single page `public/index.html` + `app.js`): login form; "My leave" = balance card (remaining/used), request form (From, To, Reason, "Request leave"), my-requests table with Cancel; "Team" (managers only) = team table with Approve/Reject.
- API: POST /api/login, /api/logout; GET /api/me, /api/balance?year=, /api/requests, /api/team/requests; POST /api/requests, /api/requests/:id/{approve,reject,cancel}.
- Rules live in `src/leave.mjs`; routing/auth in `server.mjs`.
- Decision noted: because of the 15-minute budget I mapped the app from the source and the UI test ids and drove the UI only through the recorded repros (bughunterr record), not through interactive MCP browser sessions.

## Probes
| What | Expected | Result |
|---|---|---|
| Ben approves own pending request | 403, pending (R4) | **200 approved, decided_by Ben → AL-1** |
| Cleo (employee) approves Ben's request | 403 (R4) | **200 approved → AL-1** |
| Ben rejects a request | 403 | 403 ✓ |
| Fri 8 – Mon 11 Mar 2030 | 2 days (R2) | **4 days → AL-2** |
| End 2032-03-08 before start 2032-03-11 | 400, nothing saved (R3) | **201, days = -2 → AL-3** |
| Two 15-day requests in 2077 both approved by Ana | second refused, remaining ≥ 0 (R1/R7) | **both 200, remaining -10 → AL-4** |
| Request 2034-12-31..2035-01-01 | 400 (R9) | 400 ✓ |
| 2036-01-01..03-01 (61 days) | 400 (R7) | 400 ✓ |
| Cleo cancels Ben's pending request | 403 (R6) | 403 ✓ |
| Ana approves an already approved request | 409 (R10) | 409 ✓ |
| Employee GET /api/team/requests | 403 (R8) | 403 ✓ |
| Cleo GET /api/requests | only her own (R8) | only her own ✓ |
| Anonymous GET /api/requests | 401 | 401 ✓ |
| start as number, end null | 400 | 400 ✓ |
| start = end = 2033-02-30 (impossible date) | 400 | 201 saved with days 1 (suspicion, see below) |

## Bugs
- AL-1 (critical) Any employee can approve leave, including their own — approveRequest lacks role/owner checks (R4).
- AL-2 (high) Weekends counted as leave days — countDays counts calendar days (R2). Also means Sat/Sun-only requests are accepted.
- AL-3 (high) End-before-start accepted, saved with negative days (R3).
- AL-4 (high) Approvals not re-checked against balance; remaining goes negative (R1/R7).

## Suspicions not filed
- Impossible dates (2033-02-30) are accepted: isDate relies on Date.parse which rolls over. No PRD rule names date validity explicitly (only basis "inferred"), so not filed under the spec-only rule.
- Weekend-only request (e.g. Sat–Sun) accepted instead of 400 (R3 "at least one working day"): same root cause as AL-2 (countDays), so folded into AL-2 rather than filed twice.
- Cancel/reject on a non-pending request of another user returns 409 before the 403 ownership/role check (check order leaks state). Minor, spec does not define precedence.
- POST /api/logout clears the cookie but does not delete the server session; an old sid stays valid. Not covered by the PRD.

## Not reached
- Interactive browser mapping per role with network capture (MCP browser not used; UI exercised only via repro recordings).
- UI vs API consistency of the balance card after approvals/cancellations.
- Concurrency (double approve races), very long reasons (server truncates to 200), year-boundary balance via ?year= with junk values.
