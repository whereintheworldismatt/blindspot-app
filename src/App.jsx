import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ref, onValue, runTransaction } from 'firebase/database';
import { db } from './firebase';
import { MapContainer, TileLayer, Marker, Polyline, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// ============================================================
// BLINDSPOT - Real life GeoGuessr
// ============================================================
// Game flow:
// 1. Host creates a room, players join with a code
// 2. Each round, one player is the "Driver" - everyone else is "blindfolded"
// 3. Driver hits "We're here" - captures GPS as true location
// 4. Timer starts, everyone (incl. driver) drops a pin guessing location
// 5. Reveal: show true location, everyone's pins, distances, award points
// 6. Rotate driver, repeat
//
// Scoring (convex falloff, max 100 per round, no elimination):
//   Guesser points = 100 within 25ft of the true spot, then falls off toward
//                     0 at 2 miles using a convex curve (exponent 0.4) -
//                     steep drop near zero, more spread preserved near 100
//   Driver points  = 100 - average(guesser points), so a stumped group gives
//                     the driver a high score; plus a flat +50 stump bonus
//                     if the average guess distance is over 1 mile
//
// REAL-TIME SYNC:
// Room state lives in Firebase Realtime Database at /rooms/<roomCode>.
// All players subscribe to the same room and read/write through it, so
// everyone's phone stays in sync. `update(fn)` runs a transaction so
// concurrent writes from multiple phones don't clobber each other.
// ============================================================

const METERS_PER_MILE = 1609.344;
const METERS_PER_FOOT = 0.3048;

const SCORING = {
  TOLERANCE_FT: 25,        // distances within this count as a perfect 100
  CUTOFF_MILES: 2,         // distance at which guesser score hits 0
  CURVE_EXPONENT: 0.4,     // <1 = convex: steep drop near zero, granular near 100
  MAX_SCORE: 100,          // perfect guesser score
  STUMP_THRESHOLD_MILES: 1, // avg distance needed for driver stump bonus
  STUMP_BONUS: 50,
  ROUND_TIME: 90,          // seconds to guess
};

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function formatDistance(m) {
  const miles = m / METERS_PER_MILE;
  if (miles < 0.1) {
    const feet = m / METERS_PER_FOOT;
    return `${Math.round(feet)} ft`;
  }
  return `${miles.toFixed(2)} mi`;
}

// Guesser score: perfect (100) within TOLERANCE_FT, then a convex falloff
// (CURVE_EXPONENT < 1) to 0 at CUTOFF_MILES. Convex = steep drop near zero,
// more granularity preserved near the top.
function calcGuesserPoints(distM) {
  const toleranceM = SCORING.TOLERANCE_FT * METERS_PER_FOOT;
  const cutoffM = SCORING.CUTOFF_MILES * METERS_PER_MILE;
  const effective = Math.max(0, distM - toleranceM);
  const normalized = Math.min(1, effective / (cutoffM - toleranceM));
  const score = SCORING.MAX_SCORE * (1 - Math.pow(normalized, SCORING.CURVE_EXPONENT));
  return Math.round(score);
}

// Driver score: invert the average guesser score (everyone nails it -> driver
// gets ~0; everyone's lost -> driver gets ~100), plus a flat stump bonus if
// the average guess distance exceeds STUMP_THRESHOLD_MILES.
function calcDriverPoints(avgGuesserScore, avgDistM) {
  let pts = SCORING.MAX_SCORE - avgGuesserScore;
  const stumpThresholdM = SCORING.STUMP_THRESHOLD_MILES * METERS_PER_MILE;
  if (avgDistM >= stumpThresholdM) pts += SCORING.STUMP_BONUS;
  return Math.round(pts);
}

// ============================================================
// Firebase-backed room sync
// ============================================================
// Each room lives at /rooms/<roomCode> in the Realtime Database.
// `update(fn)` runs a transaction: it reads the current room data,
// lets the caller mutate it in place (same pattern as before), and
// writes the result back atomically - this keeps multiple phones
// from stomping on each other's writes.
function useFirebaseRoom(roomCode, playerId, playerName) {
  const [room, setRoom] = useState(null);

  // Subscribe to the room and keep local state in sync
  useEffect(() => {
    if (!roomCode) return;

    const roomRef = ref(db, `rooms/${roomCode}`);
    const unsubscribe = onValue(roomRef, (snapshot) => {
      const data = snapshot.val();
      if (data === null) {
        setRoom(null);
        return;
      }
      // Firebase prunes empty objects/arrays to null - normalize back to
      // safe defaults so the rest of the app can rely on these always existing.
      setRoom({
        ...data,
        players: data.players || {},
        guesses: data.guesses || {},
        driverOrder: data.driverOrder || [],
      });
    });

    return () => unsubscribe();
  }, [roomCode]);

  // Join the room: create it if it doesn't exist, add this player if new
  useEffect(() => {
    if (!roomCode || !playerName) return;

    const roomRef = ref(db, `rooms/${roomCode}`);
    runTransaction(roomRef, (current) => {
      if (current === null) {
        return {
          code: roomCode,
          players: {
            [playerId]: { id: playerId, name: playerName, score: 0, willDrive: true },
          },
          driverOrder: [playerId],
          currentDriverIndex: 0,
          round: 0,
          phase: 'lobby',
          trueLocation: null,
          guesses: {},
          roundStartTime: null,
          gameMode: 'rotating',
          singleDriverId: null,
          totalRounds: 8,
        };
      }
      if (!current.players) current.players = {};
      if (!current.driverOrder) current.driverOrder = [];
      if (!current.players[playerId]) {
        current.players[playerId] = { id: playerId, name: playerName, score: 0, willDrive: true };
        current.driverOrder.push(playerId);
      }
      return current;
    });
  }, [roomCode, playerId, playerName]);

  const update = useCallback((fn) => {
    const roomRef = ref(db, `rooms/${roomCode}`);
    runTransaction(roomRef, (current) => {
      if (current === null) return current;
      if (!current.players) current.players = {};
      if (!current.guesses) current.guesses = {};
      if (!current.driverOrder) current.driverOrder = [];
      fn(current);
      return current;
    });
  }, [roomCode]);

  return { room, update };
}

// ============================================================
// Colors / Styles
// ============================================================
const COLORS = {
  navy: '#1A2238',
  navyLight: '#252E4A',
  cream: '#F2E8DC',
  orange: '#FF6B35',
  sage: '#7A9B76',
  crimson: '#D64545',
};

const styles = {
  screen: {
    minHeight: '100vh',
    background: COLORS.navy,
    color: COLORS.cream,
    fontFamily: 'system-ui, sans-serif',
    padding: '24px 20px 40px',
    maxWidth: '480px',
    margin: '0 auto',
    boxSizing: 'border-box',
  },
  brandBlock: { textAlign: 'center', marginBottom: '24px' },
  brandTitle: {
    fontFamily: 'system-ui, sans-serif',
    fontSize: '40px',
    fontWeight: 700,
    letterSpacing: '6px',
    margin: 0,
    color: COLORS.cream,
  },
  brandSub: {
    fontSize: '13px',
    letterSpacing: '2px',
    textTransform: 'uppercase',
    color: COLORS.orange,
    margin: '4px 0 0',
  },
  roomCodeDisplay: {
    fontFamily: 'system-ui, sans-serif',
    fontSize: '20px',
    letterSpacing: '4px',
    margin: '8px 0 0',
  },
  leaveLink: {
    background: 'none', border: 'none', color: '#9A9588', fontSize: '12px',
    textDecoration: 'underline', cursor: 'pointer', marginTop: '8px', padding: 0,
    fontFamily: 'system-ui, sans-serif',
  },
  gameMenuWrap: { position: 'relative' },
  gameMenuButton: {
    width: '36px', height: '36px', borderRadius: '50%', border: `1px solid ${COLORS.navyLight}`,
    background: COLORS.navyLight, color: COLORS.cream, fontSize: '18px', fontWeight: 700,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    lineHeight: 1, padding: 0,
  },
  gameMenuDropdown: {
    position: 'absolute', top: '44px', right: 0, background: COLORS.navyLight,
    border: `1px solid ${COLORS.navy}`, borderRadius: '10px', overflow: 'hidden',
    zIndex: 1100, minWidth: '160px', boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  },
  gameMenuItem: {
    display: 'block', width: '100%', textAlign: 'left', padding: '12px 16px',
    background: 'none', border: 'none', color: COLORS.cream, fontSize: '14px',
    fontFamily: 'system-ui, sans-serif', cursor: 'pointer', borderBottom: `1px solid ${COLORS.navy}`,
  },
  card: { background: COLORS.navyLight, borderRadius: '12px', padding: '20px', marginBottom: '16px' },
  rulesCard: { background: 'transparent', border: `1px solid ${COLORS.navyLight}`, borderRadius: '12px', padding: '20px' },
  sectionTitle: {
    fontFamily: 'system-ui, sans-serif',
    fontSize: '18px',
    fontWeight: 600,
    letterSpacing: '1px',
    textTransform: 'uppercase',
    margin: '0 0 12px',
    color: COLORS.cream,
  },
  label: { display: 'block', fontSize: '13px', color: '#B8B3A8', marginBottom: '6px', marginTop: '14px' },
  input: {
    width: '100%',
    padding: '12px 14px',
    borderRadius: '8px',
    border: `1px solid ${COLORS.navyLight}`,
    background: COLORS.navy,
    color: COLORS.cream,
    fontSize: '16px',
    boxSizing: 'border-box',
    outline: 'none',
  },
  primaryButton: {
    width: '100%',
    marginTop: '20px',
    padding: '16px',
    borderRadius: '10px',
    border: 'none',
    background: COLORS.orange,
    color: COLORS.navy,
    fontFamily: 'system-ui, sans-serif',
    fontSize: '16px',
    fontWeight: 700,
    letterSpacing: '1px',
    textTransform: 'uppercase',
    cursor: 'pointer',
  },
  secondaryButton: {
    width: '100%',
    marginTop: '10px',
    padding: '14px',
    borderRadius: '10px',
    border: `1px solid ${COLORS.cream}`,
    background: 'transparent',
    color: COLORS.cream,
    fontFamily: 'system-ui, sans-serif',
    fontSize: '14px',
    fontWeight: 600,
    letterSpacing: '1px',
    textTransform: 'uppercase',
    cursor: 'pointer',
  },
  hint: { fontSize: '13px', color: '#9A9588', textAlign: 'center', marginTop: '12px', lineHeight: 1.5 },
  errorText: { fontSize: '13px', color: COLORS.crimson, textAlign: 'center' },
  playerList: { display: 'flex', flexDirection: 'column', gap: '8px' },
  playerRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0' },
  playerAvatar: {
    width: '32px', height: '32px', borderRadius: '50%', background: COLORS.orange, color: COLORS.navy,
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '14px',
  },
  playerName: { flex: 1, fontSize: '15px' },
  modeRow: { display: 'flex', gap: '8px', marginBottom: '4px' },
  modeButton: {
    flex: 1, padding: '10px', borderRadius: '8px', border: `1px solid ${COLORS.navy}`,
    background: COLORS.navy, color: '#9A9588', fontFamily: 'system-ui, sans-serif',
    fontSize: '13px', fontWeight: 600, letterSpacing: '0.5px', textTransform: 'uppercase', cursor: 'pointer',
  },
  modeButtonActive: {
    flex: 1, padding: '10px', borderRadius: '8px', border: `1px solid ${COLORS.orange}`,
    background: COLORS.orange, color: COLORS.navy, fontFamily: 'system-ui, sans-serif',
    fontSize: '13px', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', cursor: 'pointer',
  },
  toggleOn: {
    fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px', color: COLORS.navy,
    background: COLORS.sage, border: `1px solid ${COLORS.sage}`, borderRadius: '6px',
    padding: '5px 10px', cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap',
  },
  toggleOff: {
    fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px', color: '#9A9588',
    background: 'transparent', border: '1px solid #5C5848', borderRadius: '6px',
    padding: '5px 10px', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap',
  },
  sliderRow: { display: 'flex', alignItems: 'center', gap: '12px' },
  slider: {
    flex: 1, height: '4px', borderRadius: '2px', background: COLORS.navy,
    accentColor: COLORS.orange, cursor: 'pointer',
  },
  sliderValue: {
    fontFamily: 'system-ui, sans-serif', fontSize: '20px', fontWeight: 700,
    color: COLORS.orange, minWidth: '32px', textAlign: 'right',
  },
  rulesList: { margin: 0, paddingLeft: '20px', fontSize: '14px', lineHeight: 1.8, color: '#D6D1C5' },
  roundBadge: {
    display: 'inline-block', fontFamily: 'system-ui, sans-serif', fontSize: '13px',
    letterSpacing: '2px', textTransform: 'uppercase', color: COLORS.orange,
    border: `1px solid ${COLORS.orange}`, borderRadius: '20px', padding: '4px 14px', marginBottom: '20px',
  },
  driverHero: { textAlign: 'center', padding: '20px 0', position: 'relative' },
  bigTitle: { fontFamily: 'system-ui, sans-serif', fontSize: '32px', fontWeight: 700, margin: '16px 0 12px', letterSpacing: '1px' },
  bodyText: { fontSize: '15px', lineHeight: 1.6, color: '#D6D1C5' },
  pulseRing: { width: '80px', height: '80px', borderRadius: '50%', border: `2px solid ${COLORS.cream}`, opacity: 0.2, margin: '24px auto 0' },
  guessHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '8px' },
  driverPill: {
    fontFamily: 'system-ui, sans-serif', fontSize: '13px', fontWeight: 600,
    background: COLORS.navyLight, color: COLORS.cream, borderRadius: '20px',
    padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '4px',
  },
  timerBadge: {
    fontFamily: 'system-ui, sans-serif', fontSize: '16px', fontWeight: 700, background: COLORS.navyLight,
    borderRadius: '20px', padding: '6px 16px', marginBottom: '20px', display: 'flex', alignItems: 'center',
  },
  timerUrgent: { color: COLORS.crimson, border: `1px solid ${COLORS.crimson}` },
  mapContainer: {
    width: '100%', aspectRatio: '1', background: '#0E1424', borderRadius: '12px',
    position: 'relative', overflow: 'hidden', marginBottom: '16px',
  },
  mapHintFloating: {
    position: 'absolute', bottom: '12px', left: '50%', transform: 'translateX(-50%)',
    background: 'rgba(26,34,56,0.85)', color: COLORS.cream, fontSize: '13px',
    padding: '6px 14px', borderRadius: '20px', zIndex: 1000, pointerEvents: 'none',
    whiteSpace: 'nowrap',
  },
  revealHero: { textAlign: 'center', marginBottom: '20px' },
  myResultCard: { background: COLORS.orange, color: COLORS.navy, borderRadius: '12px', padding: '20px', textAlign: 'center', marginBottom: '16px' },
  myResultLabel: { fontSize: '13px', textTransform: 'uppercase', letterSpacing: '1px', margin: 0 },
  myResultDistance: { fontFamily: 'system-ui, sans-serif', fontSize: '36px', fontWeight: 700, margin: '4px 0' },
  myResultPoints: { fontSize: '15px', fontWeight: 600, margin: 0 },
  resultRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0', borderBottom: `1px solid ${COLORS.navy}` },
  driverResultRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 0 0', marginTop: '4px' },
  resultRank: { fontFamily: 'system-ui, sans-serif', fontSize: '16px', fontWeight: 700, color: '#9A9588', width: '20px' },
  colorSwatch: { width: '14px', height: '14px', borderRadius: '50%', flexShrink: 0 },
  resultName: { fontSize: '15px', margin: 0, fontWeight: 500 },
  resultDist: { fontSize: '13px', color: '#9A9588', margin: '2px 0 0' },
  resultPoints: { fontFamily: 'system-ui, sans-serif', fontSize: '18px', fontWeight: 700, color: COLORS.sage },
  scoreRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0' },
  scoreTotal: { fontFamily: 'system-ui, sans-serif', fontSize: '20px', fontWeight: 700, color: COLORS.orange },
  devBanner: {
    background: COLORS.navyLight, border: `1px dashed ${COLORS.orange}`, borderRadius: '8px',
    padding: '10px 12px', fontSize: '12px', color: '#D6D1C5', marginBottom: '16px', lineHeight: 1.5,
  },
};

