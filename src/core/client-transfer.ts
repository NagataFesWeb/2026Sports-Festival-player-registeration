/** google.script.runで扱えないDate等を、JSONで転送できる値へ変換する。 */
export function toClientSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
