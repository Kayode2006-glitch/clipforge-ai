
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      })
    : null;

app.get("/", (req, res) => {
  res.json({
    name: "ClipForge AI",
    status: "online",
    message: "ClipForge AI backend is running.",
    version: "1.1.0"
  });
});

app.get("/api/health", async (req, res) => {
  const result = {
    service: "ClipForge AI API",
    timestamp: new Date().toISOString(),
    databaseConfigured: Boolean(supabase)
  };

  if (!supabase) {
    return res.status(503).json({
      ...result,
      status: "degraded",
      database: "not_configured"
    });
  }

  try {
    const { error } = await supabase
      .from("content_sources")
      .select("id")
      .limit(1);

    if (error) {
      console.error("Supabase health check failed:", error.message);

      return res.status(503).json({
        ...result,
        status: "degraded",
        database: "connection_error"
      });
    }

    return res.json({
      ...result,
      status: "healthy",
      database: "connected"
    });
  } catch (error) {
    console.error("Health check failed:", error.message);

    return res.status(503).json({
      ...result,
      status: "degraded",
      database: "connection_error"
    });
  }
});

app.get("/api", (req, res) => {
  res.json({
    name: "ClipForge AI API",
    endpoints: [
      "GET /",
      "GET /api/health",
      "GET /api"
    ]
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ClipForge AI running on port ${PORT}`);
});
