
export const SESSION_COOKIE = 'counter_session';
export const API_URL = process.env.API_URL ?? 'http://localhost:3000';

export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 12 * 3600,
};
