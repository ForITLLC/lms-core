// SQL Server ends a deadlock by rolling back one side with error 1205. The
// victim's statement changed nothing, so it is safe to run again; once is
// enough to get past a passing collision, and a second loss is a real failure.
export function isDeadlock(err: unknown): boolean {
  return (err as { number?: unknown } | null)?.number === 1205;
}

export async function retryDeadlockOnce<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isDeadlock(err)) throw err;
    return await run();
  }
}
