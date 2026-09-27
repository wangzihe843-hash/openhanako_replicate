import { describe, expect, it } from 'vitest';
import {
  ROOM_START, ROOM_SPOTS, advanceRoomMotion, findRoomPath, initialRoomMotion,
  isWalkable, parseSavedRoomPoint, routeToRoomSpot,
} from '../desktop/src/react/companion/pixel-room';

describe('pixel room navigation and restoration', () => {
  it('routes around furniture and the partition without crossing blocked tiles', () => {
    const path = findRoomPath(ROOM_SPOTS.sofa.point, ROOM_SPOTS.desk.point);
    expect(path).not.toBeNull();
    let current = ROOM_SPOTS.sofa.point;
    for (const step of path || []) {
      expect(isWalkable(step)).toBe(true);
      expect(Math.abs(step.col - current.col) + Math.abs(step.row - current.row)).toBe(1);
      current = step;
    }
    expect(current).toEqual(ROOM_SPOTS.desk.point);
  });

  it('does not move when a route is blocked or corrupt', () => {
    const start = initialRoomMotion();
    const blocked = new Set(['1,5', '2,6']);
    expect(findRoomPath(ROOM_START, ROOM_SPOTS.sofa.point, blocked)).toBeNull();
    expect(advanceRoomMotion({ ...start, path: [{ col: 2, row: 2 }] })).toEqual({
      ...start, destination: null, activity: '这条路暂时走不通',
    });
    expect(findRoomPath(ROOM_START, { col: 2, row: 2 })).toBeNull();
  });

  it('resumes at the last valid tile after the room is remounted', () => {
    let motion = routeToRoomSpot(initialRoomMotion(), 'desk');
    motion = advanceRoomMotion(motion);
    const restored = parseSavedRoomPoint(JSON.stringify(motion.position));
    expect(initialRoomMotion(restored).position).toEqual(motion.position);
    expect(parseSavedRoomPoint('{bad')).toEqual(ROOM_START);
    expect(parseSavedRoomPoint(JSON.stringify({ col: 2, row: 2 }))).toEqual(ROOM_START);
  });
});
