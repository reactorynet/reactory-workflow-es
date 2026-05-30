import { toError } from "../../src";

describe("toError", () => {
    it("returns the same Error instance when given an Error", () => {
        const orig = new Error("x");
        expect(toError(orig)).toBe(orig);
    });

    it("wraps a string into an Error with matching message", () => {
        const result = toError("boom");
        expect(result instanceof Error).toBe(true);
        expect(result.message).toBe("boom");
    });

    it("wraps an object into an Error instance", () => {
        const result = toError({ code: 1 });
        expect(result instanceof Error).toBe(true);
        expect(typeof result.message).toBe("string");
    });
});
