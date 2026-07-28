// ─── server/accounts.js ───────────────────────────────────────────────────────
// Firebase-based account storage using Realtime Database

import { db } from './firebase.js';

// ── Public API ────────────────────────────────────────────────────────────────

/** Get player stats from Firebase Realtime Database */
export async function getById(uid) {
  try {
    const snapshot = await db.ref(`players/${uid}`).once('value');
    const data = snapshot.val();
    if (!data) return null;
    return {
      id: uid,
      username: data.username,
      totalKills: data.totalKills || 0,
      createdAt: data.createdAt
    };
  } catch (error) {
    console.error('Error fetching player:', error.message);
    return null;
  }
}

/** Increment total kills for player */
export async function incrementKills(uid) {
  if (!uid) return 0;
  try {
    const ref = db.ref(`players/${uid}/totalKills`);
    await ref.transaction((current) => (current || 0) + 1);
    const snapshot = await ref.once('value');
    return snapshot.val() || 0;
  } catch (error) {
    console.error('Error incrementing kills:', error.message);
    return 0;
  }
}

/** Create or update player record (called after Firebase Auth registration) */
export async function createPlayer(uid, username) {
  try {
    await db.ref(`players/${uid}`).set({
      username,
      totalKills: 0,
      createdAt: Date.now()
    });
    return { success: true };
  } catch (error) {
    console.error('Error creating player:', error.message);
    return { error: 'Failed to create player record' };
  }
}

