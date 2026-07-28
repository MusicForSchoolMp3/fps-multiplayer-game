# Netlify Deployment Guide with Multiplayer Setup

This guide explains how to deploy your multiplayer FPS game to Netlify while keeping the multiplayer functionality working.

## Architecture Overview

Since Netlify is a static site hosting platform, you'll need:
- **Frontend (Client)**: Deployed to Netlify
- **Backend (Server)**: Deployed to a separate hosting service (Render, Railway, Heroku, or VPS)

## Step 1: Prepare for Production Build

### 1.1 Update SERVER_URL for Production

Edit `src/main.js` and change the SERVER_URL to use an environment variable:

```javascript
// Change line 18 from:
const SERVER_URL = `${location.protocol}//${location.hostname}:3001`;

// To:
const SERVER_URL = import.meta.env.VITE_SERVER_URL || `${location.protocol}//${location.hostname}:3001`;
```

### 1.2 Create Environment Variables

Create a `.env.production` file in your project root:

```
VITE_SERVER_URL=https://your-backend-server.com
```

Replace `your-backend-server.com` with your actual backend server URL.

## Step 2: Deploy Backend Server

Choose one of these options for your backend:

### Option A: Render (Free Tier Available)

1. Create a `render.yaml` file in your project root:

```yaml
services:
  - type: web
    name: fps-game-server
    env: node
    buildCommand: cd server && npm install
    startCommand: node server/index.js
    envVars:
      - key: PORT
        value: 3001
```

2. Push your code to GitHub
3. Go to [render.com](https://render.com) and sign up
4. Click "New +" → "Web Service"
5. Connect your GitHub repository
6. Use the `render.yaml` configuration or configure manually
7. Deploy and note your server URL (e.g., `https://fps-game-server.onrender.com`)

### Option B: Railway (Free Tier Available)

1. Go to [railway.app](https://railway.app) and sign up
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your repository
4. Railway will auto-detect Node.js
5. Set start command to: `node server/index.js`
6. Add environment variable: `PORT=3001`
7. Deploy and note your server URL

### Option C: Heroku (Free Tier Limited)

1. Install Heroku CLI: `npm install -g heroku`
2. Login: `heroku login`
3. Create app: `heroku create your-game-server`
4. Set buildpack: `heroku buildpacks:set heroku/nodejs`
5. Deploy: `git push heroku main`
6. Note your server URL: `https://your-game-server.herokuapp.com`

### Option D: VPS (DigitalOcean, Linode, etc.)

1. Rent a VPS (Ubuntu recommended)
2. SSH into your server
3. Install Node.js and npm
4. Clone your repository
5. Run: `cd server && npm install`
6. Use PM2 to keep server running: `npm install -g pm2 && pm2 start index.js`
7. Configure nginx as reverse proxy (optional but recommended)
8. Use your domain or server IP

## Step 3: Deploy Frontend to Netlify

### 3.1 Build the Project

```bash
npm run build
```

This creates a `dist/` folder with production-ready files.

### 3.2 Deploy via Netlify CLI

1. Install Netlify CLI:
```bash
npm install -g netlify-cli
```

2. Login to Netlify:
```bash
netlify login
```

3. Initialize your site:
```bash
netlify init
```

4. Deploy:
```bash
netlify deploy --prod
```

5. Set environment variable in Netlify dashboard:
   - Go to your site in Netlify
   - Navigate to Site Settings → Environment Variables
   - Add: `VITE_SERVER_URL` = `https://your-backend-server.com`

### 3.3 Alternative: Deploy via Git

1. Push your code to GitHub
2. Go to [netlify.com](https://netlify.com) and sign up
3. Click "Add new site" → "Import an existing project"
4. Connect your GitHub repository
5. Configure build settings:
   - Build command: `npm run build`
   - Publish directory: `dist`
6. Add environment variable: `VITE_SERVER_URL` = `https://your-backend-server.com`
7. Deploy

## Step 4: Update Client Configuration

After deploying both frontend and backend, update your `.env.production`:

```
VITE_SERVER_URL=https://your-actual-backend-url.com
```

Then rebuild and redeploy the frontend:

```bash
npm run build
netlify deploy --prod
```

## Step 5: Test Your Deployment

1. Visit your Netlify site URL
2. Try registering a new account
3. Try logging in
4. Test multiplayer by opening the site in multiple browser tabs
5. Test shooting, movement, and third-person view

## Important Notes

### CORS Configuration

Your backend server needs to allow CORS from your Netlify domain. Add this to `server/index.js`:

```javascript
app.use(cors({
  origin: ['https://your-netlify-site.netlify.app', 'http://localhost:3000'],
  credentials: true
}));
```

### WebSocket Configuration

Socket.io should work out of the box, but ensure your backend allows WebSocket connections. If using a reverse proxy (nginx), configure it to proxy WebSocket connections:

```nginx
location / {
    proxy_pass http://localhost:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

### Database Persistence

Currently, accounts are stored in `server/accounts.json`. For production, consider:
- Using a real database (PostgreSQL, MongoDB)
- Using cloud storage (AWS S3, Firebase)
- At minimum, use a persistent disk on your VPS

### SSL/HTTPS

Both Netlify and most hosting providers provide free SSL certificates. Ensure:
- Your backend uses HTTPS
- Your frontend connects via HTTPS
- Mixed content (HTTP on HTTPS site) will be blocked

## Troubleshooting

### Connection Issues
- Check browser console for errors
- Verify SERVER_URL is correct
- Ensure backend is running and accessible
- Check firewall/security group settings

### Authentication Issues
- Verify token storage in localStorage
- Check network requests in browser DevTools
- Ensure CORS is properly configured

### Multiplayer Issues
- Verify Socket.io connection in network tab
- Check backend logs for connection errors
- Ensure both clients can reach the backend

## Cost Summary

- **Netlify**: Free tier available (generous limits)
- **Render**: Free tier available (spins down after inactivity)
- **Railway**: Free tier available ($5 credit/month)
- **Heroku**: Free tier limited, Eco dyno ~$5/month
- **VPS**: ~$5-10/month for basic specs

## Recommended Setup for Free Hosting

For a completely free setup:
1. Deploy backend to Render (free tier)
2. Deploy frontend to Netlify (free tier)
3. Use the Render URL as VITE_SERVER_URL

Note: Render's free tier spins down after 15 minutes of inactivity, which means the first connection after inactivity may take 1-2 minutes to start up.
