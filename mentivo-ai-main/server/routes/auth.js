const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const db = require("../utils/db");
const auth = require("../utils/auth");

function appUrl() {
  return process.env.APP_URL || "http://localhost:3000";
}

function publicUser(u) {
  return { name: u.name, email: u.email, provider: u.provider };
}

/* -------------------------------------------------------------------------
   Local sign-in: name + email + password, all mandatory.
   Behaves as "register or log in": if the email is new, an account is
   created; if it already exists, the password is checked against the
   stored hash. Passwords are never stored or returned in plain text.
------------------------------------------------------------------------- */
router.post("/local", (req, res) => {
  const { name, email, password } = req.body || {};

  if (!name || !name.trim()) return res.status(400).json({ error: "Name is required." });
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "A valid email is required." });
  if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });

  const existing = db.findUserByEmail(email);

  if (existing) {
    if (existing.provider !== "local") {
      return res.status(409).json({
        error: `This email is linked to ${existing.provider} sign-in — use that button instead.`,
      });
    }
    if (!auth.comparePassword(password, existing.passwordHash)) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    auth.setSessionCookie(res, existing);
    return res.json({ user: publicUser(existing) });
  }

  const user = {
    id: crypto.randomUUID(),
    name: name.trim(),
    email: email.trim(),
    passwordHash: auth.hashPassword(password),
    provider: "local",
    createdAt: new Date().toISOString(),
  };
  db.saveUser(user);
  auth.setSessionCookie(res, user);
  res.json({ user: publicUser(user), created: true });
});

// Returns the currently signed-in user (if any), based on the session cookie.
router.get("/me", (req, res) => {
  const session = auth.getSessionUser(req);
  if (!session) return res.status(401).json({ user: null });
  const user = db.findUserById(session.id);
  if (!user) return res.status(401).json({ user: null });
  res.json({ user: publicUser(user) });
});

router.post("/logout", (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

/* -------------------------------------------------------------------------
   Google OAuth2 (Authorization Code flow).
   Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env — see
   .env.example for how to get them. Without them, the button shows a
   clear setup message instead of failing silently.
------------------------------------------------------------------------- */
router.get("/google", (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res
      .status(500)
      .send(
        "Google sign-in isn't configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your .env file (see .env.example), then restart the server."
      );
  }
  const redirectUri = `${appUrl()}/api/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

router.get("/google/callback", async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error) throw new Error(error);

    const redirectUri = `${appUrl()}/api/auth/google/callback`;
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || "No access token returned by Google.");

    const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();
    if (!profile.email) throw new Error("Google did not return an email address.");

    let user = db.findUserByEmail(profile.email);
    if (!user) {
      user = {
        id: crypto.randomUUID(),
        name: profile.name || profile.email.split("@")[0],
        email: profile.email,
        passwordHash: null,
        provider: "google",
        createdAt: new Date().toISOString(),
      };
      db.saveUser(user);
    }
    auth.setSessionCookie(res, user);
    res.redirect("/");
  } catch (err) {
    console.error("Google OAuth error:", err.message);
    res.redirect("/?authError=" + encodeURIComponent("Google sign-in failed. Please try again."));
  }
});

/* -------------------------------------------------------------------------
   Microsoft OAuth2 (Authorization Code flow, "common" tenant so both
   personal Microsoft accounts and work/school accounts can sign in).
   Requires MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET in .env.
------------------------------------------------------------------------- */
router.get("/microsoft", (req, res) => {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) {
    return res
      .status(500)
      .send(
        "Microsoft sign-in isn't configured yet. Add MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET to your .env file (see .env.example), then restart the server."
      );
  }
  const redirectUri = `${appUrl()}/api/auth/microsoft/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: "openid email profile User.Read",
  });
  res.redirect(`https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`);
});

router.get("/microsoft/callback", async (req, res) => {
  try {
    const { code, error, error_description } = req.query;
    if (error) throw new Error(error_description || error);

    const redirectUri = `${appUrl()}/api/auth/microsoft/callback`;
    const tokenRes = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.MICROSOFT_CLIENT_ID,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || "No access token returned by Microsoft.");

    const profileRes = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();
    const email = profile.mail || profile.userPrincipalName;
    if (!email) throw new Error("Microsoft did not return an email address.");

    let user = db.findUserByEmail(email);
    if (!user) {
      user = {
        id: crypto.randomUUID(),
        name: profile.displayName || email.split("@")[0],
        email,
        passwordHash: null,
        provider: "microsoft",
        createdAt: new Date().toISOString(),
      };
      db.saveUser(user);
    }
    auth.setSessionCookie(res, user);
    res.redirect("/");
  } catch (err) {
    console.error("Microsoft OAuth error:", err.message);
    res.redirect("/?authError=" + encodeURIComponent("Microsoft sign-in failed. Please try again."));
  }
});

module.exports = router;
