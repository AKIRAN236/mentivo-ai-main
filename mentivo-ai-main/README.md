# Mentivo AI

Learn. Understand. Master.

A file-scanning assistant with a real authentication backend. File scanning
itself (text, PDF, Word, PowerPoint, Excel, images, audio/video) still runs
entirely in the browser — nothing about your files' content is ever sent to
the server. Only sign-in/account data touches the backend.

## What's included

```
mentivo-ai/
├── server/
│   ├── server.js          Express app entry point
│   ├── routes/auth.js     Local signup/login + Google & Microsoft OAuth2
│   ├── utils/auth.js      Password hashing (bcrypt) + session cookies (JWT)
│   ├── utils/db.js        Simple JSON-file user database
│   └── data/users.json    Created automatically on first signup
├── public/
│   └── index.html         The Mentivo AI frontend (single page)
├── package.json
├── .env.example           Copy to .env and fill in your values
└── .gitignore
```

## 1. Install dependencies

Requires **Node.js 18 or newer** (for built-in `fetch`).

```bash
npm install
```

## 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

- `JWT_SECRET` — any long random string (used to sign session cookies).
  Generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```

Email/password sign-in works immediately with no further setup.

## AI features: chat, image, video, PPT, PDF

There's a single composer on the home screen — no mode buttons to pick.
Type a question, ask for an image/video/PPT/PDF, or attach files, and
Mentivo AI figures out what you meant automatically.

| What you type | What happens | Needs |
|-------|--------------|-------|
| Attach a file | Reads text/PDF/Office/image/audio/video files entirely in the browser | Nothing — always works |
| A question | General Q&A chat, powered by OpenRouter | `OPENROUTER_API_KEY` |
| "generate an image of…" | Generates an image from your prompt | `PIXAZO_API_KEY` (free) |
| "generate a video of…" | Generates a short video from your prompt (via Luma) | `LUMA_API_KEY` (paid — no free option exists for this yet) |
| "make a PPT about…" | Generates a real, downloadable `.pptx` | Works with plain text; add `OPENROUTER_API_KEY` for AI-drafted slides |
| "write a PDF about…" | Generates a real, downloadable `.pdf` | Works with plain text; add `OPENROUTER_API_KEY` for AI-written content |

Any feature missing a required key shows a clear in-chat message explaining
exactly what to add, instead of failing silently. All AI routes
(`/api/ai/*`) require the caller to be signed in.

**Enable chat + AI-drafted PPT/PDF content with OpenRouter:**
Create an account at [OpenRouter](https://openrouter.ai), generate an API key,
and add it to `.env`:
```
OPENROUTER_API_KEY=your_key_here
OPENROUTER_MODEL=openai/gpt-4o-mini
```

If you prefer to keep using Gemini instead, the app still supports the old
fallback config too:
```
GEMINI_API_KEY=AIza...
```

**Enable image generation:** uses [Pixazo](https://www.pixazo.ai), a unified
gateway to many image/video/audio models that offers a genuinely free tier
(Flux Schnell, Stable Diffusion, and SDXL) — free account, free API key, no
credit card. Sign up at [pixazo.ai](https://www.pixazo.ai), grab your key
from the [API dashboard](https://api-console.pixazo.ai/api_keys), and add it
to `.env`:
```
PIXAZO_API_KEY=...
```
One caveat worth knowing: Pixazo's public docs describe the request shape
clearly but don't publish the exact response field name for the image URL.
The code checks the common shapes such APIs use; if your account's response
doesn't match, it logs the raw response to the server console so you (or I,
if you paste it back to me) can add the right field name in one place —
`server/routes/ai.js`'s `/image` handler.

**Video generation is the one feature with no free option right now.**
Being straight about it: Luma, Runway, Pika, and every other video model
provider I'm aware of charge per generation — there's no free tier worth
relying on for real video output. If budget is the priority, I'd suggest
either leaving `LUMA_API_KEY` unset (the app already handles this
gracefully — it just tells the user video isn't configured, no crash) or
removing "video" from the intent detection in `public/index.html` entirely
so it doesn't advertise a feature you don't want to pay for. Everything
else in this app (scanning, chat, PPT, PDF, and now images) works at zero
cost once you add the free keys above.

Luma's specifics, if you do want to enable it later: get a key from the
Luma dashboard and add it to `.env`:
```
LUMA_API_KEY=luma-...
```
Generation is asynchronous — the server submits the job and polls for you, so
a request just takes a while (typically 30 seconds to a few minutes) rather
than needing a separate "check back later" step. Luma's API is one of several
similar providers (Runway, Pika, and others work the same submit-then-poll
way); if you'd rather use a different one, `server/routes/ai.js`'s `/video`
handler is a self-contained place to swap in a different provider's request
shape. Note that third-party APIs do change their exact request/response
fields over time — if Luma returns an error about an unrecognized field,
check their current docs and adjust the `body` in the `/video` handler
accordingly.

## 3. (Optional) Enable Google sign-in

1. Go to the [Google Cloud Console credentials page](https://console.cloud.google.com/apis/credentials).
2. Create an **OAuth client ID** → Application type: **Web application**.
3. Under **Authorized redirect URIs**, add:
   ```
   http://localhost:3000/api/auth/google/callback
   ```
4. Copy the **Client ID** and **Client Secret** into `.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```

## 4. (Optional) Enable Microsoft sign-in

1. Go to the [Azure Portal](https://portal.azure.com) → **Azure Active
   Directory** → **App registrations** → **New registration**.
2. Under **Redirect URI**, choose **Web** and enter:
   ```
   http://localhost:3000/api/auth/microsoft/callback
   ```
3. After registering, go to **Certificates & secrets** → **New client
   secret**, and copy the secret **value** (not the ID).
4. Put both into `.env`:
   ```
   MICROSOFT_CLIENT_ID=...
   MICROSOFT_CLIENT_SECRET=...
   ```

If you skip either of these, that provider's button will show a plain-text
setup message instead of failing silently — email/password sign-in is
unaffected either way.

## 5. Run it

```bash
npm start
```

Then open **http://localhost:3000**.

For local development with auto-restart on file changes:

```bash
npm run dev
```

## How accounts work

- Signing in with name + email + password creates an account automatically
  the first time that email is used, and logs you in on every return visit
  (password is checked against a hash — never stored or logged in plain
  text).
- Google/Microsoft sign-in creates or matches an account by the email your
  provider returns.
- Sessions are stored as an httpOnly cookie (a signed JWT), valid for 7
  days.
- User records live in `server/data/users.json`. For production use, swap
  this out for a real database (Postgres, MongoDB, etc.) — the rest of the
  app only talks to `server/utils/db.js`'s functions, so that's the one
  file you'd need to reimplement.

## Security notes before deploying anywhere public

- Set `NODE_ENV=production` so session cookies require HTTPS.
- Put a real, secret `JWT_SECRET` in your production environment — don't
  reuse the example value.
- `server/data/users.json` is a flat file with no encryption at rest and no
  concurrent-write protection — fine for a demo or small personal
  deployment, not for production scale or multiple server instances.
- Consider rate-limiting `/api/auth/local` to slow down password-guessing
  attempts.
"# Mentivo_ai" 
"# Mentivo_ai" 
"# Mentivo_ai" 
"# mentivo-ai" 
"# mentivo-ai" 
"# mentivo-ai" 
"# mentivo-ai" 
"# mentivo-ai" 
"# mentivo-ai" 
