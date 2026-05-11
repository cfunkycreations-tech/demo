# Retell Sober Living Demo

Railway-ready Node backend for a Retell AI phone intake agent.

## Deploy

1. Upload these files to your GitHub repo root.
2. Railway -> New Project -> Deploy from GitHub.
3. Add variables in Railway.
4. Open `/status`.

## Retell Function URLs

After Railway gives your URL, add these as Retell custom functions:

POST https://YOUR-RAILWAY-APP.up.railway.app/api/retell/check-room-availability
POST https://YOUR-RAILWAY-APP.up.railway.app/api/retell/get-rules
POST https://YOUR-RAILWAY-APP.up.railway.app/api/retell/create-stripe-checkout
POST https://YOUR-RAILWAY-APP.up.railway.app/api/retell/get-next-step-links
POST https://YOUR-RAILWAY-APP.up.railway.app/api/retell/send-links
POST https://YOUR-RAILWAY-APP.up.railway.app/api/retell/send-owner-summary

No Twilio. Do not commit .env or real API keys to GitHub.
