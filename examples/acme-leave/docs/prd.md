# Acme Leave: product requirements

Acme Leave lets employees ask for paid leave and lets managers decide. This is a fictional product used by the
BugHunterr demo. Each rule has an ID (R1, R2 …) that tests and bug reports link to.

## US-1 Balance

As an employee I want to see how much leave I have left this year, so I can plan.

- **R1** Every employee is entitled to **20 working days** of leave per calendar year.
- **R5** *Remaining* = entitlement − working days of **approved** requests in that year. Pending, rejected and
  cancelled requests do not count.

## US-2 Request leave

As an employee I want to request leave for a date range.

- **R2** The length of a request counts **working days only (Monday to Friday)**. Saturdays and Sundays are not
  counted. (Public holidays are out of scope for this version.)
  *Example: Friday 8 March to Monday 11 March 2030 is 2 working days.*
- **R3** The end date must be on or after the start date, and a request must contain at least one working day.
  Otherwise the app refuses it with HTTP 400 and a message, and nothing is saved.
- **R7** A request may not be longer than the remaining balance (HTTP 400).
- **R9** A request stays inside one calendar year.

## US-3 Decide

As a manager I want to approve or reject my team's requests.

- **R4** Only a **manager** can approve or reject a request, and **nobody can decide their own request**.
  Anyone else gets HTTP 403 and the request stays pending.
- **R10** Only pending requests can be decided (HTTP 409 otherwise).

## US-4 Cancel

- **R6** An employee can cancel their own pending request. Nobody else can (HTTP 403).

## US-5 Privacy

- **R8** An employee sees only their own requests. The team list is for managers only (HTTP 403).
