// Business rules for Acme Leave. The requirements are in docs/prd.md.
export const ENTITLEMENT = 20;
const DAY = 24 * 60 * 60 * 1000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export function countDays(start, end) {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Math.round(ms / DAY) + 1;
}

export function balance(db, userId, year) {
  const used = db.prepare(
    "SELECT COALESCE(SUM(days), 0) AS used FROM requests WHERE user_id = ? AND status = 'approved' AND substr(start_date, 1, 4) = ?",
  ).get(userId, String(year)).used;
  return { year: Number(year), entitlement: ENTITLEMENT, used, remaining: ENTITLEMENT - used };
}

export function listOwn(db, userId) {
  return db.prepare('SELECT * FROM requests WHERE user_id = ? ORDER BY start_date DESC, id DESC').all(userId);
}

export function listTeam(db, user) {
  if (user.role !== 'manager') throw new HttpError(403, 'only managers can see team requests');
  return db.prepare(
    'SELECT r.*, u.name AS user_name FROM requests r JOIN users u ON u.id = r.user_id ORDER BY r.start_date DESC, r.id DESC',
  ).all();
}

export function createRequest(db, user, { start, end, reason = '' }, now) {
  if (!isDate(start) || !isDate(end)) throw new HttpError(400, 'start and end must be dates (YYYY-MM-DD)');
  if (start.slice(0, 4) !== end.slice(0, 4)) throw new HttpError(400, 'a request must stay inside one calendar year');
  const days = countDays(start, end);
  const { remaining } = balance(db, user.id, start.slice(0, 4));
  if (days > remaining) throw new HttpError(400, `not enough leave left (${remaining} days)`);
  const info = db.prepare(
    "INSERT INTO requests (user_id, start_date, end_date, days, reason, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
  ).run(user.id, start, end, days, String(reason).slice(0, 200), now);
  return getRequest(db, Number(info.lastInsertRowid));
}

export function getRequest(db, id) {
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
}

function pendingOr404(db, id) {
  const req = getRequest(db, id);
  if (!req) throw new HttpError(404, 'request not found');
  if (req.status !== 'pending') throw new HttpError(409, `request is already ${req.status}`);
  return req;
}

export function approveRequest(db, user, id, now) {
  const req = pendingOr404(db, id);
  db.prepare("UPDATE requests SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?").run(user.id, now, req.id);
  return getRequest(db, req.id);
}

export function rejectRequest(db, user, id, now) {
  const req = pendingOr404(db, id);
  if (user.role !== 'manager') throw new HttpError(403, 'only managers can reject');
  if (req.user_id === user.id) throw new HttpError(403, 'you cannot decide your own request');
  db.prepare("UPDATE requests SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?").run(user.id, now, req.id);
  return getRequest(db, req.id);
}

export function cancelRequest(db, user, id, now) {
  const req = pendingOr404(db, id);
  if (req.user_id !== user.id) throw new HttpError(403, 'you can only cancel your own request');
  db.prepare("UPDATE requests SET status = 'cancelled', decided_at = ? WHERE id = ?").run(now, req.id);
  return getRequest(db, req.id);
}
