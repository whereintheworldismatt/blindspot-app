import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

// Firebase config for the Blindspot project.
// This is safe to expose in client-side code - it's not a secret key,
// it just identifies which Firebase project to connect to. Access control
// is handled by the Realtime Database security rules.
const firebaseConfig = {
  apiKey: "AIzaSyBPwerH_j0V1ILh6EyPcPgWG4zs1S86qys",
  authDomain: "blindspot-66fa0.firebaseapp.com",
  databaseURL: "https://blindspot-66fa0-default-rtdb.firebaseio.com",
  projectId: "blindspot-66fa0",
  storageBucket: "blindspot-66fa0.firebasestorage.app",
  messagingSenderId: "348816493625",
  appId: "1:348816493625:web:640efdc0ea3014771791e8",
  measurementId: "G-GNT48XBRP0"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
