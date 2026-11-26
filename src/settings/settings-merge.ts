function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(key =>
    Object.prototype.hasOwnProperty.call(right, key) &&
    equalValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

/** Keep edits made while an IPC save is pending, while accepting host normalization. */
export function mergeSettings<T>(sent: T, current: T, accepted: T): T {
  if (equalValue(sent, current)) return structuredClone(accepted);
  if (
    !sent ||
    !current ||
    !accepted ||
    typeof sent !== "object" ||
    typeof current !== "object" ||
    typeof accepted !== "object"
  )
    return structuredClone(current);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(accepted)) {
    const property = key as keyof T;
    result[key] = mergeSettings(
      sent[property],
      current[property],
      accepted[property],
    );
  }
  return result as T;
}
