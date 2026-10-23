export { registerAuthRoutes } from './auth.js';
export { authenticate, requireAuth, requireScopes } from './guards.js';
export { maskPhoneE164, normalizeE164Phone, PhoneInvalidError } from './phone.js';
export { enforceUserRouteProtection, isPublicUserRoute } from './route-policy.js';
export { hashPassword } from './security.js';
export type { AccessClaims } from './security.js';
export { currentSessionAccess } from './session-access.js';
export { lockAccountSessions, terminateRefreshTokens } from './session-lifecycle.js';
