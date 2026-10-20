/**
Narrow untrusted JSON arrays without coercing their members.
@param value - Contract or wire field.
@returns Array values or an empty list.
*/
export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
