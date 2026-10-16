// Opt-in retry for flaky tests (docs/TEST_STRATEGY.md).
//
// CI sets JEST_RETRY=2 on PR runs and JEST_RETRY=3 on the nightly full run:
// a test that fails once or twice for environmental reasons (timing, port
// reuse, cold caches) is retried instead of failing the whole pipeline, while
// a test that fails every attempt still fails it — a genuinely broken build
// is never masked, only transient noise is absorbed.
//
// Locally, `npm test` runs without retries so failures surface immediately.
// Set JEST_RETRY=n manually to reproduce CI behaviour.
const retry = Number(process.env.JEST_RETRY || 0);

if (Number.isInteger(retry) && retry > 0) {
    jest.retryTimes(retry, { wait: 200 });
}
