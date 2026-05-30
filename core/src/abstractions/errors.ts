/** Normalises an unknown thrown value into an Error (strict-catch safe). */
export const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));
