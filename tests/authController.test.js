const httpMocks = require('node-mocks-http');

jest.mock('../src/db', () => ({
  query: jest.fn(),
}));

jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed'),
  compare: jest.fn().mockResolvedValue(true),
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('jwt-token'),
}));

const db = require('../src/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { signup, login } = require('../src/controllers/authController');

describe('authController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('signup returns 400 when email or password missing', async () => {
    const req = httpMocks.createRequest({ body: {} });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await signup(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  test('signup returns 409 when email already exists', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: '1' }] });

    const req = httpMocks.createRequest({
      body: { email: 'test@example.com', password: 'password' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await signup(req, res, next);

    expect(res.statusCode).toBe(409);
  });

  test('signup creates user and returns token', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // existing user check
      .mockResolvedValueOnce({
        rows: [
          {
            id: '1',
            email: 'test@example.com',
            role: 'user',
            created_at: '2024-01-01T00:00:00Z',
          },
        ],
      });

    const req = httpMocks.createRequest({
      body: { email: 'test@example.com', password: 'password' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await signup(req, res, next);

    expect(bcrypt.hash).toHaveBeenCalled();
    expect(jwt.sign).toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
    const data = res._getJSONData();
    expect(data).toHaveProperty('token', 'jwt-token');
    expect(data.user).toMatchObject({ email: 'test@example.com' });
  });

  test('login returns 400 when email or password missing', async () => {
    const req = httpMocks.createRequest({ body: {} });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await login(req, res, next);

    expect(res.statusCode).toBe(400);
  });

  test('login returns 401 when user not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const req = httpMocks.createRequest({
      body: { email: 'missing@example.com', password: 'password' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await login(req, res, next);

    expect(res.statusCode).toBe(401);
  });

  test('login returns 401 when password invalid', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: '1',
          email: 'test@example.com',
          password_hash: 'hashed',
          role: 'user',
          created_at: '2024-01-01T00:00:00Z',
        },
      ],
    });
    bcrypt.compare.mockResolvedValueOnce(false);

    const req = httpMocks.createRequest({
      body: { email: 'test@example.com', password: 'wrong' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await login(req, res, next);

    expect(res.statusCode).toBe(401);
  });

  test('login returns token on success', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: '1',
          email: 'test@example.com',
          password_hash: 'hashed',
          role: 'user',
          created_at: '2024-01-01T00:00:00Z',
        },
      ],
    });

    const req = httpMocks.createRequest({
      body: { email: 'test@example.com', password: 'password' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    await login(req, res, next);

    expect(jwt.sign).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data).toHaveProperty('token', 'jwt-token');
  });
});
