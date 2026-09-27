/** The first room is a fixed, local scene. Furniture and walls are not walkable. */
export const ROOM_TILES = [
  '##########',
  '#...#....#',
  '#.D.#....#',
  '#........#',
  '#...#....#',
  '#...#..S.#',
  '#E.......#',
  '##########',
] as const;

export type RoomPoint = { col: number; row: number };
export type RoomSpot = 'desk' | 'sofa' | 'door';

export const ROOM_START: RoomPoint = { col: 1, row: 6 };
export const ROOM_SPOTS: Record<RoomSpot, { point: RoomPoint; label: string; activity: string; prompt: string | null }> = {
  desk: { point: { col: 2, row: 3 }, label: '书桌', activity: '在书桌旁读书', prompt: '我们一起读点什么？' },
  sofa: { point: { col: 7, row: 4 }, label: '沙发', activity: '在沙发旁休息', prompt: '陪我聊聊吧。' },
  door: { point: { col: 1, row: 6 }, label: '门口', activity: '离开当前互动，在门口等你', prompt: null },
};

export function isWalkable(point: RoomPoint): boolean {
  const tile = ROOM_TILES[point.row]?.[point.col];
  return tile === '.' || tile === 'E';
}

/** Four-way BFS; a failed route never becomes a straight-line fallback. */
export function findRoomPath(from: RoomPoint, to: RoomPoint, blocked: ReadonlySet<string> = new Set()): RoomPoint[] | null {
  if (!isWalkable(from) || !isWalkable(to) || blocked.has(`${to.col},${to.row}`)) return null;
  if (from.col === to.col && from.row === to.row) return [];
  const key = (point: RoomPoint) => `${point.col},${point.row}`;
  const queue: RoomPoint[] = [from];
  const previous = new Map<string, RoomPoint | null>([[key(from), null]]);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    for (const next of [
      { col: current.col, row: current.row - 1 },
      { col: current.col + 1, row: current.row },
      { col: current.col, row: current.row + 1 },
      { col: current.col - 1, row: current.row },
    ]) {
      const nextKey = key(next);
      if (!isWalkable(next) || blocked.has(nextKey) || previous.has(nextKey)) continue;
      previous.set(nextKey, current);
      if (next.col === to.col && next.row === to.row) {
        const path: RoomPoint[] = [next];
        let step: RoomPoint | null = current;
        while (step && key(step) !== key(from)) {
          path.unshift(step);
          step = previous.get(key(step)) ?? null;
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

export interface RoomMotion {
  position: RoomPoint;
  path: RoomPoint[];
  destination: RoomSpot | null;
  activity: string;
}

export function initialRoomMotion(position: RoomPoint = ROOM_START): RoomMotion {
  const valid = isWalkable(position) ? position : ROOM_START;
  const destination = (Object.keys(ROOM_SPOTS) as RoomSpot[]).find((spot) =>
    ROOM_SPOTS[spot].point.col === valid.col && ROOM_SPOTS[spot].point.row === valid.row) ?? null;
  return {
    position: valid, path: [], destination,
    activity: destination ? ROOM_SPOTS[destination].activity : '在房间里等你',
  };
}

export function routeToRoomSpot(state: RoomMotion, destination: RoomSpot): RoomMotion {
  const route = findRoomPath(state.position, ROOM_SPOTS[destination].point);
  if (route === null) return { ...state, path: [], destination: null, activity: '这条路暂时走不通' };
  if (route.length === 0) return { ...state, path: [], destination, activity: ROOM_SPOTS[destination].activity };
  return { ...state, path: route, destination, activity: `走向${ROOM_SPOTS[destination].label}` };
}

export function advanceRoomMotion(state: RoomMotion): RoomMotion {
  if (!state.path.length) return state;
  const [next, ...rest] = state.path;
  if (!isWalkable(next) || Math.abs(next.col - state.position.col) + Math.abs(next.row - state.position.row) !== 1) {
    return { ...state, path: [], destination: null, activity: '这条路暂时走不通' };
  }
  return {
    ...state,
    position: next,
    path: rest,
    activity: rest.length === 0 && state.destination ? ROOM_SPOTS[state.destination].activity : state.activity,
  };
}

export function parseSavedRoomPoint(raw: string | null): RoomPoint {
  if (!raw) return ROOM_START;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && 'col' in value && 'row' in value) {
      const point = value as RoomPoint;
      if (Number.isInteger(point.col) && Number.isInteger(point.row) && isWalkable(point)) return point;
    }
  } catch { /* Old or corrupt state falls back to the door. */ }
  return ROOM_START;
}