// ============================================================
// Components
// ============================================================

function JoinScreen({ onJoin }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('DEMO');

  return (
    <div style={styles.screen}>
      <div style={styles.brandBlock}>
        <h1 style={styles.brandTitle}>BLINDSPOT</h1>
        <p style={styles.brandSub}>the world is the board</p>
      </div>

      <div style={styles.devBanner}>
        Prototype mode: this demo runs entirely in your browser tab, so you're
        playing against yourself. The real version syncs across everyone's
        phones in real time. Try the "We're here" button - it uses your
        actual GPS!
      </div>

      <div style={styles.card}>
        <label style={styles.label}>Your name</label>
        <input
          style={styles.input}
          placeholder="What should we call you?"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={16}
        />

        <label style={styles.label}>Room code</label>
        <input
          style={{ ...styles.input, textTransform: 'uppercase', letterSpacing: '4px', fontFamily: 'system-ui, sans-serif', fontSize: '24px', textAlign: 'center' }}
          placeholder="ABCD"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))}
        />

        <button
          style={styles.primaryButton}
          disabled={!name.trim() || !code.trim()}
          onClick={() => onJoin(name.trim(), code.trim())}
        >
          Join / create room
        </button>
        <p style={styles.hint}>
          Same room code = same game. Everyone in the car uses the same code.
        </p>
      </div>
    </div>
  );
}

