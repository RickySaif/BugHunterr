# Session __RUN__ (fake agent: a replayed hunt, for the offline demo)

## Charters
1. approvals: permissions on approve and reject, as employee vs manager
2. request dates: working-day maths, reversed and cross-year ranges

## Probes
| What | Expected | Result |
|---|---|---|
| employee approves own request | 403, pending | 200, approved → AL-1 |
| employee rejects a request | 403 | 403 ✓ |
| Fri 8 → Mon 11 March 2030 | 2 days | 4 days → AL-2 |
| 15 → 13 March 2030 | 400 | 201, -1 days → AL-3 |
| 30 Dec 2030 → 2 Jan 2031 | 400 | 400 ✓ |

## Not reached
- balance after cancellations; team list privacy (R8)
