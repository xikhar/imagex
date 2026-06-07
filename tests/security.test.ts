import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeBindHost,
  imagexSessionHeader,
  isAllowedMutationOrigin,
  isLoopbackHost,
  isMutatingApiRequest,
  isValidSessionHeader,
  remoteBindWarning,
} from '../src/daemon/security.js';

test('loopback host detection allows local hosts only', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.12.3.4:3847'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('[::1]:3847'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('192.168.1.20'), false);
  assert.equal(isLoopbackHost('example.test'), false);
});

test('non-loopback bind requires explicit remote allowance', () => {
  assert.doesNotThrow(() => assertSafeBindHost('127.0.0.1'));
  assert.throws(() => assertSafeBindHost('0.0.0.0'), /Refusing to bind ImageX/);
  assert.doesNotThrow(() => assertSafeBindHost('0.0.0.0', true));
  assert.match(remoteBindWarning('0.0.0.0') || '', /Anyone who can reach/);
  assert.equal(remoteBindWarning('localhost'), null);
});

test('session guard helper classifies mutating API requests', () => {
  assert.equal(isMutatingApiRequest('GET', '/api/projects'), false);
  assert.equal(isMutatingApiRequest('POST', '/api/projects'), true);
  assert.equal(isMutatingApiRequest('DELETE', '/api/projects/p1'), true);
  assert.equal(isMutatingApiRequest('POST', '/outputs/workflow/file.png'), false);
});

test('mutation origin check allows same host and loopback dev origins', () => {
  assert.equal(isAllowedMutationOrigin(undefined, '127.0.0.1:3847'), true);
  assert.equal(isAllowedMutationOrigin('http://127.0.0.1:5173', '127.0.0.1:3847'), true);
  assert.equal(isAllowedMutationOrigin('http://localhost:5173', '127.0.0.1:3847'), true);
  assert.equal(isAllowedMutationOrigin('http://192.168.1.20:3847', '192.168.1.20:3847'), true);
  assert.equal(isAllowedMutationOrigin('https://evil.example', '127.0.0.1:3847'), false);
  assert.equal(isAllowedMutationOrigin('not-a-url', '127.0.0.1:3847'), false);
});

test('session header validation requires exact token value', () => {
  assert.equal(imagexSessionHeader, 'x-imagex-session');
  assert.equal(isValidSessionHeader('token', 'token'), true);
  assert.equal(isValidSessionHeader('token', 'wrong'), false);
  assert.equal(isValidSessionHeader('token', undefined), false);
});
