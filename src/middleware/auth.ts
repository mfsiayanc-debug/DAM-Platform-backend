import { NextFunction, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import config from '../config';

type AuthTokenPayload = JwtPayload & {
  sub: string;
  email?: string;
  role?: string;
};

function getUserFromRequest(req: Request) {
  const authHeader = req.headers.authorization || '';
  const queryToken =
    req.query && typeof req.query.token === 'string' ? req.query.token : null;
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : queryToken;

  if (!token) {
    const error = new Error('Authentication required') as Error & { status?: number };
    error.status = 401;
    throw error;
  }

  try {
    const payload = jwt.verify(token, config.auth.jwtSecret) as AuthTokenPayload;
    return { id: payload.sub, email: payload.email, role: payload.role };
  } catch {
    const error = new Error('Invalid or expired token') as Error & { status?: number };
    error.status = 401;
    throw error;
  }
}

function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    req.user = getUserFromRequest(req);
    next();
  } catch (err) {
    const error = err as Error & { status?: number };
    return res.status(error.status || 401).json({ error: error.message });
  }
}

export { getUserFromRequest, authenticate };
