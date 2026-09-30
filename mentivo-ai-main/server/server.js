require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");

const authRoutes = require("./routes/auth");
const aiRoutes = require("./routes/ai");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());

app.use("/api/auth", authRoutes);
app.use("/api/ai", aiRoutes);

// Serve the frontend
const PUBLIC_DIR = path.join(__dirname, "..", "public");
app.use(express.static(PUBLIC_DIR));

// Single-page app fallback (anything not matched above serves index.html)
app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Mentivo AI server running at http://localhost:${PORT}`);
  if (!process.env.GOOGLE_CLIENT_ID) console.log("  (Google sign-in disabled: set GOOGLE_CLIENT_ID/SECRET in .env)");
  if (!process.env.MICROSOFT_CLIENT_ID) console.log("  (Microsoft sign-in disabled: set MICROSOFT_CLIENT_ID/SECRET in .env)");
  if (!process.env.OPENROUTER_API_KEY && !process.env.GEMINI_API_KEY) {
    console.log("  (AI chat/PPT/PDF is using offline fallback. Add OPENROUTER_API_KEY or GEMINI_API_KEY in .env)");
  }
  if (!process.env.LUMA_API_KEY) console.log("  (Video generation disabled: set LUMA_API_KEY in .env)");
});
