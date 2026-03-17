const httpMocks = require('node-mocks-http');

jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(),
}));

const jwt = require('jsonwebtoken');
const { authenticate, getUserFromRequest } = require('../src/middleware/auth');

describe('auth middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('getUserFromRequest returns decoded user from bearer token', () => {
    jwt.verify.mockReturnValue({
      sub: 'user-1',
      email: 'test@example.com',
      role: 'admin',
    });

    const req = httpMocks.createRequest({
      headers: { authorization: 'Bearer jwt-token' },
    });

    expect(getUserFromRequest(req)).toEqual({
      id: 'user-1',
      email: 'test@example.com',
      role: 'admin',
    });
  });

  test('authenticate returns 401 when authorization header is missing', () => {
    const req = httpMocks.createRequest();
    const res = httpMocks.createResponse();
    const next = jest.fn();

    authenticate(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res._getJSONData()).toEqual({ error: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();
  });

  test('authenticate sets req.user and calls next on valid token', () => {
    jwt.verify.mockReturnValue({
      sub: 'user-1',
      email: 'test@example.com',
      role: 'user',
    });

    const req = httpMocks.createRequest({
      headers: { authorization: 'Bearer valid-token' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    authenticate(req, res, next);

    expect(req.user).toEqual({
      id: 'user-1',
      email: 'test@example.com',
      role: 'user',
    });
    expect(next).toHaveBeenCalled();
  });
});