function Lobby({ room, playerId, update, onLeave }) {
  const players = Object.values(room.players);
  const gameMode = room.gameMode || 'rotating';
  const drivingPlayers = players.filter((p) => p.willDrive);

  const canStart =
    players.length >= 2 &&
    (gameMode === 'rotating' ? drivingPlayers.length >= 1 : !!room.singleDriverId);

  const startGame = () => {
    update((r) => {
      r.phase = 'driving';
      r.round = 1;
      if (r.gameMode === 'single') {
        // driverOrder is just the single driver, repeated forever
        r.driverOrder = [r.singleDriverId];
        r.currentDriverIndex = 0;
      } else {
        r.driverOrder = Object.values(r.players)
          .filter((p) => p.willDrive)
          .map((p) => p.id);
        r.currentDriverIndex = 0;
      }
    });
  };

  const addFakePlayer = () => {
    update((r) => {
      const fakeId = 'bot_' + Math.random().toString(36).slice(2, 7);
      const names = ['Sam', 'Jordan', 'Riley', 'Casey', 'Morgan'];
      const used = Object.values(r.players).map((p) => p.name);
      const name = names.find((n) => !used.includes(n)) || 'Guest';
      r.players[fakeId] = { id: fakeId, name, score: 0, willDrive: true };
      r.driverOrder.push(fakeId);
    });
  };

  const toggleWillDrive = (id) => {
    update((r) => {
      r.players[id].willDrive = !r.players[id].willDrive;
    });
  };

  const setGameMode = (mode) => {
    update((r) => {
      r.gameMode = mode;
      if (mode === 'single' && !r.singleDriverId) {
        r.singleDriverId = playerId;
      }
    });
  };

  const setSingleDriver = (id) => {
    update((r) => {
      r.singleDriverId = id;
    });
  };

  const setTotalRounds = (n) => {
    update((r) => {
      r.totalRounds = n;
    });
  };

  return (
    <div style={styles.screen}>
      <div style={styles.brandBlock}>
        <h1 style={styles.brandTitle}>BLINDSPOT</h1>
        <p style={styles.roomCodeDisplay}>Room <span style={{ color: COLORS.orange }}>{room.code}</span></p>
        <button style={styles.leaveLink} onClick={onLeave}>Leave room</button>
      </div>

      <div style={styles.card}>
        <h2 style={styles.sectionTitle}>Game mode</h2>
        <div style={styles.modeRow}>
          <button
            style={gameMode === 'rotating' ? styles.modeButtonActive : styles.modeButton}
            onClick={() => setGameMode('rotating')}
          >
            Rotating drivers
          </button>
          <button
            style={gameMode === 'single' ? styles.modeButtonActive : styles.modeButton}
            onClick={() => setGameMode('single')}
          >
            One driver
          </button>
        </div>
        <p style={styles.hint}>
          {gameMode === 'rotating'
            ? 'Everyone who opts in below takes turns driving.'
            : 'One person drives every round. Everyone else always guesses.'}
        </p>
      </div>

      <div style={styles.card}>
        <h2 style={styles.sectionTitle}>Number of rounds</h2>
        <div style={styles.sliderRow}>
          <input
            type="range"
            min="1"
            max="30"
            step="1"
            value={room.totalRounds || 8}
            onChange={(e) => setTotalRounds(Number(e.target.value))}
            style={styles.slider}
          />
          <span style={styles.sliderValue}>{room.totalRounds || 8}</span>
        </div>
        <p style={styles.hint}>The game ends after round {room.totalRounds || 8}.</p>
      </div>

      <div style={styles.card}>
        <h2 style={styles.sectionTitle}>Players in the car</h2>
        <div style={styles.playerList}>
          {players.map((p, i) => (
            <div key={p.id} style={styles.playerRow}>
              <div style={styles.playerAvatar}>{(p.name || '?')[0].toUpperCase()}</div>
              <span style={styles.playerName}>{p.name}{p.id === playerId ? ' (you)' : ''}</span>

              {gameMode === 'rotating' ? (
                <button
                  style={p.willDrive ? styles.toggleOn : styles.toggleOff}
                  onClick={() => toggleWillDrive(p.id)}
                >
                  {p.willDrive ? 'Will drive' : "Won't drive"}
                </button>
              ) : (
                <button
                  style={room.singleDriverId === p.id ? styles.toggleOn : styles.toggleOff}
                  onClick={() => setSingleDriver(p.id)}
                >
                  {room.singleDriverId === p.id ? 'Driver' : 'Set as driver'}
                </button>
              )}
            </div>
          ))}
        </div>

        {players.length < 2 && (
          <p style={styles.hint}>Add a few players to try a full round (or invite friends to join with code <strong>{room.code}</strong> on the real version).</p>
        )}

        {gameMode === 'rotating' && drivingPlayers.length === 0 && players.length >= 2 && (
          <p style={styles.errorText}>At least one person needs to opt in to drive.</p>
        )}

        {gameMode === 'rotating' && drivingPlayers.length > 0 && (
          <p style={styles.hint}>
            First up to drive: <strong style={{ color: COLORS.orange }}>{drivingPlayers[0].name}</strong>
          </p>
        )}

        {gameMode === 'single' && room.singleDriverId && (
          <p style={styles.hint}>
            Driving every round: <strong style={{ color: COLORS.orange }}>{room.players[room.singleDriverId]?.name}</strong>
          </p>
        )}

        <button style={styles.secondaryButton} onClick={addFakePlayer}>
          + Add a demo player
        </button>

        {canStart && (
          <button style={styles.primaryButton} onClick={startGame}>
            Start game ({players.length} players)
          </button>
        )}
      </div>

      <div style={styles.rulesCard}>
        <h2 style={styles.sectionTitle}>How it works</h2>
        <ol style={styles.rulesList}>
          <li>One person drives, everyone else gets blindfolded</li>
          <li>Driver finds a spot and taps "We're here," then waits</li>
          <li>Everyone else guesses where they are on the map</li>
          <li>Closer guesses = more points. Driver scores big if everyone's far off</li>
          {gameMode === 'rotating'
            ? <li>Rotate driver and go again</li>
            : <li>Same driver every round</li>}
        </ol>
      </div>
    </div>
  );
}

