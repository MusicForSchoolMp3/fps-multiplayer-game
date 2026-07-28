// ─── src/firebase-config.js ──────────────────────────────────────────────────────
// Firebase client configuration

import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  onAuthStateChanged,
  signOut as firebaseSignOut 
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyCGra1gHODHQ6uUAdJxMyNAZl5KODpr30I",
  authDomain: "gungame-cea75.firebaseapp.com",
  databaseURL: "https://gungame-cea75-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "gungame-cea75",
  storageBucket: "gungame-cea75.firebasestorage.app",
  messagingSenderId: "456611439855",
  appId: "1:456611439855:web:a3a4e823820445c683a71a",
  measurementId: "G-HTZXZVKM00"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

export { 
  auth, 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  onAuthStateChanged,
  firebaseSignOut 
};
