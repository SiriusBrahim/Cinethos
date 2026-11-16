import assert from "node:assert/strict";

export const baseItem = (overrides = {}) => ({
  id: 123,
  media_type: "movie",
  title: "Örnek Film",
  status: "watchlist",
  ...overrides,
});

export const assertSame = (actual, expected, message) =>
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);

export const assertClose = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, message || `${actual} ~ ${expected} olmalı`);