// Small "..." menu shown during active gameplay, offering a way to end
// the game early (jumps to final scores) or leave the room entirely.
function GameMenu({ room, update, onLeave }) {
  const [open, setOpen] = useState(false);

  const endGameNow = () => {
    update((r) => {
      r.totalRounds = r.round;
      r.phase = 'reveal';
    });
    setOpen(false);
  };

  // "End game now" jumps straight to the reveal/scoring screen, which
  // needs a trueLocation and guesses to score against - only offer this
  // once those exist (i.e. during the guessing phase).
  const canEndNow = room.phase === 'guessing';

  return (
    <div style={styles.gameMenuWrap}>
      <button style={styles.gameMenuButton} onClick={() => setOpen((o) => !o)} aria-label="Game menu">
        ⋯
      </button>
      {open && (
        <div style={styles.gameMenuDropdown}>
          {canEndNow && <button style={styles.gameMenuItem} onClick={endGameNow}>End game now</button>}
          <button style={{ ...styles.gameMenuItem, color: COLORS.crimson }} onClick={onLeave}>Leave room</button>
          <button style={styles.gameMenuItem} onClick={() => setOpen(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function DrivingScreen({ room, playerId, update, onLeave }) {
  const currentDriverId = room.driverOrder[room.currentDriverIndex];
  const isDriver = currentDriverId === playerId;
  const driver = room.players[currentDriverId];
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState(null);

  const handleWereHere = () => {
    setLocating(true);
    setError(null);

    if (!navigator.geolocation) {
      setError('GPS is not available in this browser. Try on your phone.');
      setLocating(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        update((r) => {
          r.trueLocation = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          };
          r.phase = 'guessing';
          r.roundStartTime = Date.now();
          r.guesses = {};
        });
        setLocating(false);
      },
      (err) => {
        setError('Could not get GPS location. Check location permissions and try again.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  };

  // Skip GPS for non-drivers playing solo in this demo
  const skipForDemo = () => {
    update((r) => {
      r.trueLocation = { lat: 40.0150, lng: -105.2705, accuracy: 10 }; // Boulder, CO
      r.phase = 'guessing';
      r.roundStartTime = Date.now();
      r.guesses = {};
    });
  };

  return (
    <div style={styles.screen}>
      <div style={styles.guessHeader}>
        <div style={styles.roundBadge}>Round {room.round} / {room.totalRounds || 8}</div>
        <div style={styles.driverPill}>
          <span aria-hidden="true">🚗 </span>
          {isDriver ? 'You are driving' : `${driver?.name} is driving`}
        </div>
        <GameMenu room={room} update={update} onLeave={onLeave} />
      </div>

      {isDriver ? (
        <>
          <div style={styles.driverHero}>
            <div style={{ fontSize: '64px', color: COLORS.orange, lineHeight: 1 }} aria-hidden="true">🚗</div>
            <h1 style={styles.bigTitle}>You're driving</h1>
            <p style={styles.bodyText}>
              Find a tricky spot. When everyone's out of the car and ready to guess, tap below.
              This locks in your current GPS position as the target.
            </p>
          </div>
          {error && <p style={styles.errorText}>{error}</p>}
          <button style={styles.primaryButton} onClick={handleWereHere} disabled={locating}>
            {locating ? 'Getting location...' : "We're here - lock it in"}
          </button>
          <button style={styles.secondaryButton} onClick={skipForDemo}>
            Skip GPS (use demo location)
          </button>
        </>
      ) : (
        <div style={styles.driverHero}>
          <div style={{ fontSize: '64px', color: COLORS.cream, lineHeight: 1 }} aria-hidden="true">🙈</div>
          <h1 style={styles.bigTitle}>Blindfolds on</h1>
          <p style={styles.bodyText}>
            <strong>{driver?.name}</strong> is driving you somewhere. Sit back, stay blindfolded,
            and wait until they say it's time to guess.
          </p>
          <div style={styles.pulseRing} />
        </div>
      )}
    </div>
  );
}

// ============================================================
// Map helpers (Leaflet)
// ============================================================

// Build a simple emoji-based divIcon so we don't need Leaflet's default
// marker image assets (which need extra bundler config to load correctly).
function makeDivIcon(html, size = 32, anchorRatio = 0.9) {
  return L.divIcon({
    html,
    className: 'blindspot-marker',
    iconSize: [size, size],
    iconAnchor: [size / 2, size * anchorRatio],
  });
}

// Distinct, high-contrast colors for player pins. Assigned by hashing the
// player's id, so each person gets a consistent color across the round.
const PIN_COLORS = ['#FF6B35', '#4A9DFF', '#7A9B76', '#E0C341', '#C77DFF', '#42D6C4', '#FF7AB6', '#9BD15B'];

function colorForPlayer(playerId) {
  let hash = 0;
  for (let i = 0; i < playerId.length; i++) {
    hash = (hash * 31 + playerId.charCodeAt(i)) >>> 0;
  }
  return PIN_COLORS[hash % PIN_COLORS.length];
}

// A teardrop pin in a given color, used for player guesses. Memoized since
// divIcon objects are cheap to reuse and this gets called in render loops.
const _pinIconCache = new Map();
function pinIcon(color, size = 34) {
  const key = `${color}_${size}`;
  if (_pinIconCache.has(key)) return _pinIconCache.get(key);
  const svg = `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 0C7.6 0 4 3.6 4 8c0 5.4 6.6 14.8 7.3 15.7.3.4.9.4 1.2 0C13.4 22.8 20 13.4 20 8c0-4.4-3.6-8-8-8z"
            fill="${color}" stroke="${COLORS.navy}" stroke-width="1.2"/>
      <circle cx="12" cy="8" r="3" fill="${COLORS.navy}"/>
    </svg>`;
  const icon = makeDivIcon(svg, size, 0.97);
  _pinIconCache.set(key, icon);
  return icon;
}

// The true location: a bullseye/target, visually distinct from any pin so
// it's never confused with a player's guess.
const TRUE_LOCATION_ICON = makeDivIcon(`
  <svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
    <circle cx="20" cy="20" r="17" fill="${COLORS.crimson}" fill-opacity="0.18" stroke="${COLORS.crimson}" stroke-width="2"/>
    <circle cx="20" cy="20" r="9" fill="${COLORS.crimson}" fill-opacity="0.35" stroke="${COLORS.crimson}" stroke-width="2"/>
    <circle cx="20" cy="20" r="3" fill="${COLORS.crimson}"/>
  </svg>`, 40, 0.5);

// Pick a random offset point near the true location so the initial map
// view isn't centered exactly on the answer (which would make guessing
// trivial). Offsets up to ~0.6 miles in a random direction.
function randomNearbyPoint(lat, lng) {
  const maxOffsetMeters = 950; // ~0.6 miles
  const angle = Math.random() * 2 * Math.PI;
  const dist = Math.random() * maxOffsetMeters;
  const dLat = (dist * Math.cos(angle)) / 111320; // meters per degree latitude
  const dLng = (dist * Math.sin(angle)) / (111320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lng: lng + dLng };
}

// Handles map clicks/taps to drop a guess pin
function MapClickHandler({ onPick, disabled }) {
  useMapEvents({
    click(e) {
      if (disabled) return;
      onPick({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

// Guessing map: free pan/zoom, centered on a randomized nearby point
// (not the true location), lets the player tap to drop their pin.
// Leaflet sometimes measures its container before layout has fully
// settled (e.g. while fonts/images are still loading on mobile),
// resulting in a map that renders too small. Re-check the size shortly
// after mount and fix it up if needed.
function InvalidateSizeOnMount() {
  const map = useMap();
  useEffect(() => {
    const t1 = setTimeout(() => map.invalidateSize(), 100);
    const t2 = setTimeout(() => map.invalidateSize(), 400);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [map]);
  return null;
}

function GuessMap({ trueLocation, guessPos, onPick, disabled, playerId }) {
  const initialCenter = useRef(randomNearbyPoint(trueLocation.lat, trueLocation.lng));
  const myIcon = useRef(pinIcon(colorForPlayer(playerId))).current;

  return (
    <div style={styles.mapContainer}>
      <MapContainer
        center={[initialCenter.current.lat, initialCenter.current.lng]}
        zoom={14}
        style={{ width: '100%', height: '100%' }}
        attributionControl={false}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          subdomains={['a', 'b', 'c']}
        />
        <InvalidateSizeOnMount />
        <MapClickHandler onPick={onPick} disabled={disabled} />
        {guessPos && <Marker position={[guessPos.lat, guessPos.lng]} icon={myIcon} />}
      </MapContainer>
      {!guessPos && !disabled && <div style={styles.mapHintFloating}>Tap the map to drop your pin</div>}
    </div>
  );
}

// Fits the map view to show all given points with some padding
function FitBounds({ points }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView([points[0][0], points[0][1]], 14);
      return;
    }
    const bounds = L.latLngBounds(points);
    map.fitBounds(bounds, { padding: [40, 40] });
  }, [map, points]);
  return null;
}

// Reveal map: shows the true location, every guesser's pin, and a line
// from each guess to the true location.
function RevealMap({ trueLocation, results, playerId }) {
  const truePoint = [trueLocation.lat, trueLocation.lng];
  const allPoints = [truePoint];
  results.forEach((r) => {
    if (r.guess) allPoints.push([r.guess.lat, r.guess.lng]);
  });

  return (
    <div style={styles.mapContainer}>
      <MapContainer
        center={truePoint}
        zoom={14}
        style={{ width: '100%', height: '100%' }}
        attributionControl={false}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          subdomains={['a', 'b', 'c']}
        />
        <FitBounds points={allPoints} />
        <InvalidateSizeOnMount />
        <Marker position={truePoint} icon={TRUE_LOCATION_ICON} />
        {results.map((r) => {
          if (!r.guess) return null;
          const color = colorForPlayer(r.id);
          return (
            <React.Fragment key={r.id}>
              <Polyline
                positions={[[r.guess.lat, r.guess.lng], truePoint]}
                pathOptions={{ color, weight: 2, dashArray: '4 6' }}
              />
              <Marker
                position={[r.guess.lat, r.guess.lng]}
                icon={pinIcon(color, r.id === playerId ? 34 : 28)}
              />
            </React.Fragment>
          );
        })}
      </MapContainer>
    </div>
  );
}


function GuessingScreen({ room, playerId, update, onLeave }) {
  const [timeLeft, setTimeLeft] = useState(SCORING.ROUND_TIME);
  const [guessPos, setGuessPos] = useState(null);
  const hasGuessed = !!room.guesses[playerId];
  const currentDriverId = room.driverOrder[room.currentDriverIndex];
  const isDriver = currentDriverId === playerId;
  const players = Object.values(room.players);
  const guessCount = Object.keys(room.guesses).length;

  useEffect(() => {
    const tick = setInterval(() => {
      const elapsed = (Date.now() - room.roundStartTime) / 1000;
      const remaining = Math.max(0, SCORING.ROUND_TIME - elapsed);
      setTimeLeft(Math.ceil(remaining));
      if (remaining <= 0) clearInterval(tick);
    }, 250);
    return () => clearInterval(tick);
  }, [room.roundStartTime]);

  useEffect(() => {
    if (timeLeft <= 0 && room.phase === 'guessing') {
      update((r) => {
        r.phase = 'reveal';
      });
    }
  }, [timeLeft, room.phase, update]);

  const guessers = players.filter((p) => p.id !== currentDriverId);

  const submitGuess = () => {
    if (!guessPos) return;
    update((r) => {
      r.guesses[playerId] = guessPos;
      const driverIdNow = r.driverOrder[r.currentDriverIndex];
      const guesserIds = Object.values(r.players).filter((p) => p.id !== driverIdNow).map((p) => p.id);
      const allGuessed = guesserIds.every((id) => r.guesses[id]);
      if (allGuessed) {
        r.phase = 'reveal';
      }
    });
  };

  return (
    <div style={styles.screen}>
      <div style={styles.guessHeader}>
        <div style={styles.roundBadge}>Round {room.round} / {room.totalRounds || 8}</div>
        <div style={{ ...styles.timerBadge, ...(timeLeft <= 15 ? styles.timerUrgent : {}) }}>
          <span aria-hidden="true">⏱ </span>{timeLeft}s
        </div>
        <GameMenu room={room} update={update} onLeave={onLeave} />
      </div>

      {isDriver ? (
        <div style={styles.driverHero}>
          <div style={{ fontSize: '64px', color: COLORS.orange, lineHeight: 1 }} aria-hidden="true">🚗</div>
          <h1 style={styles.bigTitle}>Round in progress</h1>
          <p style={styles.bodyText}>
            Everyone else is guessing where you brought them. Sit tight - the reveal happens
            once everyone's locked in a pin or the timer runs out.
          </p>
          <p style={styles.hint}>{guessCount} / {guessers.length} players have guessed</p>
        </div>
      ) : (
        <>
          <h2 style={styles.sectionTitle}>Drop your pin - where are you?</h2>

          <GuessMap
            trueLocation={room.trueLocation}
            guessPos={guessPos}
            onPick={hasGuessed ? () => {} : setGuessPos}
            disabled={hasGuessed}
            playerId={playerId}
          />

          {hasGuessed && (
            <p style={{ ...styles.hint, color: COLORS.sage, fontWeight: 600 }}>✓ Pin locked in</p>
          )}

          <button
            style={{ ...styles.primaryButton, opacity: (!guessPos || hasGuessed) ? 0.5 : 1 }}
            disabled={!guessPos || hasGuessed}
            onClick={submitGuess}
          >
            {hasGuessed ? 'Waiting for others...' : 'Lock in this guess'}
          </button>

          <p style={styles.hint}>{guessCount} / {guessers.length} players have guessed</p>
        </>
      )}
    </div>
  );
}


function RevealScreen({ room, playerId, update, onLeave }) {
  const players = Object.values(room.players);
  const currentDriverId = room.driverOrder[room.currentDriverIndex];
  const driver = room.players[currentDriverId];

  const resultsRef = useRef(null);
  if (!resultsRef.current) {
    const guesserPlayers = players.filter((p) => p.id !== currentDriverId);
    const results = guesserPlayers.map((p) => {
      const guess = room.guesses[p.id];
      if (!guess) return { ...p, distance: null, points: 0, guess: null };
      const dist = distanceMeters(guess.lat, guess.lng, room.trueLocation.lat, room.trueLocation.lng);
      return { ...p, distance: dist, points: calcGuesserPoints(dist), guess };
    });

    const validResults = results.filter((r) => r.distance !== null);
    const validDistances = validResults.map((r) => r.distance);
    const validScores = validResults.map((r) => r.points);
    const avgDistance = validDistances.length
      ? validDistances.reduce((a, b) => a + b, 0) / validDistances.length
      : 0;
    const avgGuesserScore = validScores.length
      ? validScores.reduce((a, b) => a + b, 0) / validScores.length
      : 0;
    const driverPoints = calcDriverPoints(avgGuesserScore, avgDistance);

    resultsRef.current = { results, avgDistance, driverPoints };
  }

  const { results, avgDistance, driverPoints } = resultsRef.current;
  const sortedResults = [...results].sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  const stumped = avgDistance >= SCORING.STUMP_THRESHOLD_MILES * METERS_PER_MILE;

  const [applied, setApplied] = useState(false);

  useEffect(() => {
    if (applied) return;
    update((r) => {
      // Only apply scoring once per round, even though every player's
      // client runs this effect - the first one to commit wins, and the
      // scoredRound marker (checked inside this same transaction) stops
      // every other client from double-applying the same points.
      if (r.scoredRound === r.round) return;
      r.scoredRound = r.round;
      results.forEach((res) => {
        if (r.players[res.id]) r.players[res.id].score += res.points;
      });
      if (r.players[currentDriverId]) r.players[currentDriverId].score += driverPoints;
    });
    setApplied(true);
  }, [applied, results, update, currentDriverId, driverPoints, room.round]);

  const nextRound = () => {
    update((r) => {
      r.round += 1;
      r.currentDriverIndex = (r.currentDriverIndex + 1) % r.driverOrder.length;
      r.phase = 'driving';
      r.trueLocation = null;
      r.guesses = {};
    });
  };

  const myResult = results.find((r) => r.id === playerId);
  const totalRounds = room.totalRounds || 8;
  const isFinalRound = room.round >= totalRounds;

  const playAgain = () => {
    update((r) => {
      Object.values(r.players).forEach((p) => { p.score = 0; });
      r.round = 1;
      r.currentDriverIndex = 0;
      r.phase = 'driving';
      r.trueLocation = null;
      r.guesses = {};
      r.scoredRound = null;
    });
  };

  const sortedScores = Object.values(room.players).sort((a, b) => b.score - a.score);
  const winner = sortedScores[0];

  return (
    <div style={styles.screen}>
      <div style={styles.roundBadge}>
        {isFinalRound ? `Final round (${room.round} / ${totalRounds}) - reveal` : `Round ${room.round} / ${totalRounds} - reveal`}
      </div>

      <div style={styles.revealHero}>
        <div style={{ fontSize: '40px', color: COLORS.crimson, lineHeight: 1 }} aria-hidden="true">📍</div>
        <h1 style={styles.bigTitle}>Here's where you were</h1>
      </div>

      <RevealMap trueLocation={room.trueLocation} results={results} playerId={playerId} />

      {myResult && myResult.distance !== null && (
        <div style={styles.myResultCard}>
          <p style={styles.myResultLabel}>Your guess was off by</p>
          <p style={styles.myResultDistance}>{formatDistance(myResult.distance)}</p>
          <p style={styles.myResultPoints}>+{myResult.points} points</p>
        </div>
      )}

      <div style={styles.card}>
        <h2 style={styles.sectionTitle}>Round results</h2>
        {sortedResults.map((r, i) => (
          <div key={r.id} style={styles.resultRow}>
            <span style={styles.resultRank}>{i + 1}</span>
            <div style={{ ...styles.colorSwatch, background: colorForPlayer(r.id) }} aria-hidden="true" />
            <div style={{ flex: 1 }}>
              <p style={styles.resultName}>{r.name}{r.id === playerId ? ' (you)' : ''}</p>
              <p style={styles.resultDist}>{r.distance !== null ? formatDistance(r.distance) : 'no guess'}</p>
            </div>
            <span style={styles.resultPoints}>+{r.points}</span>
          </div>
        ))}

        <div style={styles.driverResultRow}>
          <div style={{ fontSize: '20px', color: COLORS.orange, lineHeight: 1 }} aria-hidden="true">🚗</div>
          <div style={{ flex: 1 }}>
            <p style={styles.resultName}>{driver?.name} drove this round</p>
            <p style={styles.resultDist}>
              Avg distance off: {formatDistance(avgDistance)}
              {stumped && <span style={{ color: COLORS.crimson, fontWeight: 500 }}> - Stumped everyone!</span>}
            </p>
          </div>
          <span style={styles.resultPoints}>+{driverPoints}</span>
        </div>
      </div>

      <div style={styles.card}>
        <h2 style={styles.sectionTitle}>{isFinalRound ? 'Final scores' : 'Total scores'}</h2>
        {sortedScores.map((p, i) => (
          <div key={p.id} style={styles.scoreRow}>
            <span style={styles.resultRank}>{i + 1}</span>
            <span style={{ flex: 1 }}>{p.name}{p.id === playerId ? ' (you)' : ''}</span>
            <span style={styles.scoreTotal}>{p.score}</span>
          </div>
        ))}
      </div>

      {isFinalRound ? (
        <>
          <div style={styles.myResultCard}>
            <p style={styles.myResultLabel}>Winner</p>
            <p style={{ ...styles.myResultDistance, fontSize: '28px' }}>{winner?.name}</p>
            <p style={styles.myResultPoints}>{winner?.score} points</p>
          </div>
          <button style={styles.primaryButton} onClick={playAgain}>
            Play again
          </button>
          <button style={styles.secondaryButton} onClick={onLeave}>
            Exit to main menu
          </button>
        </>
      ) : (
        <>
          <button style={styles.primaryButton} onClick={nextRound}>
            {room.gameMode === 'single'
              ? `Next round - ${driver?.name} drives again`
              : `Next driver: ${room.players[room.driverOrder[(room.currentDriverIndex + 1) % room.driverOrder.length]]?.name}`}
          </button>
          <button style={styles.secondaryButton} onClick={onLeave}>
            Exit to main menu
          </button>
        </>
      )}
    </div>
  );
}

// ============================================================
// Main App
// ============================================================
export default function App() {
  const [joined, setJoined] = useState(() => {
    try {
      return !!(window.localStorage.getItem('blindspot_name') && window.localStorage.getItem('blindspot_room'));
    } catch {
      return false;
    }
  });
  const [playerName, setPlayerName] = useState(() => {
    try { return window.localStorage.getItem('blindspot_name') || ''; } catch { return ''; }
  });
  const [roomCode, setRoomCode] = useState(() => {
    try { return window.localStorage.getItem('blindspot_room') || ''; } catch { return ''; }
  });
  const [playerId] = useState(() => {
    try {
      const stored = window.localStorage.getItem('blindspot_player_id');
      if (stored) return stored;
      const fresh = 'p_' + Math.random().toString(36).slice(2, 9);
      window.localStorage.setItem('blindspot_player_id', fresh);
      return fresh;
    } catch {
      return 'p_' + Math.random().toString(36).slice(2, 9);
    }
  });

  const { room, update } = useFirebaseRoom(roomCode, playerId, playerName);

  const handleJoin = (name, code) => {
    setPlayerName(name);
    setRoomCode(code);
    setJoined(true);
    try {
      window.localStorage.setItem('blindspot_name', name);
      window.localStorage.setItem('blindspot_room', code);
    } catch {
      // localStorage unavailable - not critical, just won't survive a refresh
    }
  };

  const handleLeave = () => {
    setJoined(false);
    setRoomCode('');
    try {
      window.localStorage.removeItem('blindspot_room');
    } catch {
      // not critical
    }
  };

  if (!joined || !room) {
    return <JoinScreen onJoin={handleJoin} />;
  }

  switch (room.phase) {
    case 'lobby': return <Lobby room={room} playerId={playerId} update={update} onLeave={handleLeave} />;
    case 'driving': return <DrivingScreen room={room} playerId={playerId} update={update} onLeave={handleLeave} />;
    case 'guessing': return <GuessingScreen room={room} playerId={playerId} update={update} onLeave={handleLeave} />;
    case 'reveal': return <RevealScreen room={room} playerId={playerId} update={update} onLeave={handleLeave} />;
    default: return <Lobby room={room} playerId={playerId} update={update} onLeave={handleLeave} />;
  }
}
