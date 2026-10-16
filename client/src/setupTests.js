import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

// Generous limits: CI machines run test files in parallel and full-App renders are not instant.
configure({ asyncUtilTimeout: 4000 });
jest.setTimeout(20000);

// Flaky-test retry (docs/TEST_STRATEGY.md). CI sets JEST_RETRY=2 so a test
// that fails once for environmental reasons (jsdom timing, cold caches) is
// retried instead of failing the pipeline; a test that fails every attempt
// still fails it. Locally it is off by default so failures surface at once.
const retryCount = Number(process.env.JEST_RETRY || 0);
if (Number.isInteger(retryCount) && retryCount > 0) {
  jest.retryTimes(retryCount, { wait: 200 });
}

// Track every QueryClient so the App's module-level cache can be cleared between tests,
// and drop retry delays so error states appear without waiting a second.
global.__queryClients = [];
jest.mock('@tanstack/react-query', () => {
  const actual = jest.requireActual('@tanstack/react-query');
  class TrackedQueryClient extends actual.QueryClient {
    constructor(config = {}) {
      const defaults = config.defaultOptions || {};
      super({ ...config, defaultOptions: { ...defaults, queries: { ...defaults.queries, retryDelay: 0 } } });
      global.__queryClients.push(this);
    }
  }
  return { ...actual, QueryClient: TrackedQueryClient };
});

// Recharts' ResponsiveContainer needs ResizeObserver and a non-zero size in jsdom.
class ResizeObserverMock {
  constructor(callback) { this.callback = callback; }
  observe(target) { this.callback([{ target, contentRect: { width: 800, height: 260 } }]); }
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverMock;
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 260 });

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  global.__queryClients.forEach((client) => client.clear());
  jest.restoreAllMocks();
});
