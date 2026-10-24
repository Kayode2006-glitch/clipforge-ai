
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "32kb" }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;
const apiKey = process.env.CLIPFORGE_API_KEY;

const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      })
    : null;

function requireDatabase(req, res, next) {
  if (!supabase) {
    return res.status(503).json({
      error: "Database is not configured."
    });
  }

  next();
}

function requireApiKey(req, res, next) {
  if (!apiKey) {
    return res.status(503).json({
      error: "Write API is not configured."
    });
  }

  const supplied = req.get("x-api-key");

  if (
    typeof supplied !== "string" ||
    supplied.length !== apiKey.length ||
    !crypto.timingSafeEqual(
      Buffer.from(supplied),
      Buffer.from(apiKey)
    )
  ) {
    return res.status(401).json({
      error: "A valid API key is required."
    });
  }

  next();
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);

    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

app.get("/", (req, res) => {
  res.json({
    name: "ClipForge AI",
    status: "online",
    version: "1.2.0"
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
      console.error("Health check failed:", error.message);

      return res.status(503).json({
        ...result,
        status: "degraded",
        database: "connection_error"
      });
    }

    return res.json({
      ...result,
      status: "healthy",
      database: "connected",
      writeApiConfigured: Boolean(apiKey)
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
      "POST /api/sources",
      "GET /api/sources",
      "POST /api/jobs",
      "GET /api/jobs",
      "GET /api/jobs/:id"
    ]
  });
});

// Register an authorized video source.
app.post(
  "/api/sources",
  requireApiKey,
  requireDatabase,
  async (req, res) => {
    const { title, source_url, permission_confirmed } =
      req.body || {};

    if (
      typeof title !== "string" ||
      !title.trim() ||
      title.trim().length > 200
    ) {
      return res.status(400).json({
        error: "Title is required and must be at most 200 characters."
      });
    }

    if (
      typeof source_url !== "string" ||
      source_url.length > 2048 ||
      !validHttpUrl(source_url)
    ) {
      return res.status(400).json({
        error: "Provide a valid HTTP or HTTPS source URL."
      });
    }

    if (permission_confirmed !== true) {
      return res.status(400).json({
        error: "Confirm that you own or have permission to use this content."
      });
    }

    try {
      const { data, error } = await supabase
        .from("content_sources")
        .insert({
          title: title.trim(),
          source_url,
          source_type: "authorized_url",
          permission_confirmed: true
        })
        .select("id, title, source_url, status, created_at")
        .single();

      if (error) {
        console.error("Source creation failed:", error.message);

        return res.status(500).json({
          error: "Could not save the content source."
        });
      }

      return res.status(201).json({
        message: "Content source registered.",
        source: data
      });
    } catch (error) {
      console.error("Source creation error:", error.message);

      return res.status(500).json({
        error: "Could not register the content source."
      });
    }
  }
);

// List registered sources.
app.get(
  "/api/sources",
  requireApiKey,
  requireDatabase,
  async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("content_sources")
        .select("id, title, source_url, source_type, status, created_at")
        .order("created_at", { ascending: false })
        .limit(100);

      if (error) {
        console.error("Source listing failed:", error.message);

        return res.status(500).json({
          error: "Could not retrieve content sources."
        });
      }

      return res.json({ sources: data });
    } catch (error) {
      console.error("Source listing error:", error.message);

      return res.status(500).json({
        error: "Could not retrieve content sources."
      });
    }
  }
);

// Create a clipping job for a registered source.
app.post(
  "/api/jobs",
  requireApiKey,
  requireDatabase,
  async (req, res) => {
    const { source_id, target_platforms } = req.body || {};

    if (
      typeof source_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(source_id)
    ) {
      return res.status(400).json({
        error: "A valid source_id UUID is required."
      });
    }

    // Supported destinations: TikTok, Instagram, Facebook and YouTube.
    const allowedPlatforms = [
      "tiktok",
      "instagram",
      "facebook",
      "youtube"
    ];

    if (
      !Array.isArray(target_platforms) ||
      target_platforms.length === 0 ||
      target_platforms.some(
        platform => !allowedPlatforms.includes(platform)
      ) ||
      new Set(target_platforms).size !== target_platforms.length
    ) {
      return res.status(400).json({
        error: "Choose one or more supported platforms: tiktok, instagram, facebook, youtube."
      });
    }

    try {
      const { data: source, error: sourceError } = await supabase
        .from("content_sources")
        .select("id, permission_confirmed, status")
        .eq("id", source_id)
        .maybeSingle();

      if (sourceError) {
        console.error("Source lookup failed:", sourceError.message);

        return res.status(500).json({
          error: "Could not verify the content source."
        });
      }

      if (!source || source.status !== "active") {
        return res.status(404).json({
          error: "Active content source not found."
        });
      }

      if (!source.permission_confirmed) {
        return res.status(403).json({
          error: "Content permission must be confirmed before processing."
        });
      }

      const { data, error } = await supabase
        .from("clipping_jobs")
        .insert({
          source_id,
          target_platforms,
          status: "queued"
        })
        .select("id, source_id, status, target_platforms, created_at")
        .single();

      if (error) {
        console.error("Job creation failed:", error.message);

        return res.status(500).json({
          error: "Could not create the clipping job."
        });
      }

      return res.status(201).json({
        message: "Clipping job queued. Processing is not yet implemented.",
        job: data
      });
    } catch (error) {
      console.error("Job creation error:", error.message);

      return res.status(500).json({
        error: "Could not create the clipping job."
      });
    }
  }
);

// List recent clipping jobs.
app.get(
  "/api/jobs",
  requireApiKey,
  requireDatabase,
  async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("clipping_jobs")
        .select("id, source_id, status, target_platforms, error_message, created_at, updated_at")
        .order("created_at", { ascending: false })
        .limit(100);

      if (error) {
        console.error("Job listing failed:", error.message);

        return res.status(500).json({
          error: "Could not retrieve clipping jobs."
        });
      }

      return res.json({ jobs: data });
    } catch (error) {
      console.error("Job listing error:", error.message);

      return res.status(500).json({
        error: "Could not retrieve clipping jobs."
      });
    }
  }
);

// Get a specific job and its clips.
app.get(
  "/api/jobs/:id",
  requireApiKey,
  requireDatabase,
  async (req, res) => {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)
    ) {
      return res.status(400).json({
        error: "Invalid job ID."
      });
    }

    try {
      const { data: job, error: jobError } = await supabase
        .from("clipping_jobs")
        .select("id, source_id, status, target_platforms, error_message, created_at, updated_at")
        .eq("id", req.params.id)
        .maybeSingle();

      if (jobError) {
        console.error("Job lookup failed:", jobError.message);

        return res.status(500).json({
          error: "Could not retrieve the clipping job."
        });
      }

      if (!job) {
        return res.status(404).json({
          error: "Clipping job not found."
        });
      }

      const { data: clips, error: clipsError } = await supabase
        .from("clips")
        .select("id, title, start_seconds, end_seconds, video_url, caption_text, status, created_at")
        .eq("job_id", job.id)
        .order("created_at", { ascending: true });

      if (clipsError) {
        console.error("Clip lookup failed:", clipsError.message);

        return res.status(500).json({
          error: "Could not retrieve clips."
        });
      }

      return res.json({
        job,
        clips
      });
    } catch (error) {
      console.error("Job lookup error:", error.message);

      return res.status(500).json({
        error: "Could not retrieve the clipping job."
      });
    }
  }
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ClipForge AI running on port ${PORT}`);
});
                                
