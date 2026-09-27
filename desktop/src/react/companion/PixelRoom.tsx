import { useEffect, useState } from 'react';
import { useStore } from '../stores';
import { sessionScopedValue } from '../stores/session-slice';
import { useI18n } from '../hooks/use-i18n';
import type { CompanionState } from '../components/right-workspace/companion-status';
import {
  ROOM_SPOTS, ROOM_TILES, advanceRoomMotion, initialRoomMotion, parseSavedRoomPoint, routeToRoomSpot,
  type RoomSpot,
} from './pixel-room';
import styles from './PixelRoom.module.css';

const STEP_MS = 230;

function getSavedPoint(key: string) {
  try { return parseSavedRoomPoint(localStorage.getItem(key)); }
  catch { return parseSavedRoomPoint(null); }
}

/** This room only changes its local presentation state. Sending a message remains an explicit user action. */
export function PixelRoom({ agentName, sessionPath, scopeKey, companionState }: {
  agentName: string;
  sessionPath: string;
  scopeKey: string;
  companionState: CompanionState;
}) {
  const { t } = useI18n();
  const storageKey = `hana:pixel-room:v1:${scopeKey}`;
  const [motion, setMotion] = useState(() => initialRoomMotion(getSavedPoint(storageKey)));
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!motion.path.length) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') setMotion(advanceRoomMotion);
    }, STEP_MS);
    return () => window.clearInterval(timer);
  }, [motion.path.length]);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(motion.position)); }
    catch { /* The room still works when browser storage is unavailable. */ }
  }, [motion.position, storageKey]);

  const select = (spot: RoomSpot) => {
    setNotice('');
    setMotion((current) => routeToRoomSpot(current, spot));
  };

  const compose = () => {
    const prompt = motion.destination && ROOM_SPOTS[motion.destination].prompt
      ? t(`companion.room.prompt.${motion.destination}`)
      : null;
    if (motion.path.length || !prompt) return;
    const state = useStore.getState();
    if (state.currentSessionPath !== sessionPath) return;
    if (sessionScopedValue(state, state.drafts, sessionPath)?.trim()) {
      setNotice(t('companion.room.draftExists'));
      state.requestInputFocus('gesture');
      return;
    }
    state.setDraft(sessionPath, prompt);
    state.requestInputFocus('gesture');
    setNotice(t('companion.room.draftReady'));
  };

  const prompt = motion.destination && !motion.path.length ? ROOM_SPOTS[motion.destination].prompt : null;
  const activity = motion.activity === '这条路暂时走不通'
    ? t('companion.room.blocked')
    : motion.path.length && motion.destination
      ? t('companion.room.walkingTo', { spot: t(`companion.room.spot.${motion.destination}`) })
      : motion.destination
        ? t(`companion.room.activity.${motion.destination}`)
        : t('companion.room.waiting');
  return (
    <div className={styles.room} aria-label={t('companion.room.ariaLabel')}>
      <div className={styles.map} style={{ gridTemplateColumns: `repeat(${ROOM_TILES[0].length}, 1fr)` }}>
        {ROOM_TILES.flatMap((row, rowIndex) => [...row].map((tile, colIndex) => {
          const spot: RoomSpot | null = tile === 'D' ? 'desk' : tile === 'S' ? 'sofa' : tile === 'E' ? 'door' : null;
          return spot ? (
            <button
              key={`${rowIndex}-${colIndex}`}
              type="button"
              className={`${styles.tile} ${styles[spot]}`}
              aria-label={t('companion.room.goTo', { spot: t(`companion.room.spot.${spot}`) })}
              title={t('companion.room.goTo', { spot: t(`companion.room.spot.${spot}`) })}
              onClick={() => select(spot)}
            >{spot === 'desk' ? '▣' : spot === 'sofa' ? '▤' : '▥'}</button>
          ) : <span key={`${rowIndex}-${colIndex}`} className={`${styles.tile} ${tile === '#' ? styles.wall : styles.floor}`} aria-hidden="true" />;
        }))}
        <div
          className={styles.character}
          data-state={companionState}
          aria-label={t('companion.room.characterStatus', { name: agentName, activity, status: t(`companion.status.${companionState}`) })}
          style={{ left: `${(motion.position.col + 0.5) * 10}%`, top: `${(motion.position.row + 0.5) * 12.5}%` }}
        >
          <span className={styles.hair} /><span className={styles.face} /><span className={styles.body} />
        </div>
      </div>
      <div className={styles.caption} role="status" aria-live="polite">
        <span>{t('companion.room.caption', { name: agentName, activity })}</span>
        {prompt && <button type="button" onClick={compose}>{t('companion.room.fillDraft')}</button>}
        {notice && <span>{notice}</span>}
      </div>
    </div>
  );
}
