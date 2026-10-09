import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CancelledError,
  InternalError,
  PermissionDeniedError,
  PlatformError,
  ValidationError,
  throwIfAborted,
  toPlatformError,
} from "../src/index.js";

describe("errors", () => {
  it("keeps platform errors as-is", () => {
    const e = new PermissionDeniedError("nope", { details: { path: "C:/x" } });
    assert.equal(toPlatformError(e), e);
    assert.equal(e.code, "PERMISSION_DENIED");
    assert.deepEqual(e.toJSON().details, { path: "C:/x" });
  });

  it("hides unknown error messages behind an internal error", () => {
    const e = toPlatformError(new Error("secret stack detail"));
    assert.ok(e instanceof InternalError);
    assert.equal(e.message, "Internal error.");
    assert.equal((e.cause as Error).message, "secret stack detail");
  });

  it("maps abort errors to cancellation", () => {
    const abort = new DOMException("aborted", "AbortError");
    assert.ok(toPlatformError(abort) instanceof CancelledError);
  });

  it("throwIfAborted propagates platform reasons", () => {
    const ac = new AbortController();
    throwIfAborted(ac.signal);
    const reason = new PlatformError("TIMEOUT", "too slow");
    ac.abort(reason);
    assert.throws(() => throwIfAborted(ac.signal), (e) => e === reason);
    const ac2 = new AbortController();
    ac2.abort();
    assert.throws(() => throwIfAborted(ac2.signal), CancelledError);
  });

  it("validation errors carry issues", () => {
    const e = new ValidationError("bad input", [{ path: "a.b", message: "Required" }]);
    assert.equal(e.issues.length, 1);
    assert.deepEqual((e.details as { issues: unknown }).issues, [{ path: "a.b", message: "Required" }]);
  });
});
