// Test bootstrap: stub env vars so that importing modules which validate
// env at load-time (e.g. @test-evals/db via @test-evals/env/server) doesn't
// blow up before a test even runs.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
process.env.BETTER_AUTH_URL ??= "http://localhost:8787";
process.env.CORS_ORIGIN ??= "http://localhost:3001";
process.env.NODE_ENV ??= "test";
