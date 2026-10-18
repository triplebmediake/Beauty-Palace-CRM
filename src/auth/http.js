// Express-style middleware (req, res, next) with no framework import, so it is testable on its own.
import { authenticate } from './service.js';
import { AppError } from '../errors.js';

export const authMiddleware = ({ db, secret }) => async (req, res, next) => {
  try { req.user = await authenticate(db, req.headers?.authorization, { secret }); next(); } catch (e) { next(e); }
};
/** Allow the request only if the user holds ALL of the listed permissions. */
export const requirePermission = (...perms) => (req, res, next) => {
  if (!req.user) return next(new AppError(401, 'UNAUTHENTICATED', 'Please sign in'));
  const missing = perms.filter((p) => !req.user.permissions.has(p));
  next(missing.length ? new AppError(403, 'FORBIDDEN', 'You do not have permission to do this', { missing }) : undefined);
};
/** A branch the user is not assigned to is off limits (super admins hold branches.manage and see all). */
export const requireBranch = (getBranchId) => (req, res, next) => {
  const b = Number(getBranchId(req));
  const ok = req.user.permissions.has('branches.manage') || req.user.branchIds.includes(b);
  next(ok ? undefined : new AppError(403, 'WRONG_BRANCH', 'You are not assigned to this branch'));
};
export const errorHandler = (err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: { code: err.code || 'INTERNAL', message: status >= 500 ? 'Something went wrong' : err.message, details: err.details } });
};
