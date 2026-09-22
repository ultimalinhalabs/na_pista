import assert from "node:assert/strict";
import test from "node:test";
import { exceedsLimit } from "../../src/modules/products/service.js";

test("exceedsLimit: below max -> false", () => assert.equal(exceedsLimit(0, 1), false));
test("exceedsLimit: at max -> true (max is a ceiling, not the last allowed index)", () => assert.equal(exceedsLimit(1, 1), true));
test("exceedsLimit: above max -> true", () => assert.equal(exceedsLimit(5, 1), true));
