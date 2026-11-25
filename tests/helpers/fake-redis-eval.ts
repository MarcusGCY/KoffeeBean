type Command = (string | number)[];
type Reply = { result?: unknown; error?: string };

/**
 * The fake-Redis side of the demo store's epoch fence. The store sends one `EVAL` whose
 * keys start with the epoch key and whose arguments are the epoch the request began with,
 * then each command as `<length> <name> <args...>`. This replays it the way the script does:
 * the commands run only while the epoch key still holds that epoch, and the reply is the last
 * command's. The inner commands go through the fake's own `exec`, so a test's recorded command
 * list shows them and not the EVAL wrapper.
 */
export function evalFenced(command: Command, read: (key: string) => string | undefined, exec: (inner: Command) => Reply): Reply {
  const numKeys = Number(command[2]);
  const keys = command.slice(3, 3 + numKeys).map(String);
  const epoch = String(command[3 + numKeys]);
  if ((read(keys[0]) ?? "0") !== epoch) return { result: "STALE" };
  let last: Reply = { result: null };
  let i = 4 + numKeys;
  while (i < command.length) {
    const n = Number(command[i]);
    last = exec(command.slice(i + 1, i + 1 + n));
    if (last.error) return last;
    i += n + 1;
  }
  return { result: last.result ?? null };
}
