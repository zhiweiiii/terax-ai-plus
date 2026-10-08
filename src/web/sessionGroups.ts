export function groupSessions<T extends { space: string | null }>(
  sessions: T[],
  spaces: { id: string; name: string }[],
): { id: string; name: string; sessions: T[] }[] {
  const bySpace = new Map<string, T[]>();
  for (const session of sessions) {
    const id = session.space ?? "";
    const list = bySpace.get(id);
    if (list) list.push(session);
    else bySpace.set(id, [session]);
  }
  const groups = spaces.map((space) => {
    const list = bySpace.get(space.id) ?? [];
    bySpace.delete(space.id);
    return { id: space.id, name: space.name || "其他", sessions: list };
  });
  for (const [id, list] of bySpace)
    groups.push({ id, name: id || "其他", sessions: list });
  return groups;
}
