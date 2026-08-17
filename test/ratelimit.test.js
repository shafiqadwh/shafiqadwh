import assert from 'node:assert/strict';
import test from 'node:test';
import { createLimiter, resetLimiters } from '../src/lib/ratelimit.js';

function fakeRequest(ip = '10.0.0.1') {
  return { ip, t: (key) => key };
}

function fakeResponse() {
  const response = { statusCode: 200, body: null };
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.json = (payload) => {
    response.body = payload;
    return response;
  };
  return response;
}

function call(limiter, ip) {
  const res = fakeResponse();
  let passed = false;
  limiter(fakeRequest(ip), res, () => {
    passed = true;
  });
  return { passed, res };
}

test('a limiter blocks once its window is full', () => {
  resetLimiters();
  const limiter = createLimiter({ name: 'test-a', limit: 2, windowMs: 60_000 });

  assert.equal(call(limiter, '1.1.1.1').passed, true);
  assert.equal(call(limiter, '1.1.1.1').passed, true);

  const third = call(limiter, '1.1.1.1');
  assert.equal(third.passed, false);
  assert.equal(third.res.statusCode, 429);
  assert.equal(third.res.body.error, 'errors.rate_limited');
});

test('separate limiters do not share one budget', () => {
  // Regression: uploading a batch of photos must never lock a guest out of the
  // guest book, nor lock the hosts out of the admin login.
  resetLimiters();
  const uploads = createLimiter({ name: 'upload', limit: 3, windowMs: 60_000 });
  const messages = createLimiter({ name: 'message', limit: 3, windowMs: 60_000 });
  const login = createLimiter({ name: 'admin-login', limit: 3, windowMs: 60_000 });

  for (let i = 0; i < 3; i += 1) assert.equal(call(uploads, '1.1.1.1').passed, true);
  assert.equal(call(uploads, '1.1.1.1').passed, false, 'the upload budget is spent');

  assert.equal(call(messages, '1.1.1.1').passed, true, 'the guest book has its own budget');
  assert.equal(call(login, '1.1.1.1').passed, true, 'the hosts can still log in');
});

test('one busy phone does not affect the next guest', () => {
  resetLimiters();
  const limiter = createLimiter({ name: 'test-b', limit: 1, windowMs: 60_000 });

  assert.equal(call(limiter, '1.1.1.1').passed, true);
  assert.equal(call(limiter, '1.1.1.1').passed, false);
  assert.equal(call(limiter, '2.2.2.2').passed, true);
});

test('a limit of zero means unlimited', () => {
  resetLimiters();
  const limiter = createLimiter({ name: 'test-c', limit: 0, windowMs: 60_000 });
  for (let i = 0; i < 50; i += 1) assert.equal(call(limiter, '1.1.1.1').passed, true);
});

test('unnamed limiters still get separate budgets', () => {
  resetLimiters();
  const first = createLimiter({ limit: 1, windowMs: 60_000 });
  const second = createLimiter({ limit: 1, windowMs: 60_000 });

  assert.equal(call(first, '1.1.1.1').passed, true);
  assert.equal(call(first, '1.1.1.1').passed, false);
  assert.equal(call(second, '1.1.1.1').passed, true);
});
