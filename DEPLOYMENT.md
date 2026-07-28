# Firebase + Render Deployment Guide

This guide shows you how to deploy the game with Firebase Authentication and Realtime Database for secure account management.

## Step 1: Set Up Firebase Project

### 1.1 Create Firebase Project

1. Go to https://console.firebase.google.com
2. Click **"Add project"**
3. Enter a project name (e.g., `fps-multiplayer-game`)
4. **Disable Google Analytics** (not needed for this project)
5. Click **"Create project"**

### 1.2 Enable Authentication

1. In Firebase Console, go to **Build** → **Authentication**
2. Click **"Get started"**
3. Select **Email/Password** sign-in provider
4. Click **"Enable"**
5. Click **"Save"**

### 1.3 Enable Realtime Database

1. In Firebase Console, go to **Build** → **Realtime Database**
2. Click **"Create database"**
3. Select a location (choose closest to your players)
4. Select **"Start in test mode"** (we'll add security rules next)
5. Click **"Enable"**

### 1.4 Set Up Security Rules

1. In Realtime Database, go to **Rules** tab
2. Replace the rules with the content from `firebase-rules.json`:
   ```json
   {
     "rules": {
       ".read": false,
       ".write": false,
       "players": {
         "$uid": {
           ".read": "auth != null && auth.uid == $uid",
           ".write": "auth != null && auth.uid == $uid",
           "username": {
             ".validate": "newData.isString() && newData.val().length >= 3 && newData.val().length <= 20"
           },
           "totalKills": {
             ".validate": "newData.isNumber() && newData.val() >= 0"
           },
           "createdAt": {
             ".validate": "newData.isNumber()"
           }
         }
       }
     }
   }
   ```
3. Click **"Publish"**

### 1.5 Get Firebase Configuration

1. In Firebase Console, click **Project Settings** (gear icon)
2. Scroll down to **"Your apps"** section
3. Click **</>** (web icon) to add a web app
4. Enter app name: `fps-game`
5. **DO NOT** check "Also set up Firebase Hosting"
6. Click **"Register app"**
7. Copy the `firebaseConfig` object (you'll need this later)

### 1.6 Get Service Account Key

1. In Firebase Console, go to **Project Settings** → **Service Accounts**
2. Click **"Generate new private key"**
3. Click **"Generate key"**
4. Save the JSON file (keep it secure!)
5. Open the JSON file and copy these values:
   - `type`
   - `project_id`
   - `private_key_id`
   - `private_key`
   - `client_email`
   - `client_id`
   - `auth_uri`
   - `token_uri`
   - `auth_provider_x509_cert_url`
   - `client_x509_cert_url`

## Step 2: Configure Local Environment

### 2.1 Create .env File

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Fill in the `.env` file with your Firebase values:
   ```env
   FIREBASE_PROJECT_ID=your-project-id
   FIREBASE_PRIVATE_KEY_ID=your-private-key-id
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----\n"
   FIREBASE_CLIENT_EMAIL=your-service-account@your-project-id.iam.gserviceaccount.com
   FIREBASE_CLIENT_ID=your-client-id
   FIREBASE_CLIENT_X509_CERT_URL=https://www.googleapis.com/robot/v1/metadata/x509/your-service-account%40your-project-id.iam.gserviceaccount.com
   FIREBASE_DATABASE_URL=https://your-project-id-default-rtdb.firebaseio.com/
   PORT=3001
   ```

**Important**: The `FIREBASE_PRIVATE_KEY` must have `\n` characters preserved (copy exactly from the JSON file).

### 2.2 Update Frontend Firebase Config

Edit `src/firebase-config.js` and replace the placeholder values with your Firebase config from Step 1.5:

```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

### 2.3 Test Locally

```bash
npm install
npm start
```

Open http://localhost:3001 and try registering/logging in.

## Step 3: Deploy to Render

### 3.1 Push Code to GitHub

1. Create a GitHub repository
2. Push your code (excluding `.env` file - it's in `.gitignore`)
3. Make sure `.env.example` is included

### 3.2 Create Render Service

1. Go to https://render.com and create an account
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repository
4. Configure the service:
   - **Name**: `fps-multiplayer-game`
   - **Region**: Choose closest to your players
   - **Branch**: `main`
   - **Root Directory**: `game` (if your repo has the game in a subfolder)
   - **Runtime**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `node server/index.js`
   - **Instance Type**: `Free` (or paid for better performance)

### 3.3 Add Environment Variables

In Render's Environment section, add these variables:

```
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_PRIVATE_KEY_ID=your-private-key-id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=your-service-account@your-project-id.iam.gserviceaccount.com
FIREBASE_CLIENT_ID=your-client-id
FIREBASE_CLIENT_X509_CERT_URL=https://www.googleapis.com/robot/v1/metadata/x509/your-service-account%40your-project-id.iam.gserviceaccount.com
FIREBASE_DATABASE_URL=https://your-project-id-default-rtdb.firebaseio.com/
PORT=80
```

**Important**: For the private key, make sure `\n` characters are preserved in Render.

### 3.4 Deploy

Click **"Create Web Service"** and wait for deployment to complete.

### 3.5 Access Your Game

Render will provide a URL like: `https://fps-multiplayer-game.onrender.com`

Share this URL with your friends and they can play together!

## Security Features

### Firebase Authentication
- Passwords are securely hashed by Firebase
- No password storage on your server
- Built-in email verification (optional)
- Social login options available (Google, GitHub, etc.)

### Realtime Database Security Rules
- Players can only read/write their own data
- Username validation (3-20 characters)
- Kill count cannot be negative
- Server-side verification prevents tampering

### Server-Side Token Verification
- Every socket connection requires valid Firebase token
- Tokens are verified on every request
- Prevents unauthorized access

## Troubleshooting

### "Invalid Firebase token" error
- Check that Firebase environment variables are correct
- Verify the private key has proper `\n` characters
- Make sure Firebase Auth is enabled in console

### Database write errors
- Check Realtime Database security rules are published
- Verify database URL is correct in environment variables

### Frontend won't connect
- Check that Firebase config in `firebase-config.js` matches your project
- Verify API key is correct
- Check browser console for errors

## Cost

- **Render**: Free tier available (limited hours, sleeps when inactive)
- **Firebase**: Generous free tier for Auth and Realtime Database
- **Total**: Can run completely free for small player counts
