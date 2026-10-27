require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const { randomUUID } = require("crypto");
const videoProcessor = require("./videoProcessor");
const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "32kb" }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;
const scrapeCreatorsKey = process.env.SCRAPECREATORS_API_KEY;
const diagnosticToken = process.env.CLIPFORGE_DIAGNOSTIC_TOKEN;

const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      })
    : null;

// -------------------- BASIC HELPERS --------------------

function requireDatabase(req, res, next) {
  if (!supabase) {
    return res.status(503).json({
      error: "Database is not configured."
    });
  }

  return next();
}

async function requireUser(req, res, next) {
  if (!supabase) {
    return res.status(503).json({
      error: "Database is not configured."
    });
  }

  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(\S+)$/i);

  if (!match) {
    return res.status(401).json({
      error: "Please sign in to continue."
    });
  }

  try {
    const { data, error } = await supabase.auth.getUser(match[1]);

    if (error || !data || !data.user) {
      return res.status(401).json({
        error: "Your session is invalid or expired. Please sign in again."
      });
    }

    req.user = data.user;
    return next();
  } catch (error) {
    console.error("Authentication failed:", error.message);

    return res.status(401).json({
      error: "Could not verify your session. Please sign in again."
    });
  }
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

function validUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function requireDiagnosticToken(req, res, next) {
  if (!diagnosticToken || diagnosticToken.length < 32) {
    return res.status(503).json({
      error: "The diagnostic endpoint is not configured."
    });
  }

  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(\S+)$/i);

  if (!match || match[1] !== diagnosticToken) {
    return res.status(401).json({
      error: "Unauthorized."
    });
  }

  return next();
}

// Convert view counts such as "1,234", "1.2K", or "3.5M"
// into numbers for local sorting. Unknown values remain null.
function parseViewCount(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/,/g, "");

  const match = normalized.match(
    /(\d+(?:\.\d+)?)\s*([kmb])?/
  );

  if (!match) {
    return null;
  }

  let count = Number(match[1]);

  if (match[2] === "k") count *= 1_000;
  if (match[2] === "m") count *= 1_000_000;
  if (match[2] === "b") count *= 1_000_000_000;

  return Number.isFinite(count) ? count : null;
}

// Interpret ISO dates and common relative publication dates.
// Return null when the date cannot be reliably interpreted.
function parsePublishedDate(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const text = value.trim();
  const timestamp = Date.parse(text);

  if (Number.isFinite(timestamp)) {
    return timestamp;
  }

  const normalized = text.toLowerCase();

  if (/^(just now|moments ago|today)$/.test(normalized)) {
    return Date.now();
  }

  if (normalized === "yesterday") {
    return Date.now() - 24 * 60 * 60 * 1000;
  }

  const match = normalized.match(
    /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/
  );

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);

  const units = {
    second: 1000,
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000
  };

  return Date.now() - amount * units[match[2]];
}

// -------------------- DASHBOARD --------------------

app.use(express.static(PUBLIC_DIR, {
  index: false
}));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"), error => {
    if (error && !res.headersSent) {
      res.status(500).send(
        "ClipForge dashboard could not be loaded. Check that public/index.html exists."
      );
    }
  });
});

// -------------------- HEALTH CHECK --------------------

app.get("/api/health", async (req, res) => {
  const result = {
    service: "ClipForge AI API",
    timestamp: new Date().toISOString(),
    databaseConfigured: Boolean(supabase),
    discoveryConfigured: Boolean(scrapeCreatorsKey)
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
      authenticationConfigured: true
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

// -------------------- FFMPEG DIAGNOSTIC --------------------

app.get(
  "/api/diagnostics/ffmpeg",
  requireDiagnosticToken,
  async (req, res) => {
    try {
      const { stdout } = await execFileAsync(
        "ffmpeg",
        ["-version"],
        {
          timeout: 5000,
          maxBuffer: 16 * 1024
        }
      );

      const firstLine = String(stdout || "").split("\n")[0].trim();

      return res.json({
        checked: true,
        ffmpegAvailable: true,
        version: firstLine || "Version detected",
        timestamp: new Date().toISOString(),
        note: "FFmpeg is available. Actual video rendering has not been implemented by this endpoint."
      });
    } catch (error) {
      if (error.code === "ENOENT") {
        return res.json({
          checked: true,
          ffmpegAvailable: false,
          timestamp: new Date().toISOString(),
          note: "FFmpeg was not found in the server's executable search path."
        });
      }

      if (error.killed || error.code === "ETIMEDOUT") {
        return res.status(504).json({
          error: "The FFmpeg diagnostic timed out."
        });
      }

      console.error(
        "FFmpeg diagnostic failed:",
        error.code || "unknown"
      );

      return res.status(500).json({
        error: "Could not complete the FFmpeg diagnostic."
      });
    }
  }
);

// -------------------- API INFORMATION --------------------


app.get("/api", (req, res) => {
  res.json({
    name: "ClipForge AI API",
    version: "1.7.0",
    features: {
      youtubeDiscovery: true,
      popularitySorting: true,
      localRecentRanking: true,
      videoRendering: true,
      automaticPublishing: false
    },
    endpoints: [
      "GET /",
      "GET /api/health",
      "GET /api/discover?topic=football",
      "GET /api/diagnostics/ffmpeg (diagnostic token required)",
      "POST /api/sources (sign-in required)",
      "GET /api/sources (sign-in required)",
      "POST /api/jobs (sign-in required)",
      "GET /api/jobs (sign-in required)",
      "GET /api/jobs/:id (sign-in required)",
      "POST /api/render/:sourceId (sign-in required)",
      "GET /api/clips/:id/download (sign-in required)"
    ]
  });
});

 // -------------------- AUTHENTICATION --------------------

app.post("/api/auth/signup", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({
      error: "Authentication is not configured."
    });
  }

  const email =
    typeof req.body?.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";

  const password =
    typeof req.body?.password === "string"
      ? req.body.password
      : "";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      error: "Enter a valid email address."
    });
  }

  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({
      error: "Password must contain 8 to 128 characters."
    });
  }

  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password
    });

    if (error) {
      return res.status(400).json({
        error: error.message
      });
    }

    return res.status(201).json({
      message: data.session
        ? "Account created. You can now continue."
        : "Account created. Check your email to confirm it before signing in.",
      confirmationRequired: !data.session
    });
  } catch (error) {
    console.error("Sign-up failed:", error.message);

    return res.status(500).json({
      error: "Could not create your account."
    });
  }
});

app.post("/api/auth/signin", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({
      error: "Authentication is not configured."
    });
  }

  const email =
    typeof req.body?.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";

  const password =
    typeof req.body?.password === "string"
      ? req.body.password
      : "";

  if (!email || !password) {
    return res.status(400).json({
      error: "Enter your email and password."
    });
  }

  try {
    const { data, error } =
      await supabase.auth.signInWithPassword({
        email,
        password
      });

    if (error || !data.session) {
      return res.status(401).json({
        error: "Sign-in failed. Check your details and confirm your email if required."
      });
    }

    return res.json({
      message: "Signed in successfully.",
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      user: {
        id: data.user.id,
        email: data.user.email
      }
    });
  } catch (error) {
    console.error("Sign-in failed:", error.message);

    return res.status(500).json({
      error: "Could not sign in."
    });
  }
});
  

// -------------------- YOUTUBE DISCOVERY --------------------

app.get("/api/discover", async (req, res) => {
  if (!scrapeCreatorsKey) {
    return res.status(503).json({
      error: "Video discovery is not configured on the server."
    });
  }

  const topic =
    typeof req.query.topic === "string"
      ? req.query.topic.trim()
      : "";

  const sortBy =
    typeof req.query.sortBy === "string"
      ? req.query.sortBy
      : "relevance";

  const uploadDate =
    typeof req.query.uploadDate === "string"
      ? req.query.uploadDate
      : "this_week";

  const type =
    typeof req.query.type === "string"
      ? req.query.type
      : "videos";

  const region =
    typeof req.query.region === "string"
      ? req.query.region.toUpperCase()
      : "NG";

  const allowedSorts = ["relevance", "popular", "recent"];

  const allowedDates = [
    "all",
    "today",
    "this_week",
    "this_month",
    "this_year"
  ];

  const allowedTypes = ["videos", "shorts"];

  if (!topic || topic.length > 150) {
    return res.status(400).json({
      error: "Provide a topic between 1 and 150 characters."
    });
  }

  if (!allowedSorts.includes(sortBy)) {
    return res.status(400).json({
      error: "sortBy must be relevance, popular, or recent."
    });
  }

  if (!allowedDates.includes(uploadDate)) {
    return res.status(400).json({
      error: "uploadDate must be all, today, this_week, this_month, or this_year."
    });
  }

  if (!allowedTypes.includes(type)) {
    return res.status(400).json({
      error: "type must be videos or shorts."
    });
  }

  if (!/^[A-Z]{2}$/.test(region)) {
    return res.status(400).json({
      error: "region must be a two-letter country code."
    });
  }

  const continuationToken =
    typeof req.query.continuationToken === "string"
      ? req.query.continuationToken
      : "";

  if (continuationToken.length > 2000) {
    return res.status(400).json({
      error: "The continuation token is too long."
    });
  }

  try {
    const searchUrl = new URL(
      "https://api.scrapecreators.com/v1/youtube/search"
    );

    searchUrl.searchParams.set("query", topic);

    // Use the provider's popularity sort only for "popular".
    // "recent" is ranked locally because this endpoint's
    // chronological sort parameter has not been confirmed.
    const providerSort =
      sortBy === "popular" ? "popular" : "relevance";

    searchUrl.searchParams.set("sortBy", providerSort);

    if (uploadDate !== "all") {
      searchUrl.searchParams.set("uploadDate", uploadDate);
    }

    searchUrl.searchParams.set("type", type);
    searchUrl.searchParams.set("region", region);

    if (continuationToken) {
      searchUrl.searchParams.set(
        "continuationToken",
        continuationToken
      );
    }

    const response = await fetch(searchUrl, {
      method: "GET",
      headers: {
        "x-api-key": scrapeCreatorsKey,
        "accept": "application/json"
      },
      signal: AbortSignal.timeout(25000)
    });

    const rawText = await response.text();

    let payload;

    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = null;
    }

    if (!response.ok) {
      console.error(
        "YouTube discovery provider returned HTTP",
        response.status
      );

      if (response.status === 401 || response.status === 403) {
        return res.status(502).json({
          error: "The discovery provider rejected its credentials. Check your Render environment settings."
        });
      }

      if (response.status === 402) {
        return res.status(502).json({
          error: "The discovery provider reports insufficient credits."
        });
      }

      if (response.status === 429) {
        return res.status(429).json({
          error: "The discovery provider is rate-limiting requests. Please wait before searching again."
        });
      }

      if (response.status === 400) {
        return res.status(502).json({
          error: "The discovery provider rejected the search parameters."
        });
      }

      return res.status(502).json({
        error: "The discovery provider could not complete the search."
      });
    }

    if (!payload || typeof payload !== "object") {
      return res.status(502).json({
        error: "The discovery provider returned an unexpected response."
      });
    }

    const collections = [
      ...(Array.isArray(payload.videos) ? payload.videos : []),
      ...(Array.isArray(payload.shorts) ? payload.shorts : [])
    ];

    const seen = new Set();
    const results = [];

    for (const item of collections) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const videoId =
        item.id ||
        item.videoId ||
        item.video_id ||
        null;

      const url =
        item.url ||
        item.videoUrl ||
        item.video_url ||
        (
          typeof videoId === "string" &&
          /^[A-Za-z0-9_-]{11}$/.test(videoId)
            ? `https://www.youtube.com/watch?v=${videoId}`
            : null
        );

      if (!url || !validHttpUrl(url)) {
        continue;
      }

      const parsedUrl = new URL(url);

      const allowedHosts = [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "youtu.be",
        "www.youtu.be",
        "www.youtube-nocookie.com"
      ];

      if (!allowedHosts.includes(parsedUrl.hostname)) {
        continue;
      }

      const identity = videoId || url;

      if (seen.has(identity)) {
        continue;
      }

      seen.add(identity);

      const rawViews =
        item.viewCount ??
        item.view_count ??
        item.views ??
        null;

      const published =
        item.publishedTime ||
        item.published_time ||
        item.publishedAt ||
        item.published_at ||
        null;

      results.push({
        video_id: videoId,
        title: item.title || item.name || "Untitled video",
        url,
        channel:
          item.channel?.name ||
          item.channelName ||
          item.channel_name ||
          item.author?.name ||
          item.author ||
          null,
        thumbnail:
          item.thumbnail ||
          item.thumbnailUrl ||
          item.thumbnail_url ||
          item.thumbnails?.[0]?.url ||
          null,
        views: rawViews,
        views_numeric: parseViewCount(rawViews),
        duration:
          item.duration ??
          item.lengthText ??
          null,
        published,
        published_timestamp: parsePublishedDate(published),
        content_type:
          item.type ||
          (type === "shorts" ? "shorts" : "video")
      });
    }

    // Sort only the results returned in this response.
    if (sortBy === "popular") {
      results.sort((a, b) => {
        const aViews = a.views_numeric;
        const bViews = b.views_numeric;

        if (aViews === null && bViews === null) return 0;
        if (aViews === null) return 1;
        if (bViews === null) return -1;

        return bViews - aViews;
      });
    }

    if (sortBy === "recent") {
      results.sort((a, b) => {
        const aDate = a.published_timestamp;
        const bDate = b.published_timestamp;

        if (aDate === null && bDate === null) return 0;
        if (aDate === null) return 1;
        if (bDate === null) return -1;

        return bDate - aDate;
      });
    }

    return res.json({
      topic,
      filters: {
        sortBy,
        uploadDate,
        type,
        region
      },
      count: results.length,
      results,
      continuationToken:
        payload.continuationToken ||
        payload.continuation_token ||
        null,
      rankingNote:
        sortBy === "popular"
          ? "Results are ordered by available view counts. Videos without usable counts appear last."
          : sortBy === "recent"
            ? "Results with interpretable publication dates are ranked newest first. Undated or unrecognized dates appear last."
            : "Results retain the provider's relevance order.",
      note: "Discovery results are not downloadable video files. Confirm usage rights before processing or publishing content."
    });
  } catch (error) {
    if (
      error.name === "TimeoutError" ||
      error.name === "AbortError"
    ) {
      return res.status(504).json({
        error: "The video discovery request timed out. Please try again."
      });
    }

    console.error("YouTube discovery failed:", error.message);

    return res.status(502).json({
      error: "Video discovery is temporarily unavailable."
    });
  }
});

// -------------------- CONTENT SOURCES --------------------

app.post("/api/sources", requireUser, async (req, res) => {
  const {
    title,
    source_url,
    permission_confirmed
  } = req.body || {};

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
        user_id: req.user.id,
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
});

app.get("/api/sources", requireUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("content_sources")
      .select("id, title, source_url, source_type, status, created_at")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      console.error("Source listing failed:", error.message);

      return res.status(500).json({
        error: "Could not retrieve content sources."
      });
    }

    return res.json({
      sources: data
    });
  } catch (error) {
    console.error("Source listing error:", error.message);

    return res.status(500).json({
      error: "Could not retrieve content sources."
    });
  }
});

// -------------------- CLIPPING JOBS --------------------

app.post("/api/jobs", requireUser, async (req, res) => {
  const {
    source_id,
    target_platforms
  } = req.body || {};

  if (!validUuid(source_id)) {
    return res.status(400).json({
      error: "A valid source_id UUID is required."
    });
  }

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
      .eq("user_id", req.user.id)
      .maybeSingle();

    if (sourceError) {
      console.error("Source lookup failed:", sourceError.message);

      return res.status(500).json({
        error: "Could not verify the content source."
      });
    }

    if (!source || source.status !== "active") {
      return res.status(404).json({
        error: "Active content source not found for your account."
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
        user_id: req.user.id,
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
      message: "Clipping job queued. Video processing is not implemented yet.",
      job: data
    });
  } catch (error) {
    console.error("Job creation error:", error.message);

    return res.status(500).json({
      error: "Could not create the clipping job."
    });
  }
});

// List only jobs belonging to the signed-in user.
app.get("/api/jobs", requireUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("clipping_jobs")
      .select(
        "id, source_id, status, target_platforms, error_message, created_at, updated_at"
      )
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      console.error("Job listing failed:", error.message);

      return res.status(500).json({
        error: "Could not retrieve clipping jobs."
      });
    }

    return res.json({
      jobs: data
    });
  } catch (error) {
    console.error("Job listing error:", error.message);

    return res.status(500).json({
      error: "Could not retrieve clipping jobs."
    });
  }
});

// Retrieve a job and only its clips belonging to the signed-in user.
app.get("/api/jobs/:id", requireUser, async (req, res) => {
  if (!validUuid(req.params.id)) {
    return res.status(400).json({
      error: "Invalid job ID."
    });
  }

  try {
    const { data: job, error: jobError } = await supabase
      .from("clipping_jobs")
      .select(
        "id, source_id, status, target_platforms, error_message, created_at, updated_at"
      )
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
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
      .select(
        "id, title, start_seconds, end_seconds, video_url, caption_text, status, created_at"
      )
      .eq("job_id", job.id)
      .eq("user_id", req.user.id)
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
});

/* -------------------- REAL VIDEO RENDERING -------------------- */

// Upload and render an authorized video for the signed-in user.
// The source must already exist in the user's content_sources table.
app.post(
  "/api/render/:sourceId",
  requireUser,
  express.raw({
    type: ["video/mp4", "video/quicktime", "video/webm"],
    limit: "100mb"
  }),
  async (req, res) => {
    const sourceId = req.params.sourceId;

    if (!validUuid(sourceId)) {
      return res.status(400).json({
        error: "A valid source ID is required."
      });
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({
        error: "Send a video file using video/mp4, video/quicktime, or video/webm."
      });
    }

    const startSeconds = Number(req.query.startSeconds ?? 0);
    const durationSeconds = Number(req.query.durationSeconds ?? 30);
    const aspectRatio = String(req.query.aspectRatio ?? "9:16");

    const allowedRatios = ["9:16", "16:9", "1:1", "4:5"];

    if (
      !Number.isFinite(startSeconds) ||
      startSeconds < 0 ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds > 180 ||
      !allowedRatios.includes(aspectRatio)
    ) {
      return res.status(400).json({
        error: "Invalid trim settings. Duration must be between 1 and 180 seconds."
      });
    }

    let inputPath;
    let jobId;

    try {
      const { data: source, error: sourceError } = await supabase
        .from("content_sources")
        .select("id, title, permission_confirmed, status")
        .eq("id", sourceId)
        .eq("user_id", req.user.id)
        .maybeSingle();

      if (sourceError) {
        console.error("Render source lookup failed:", sourceError.message);

        return res.status(500).json({
          error: "Could not verify the video source."
        });
      }

      if (!source || source.status !== "active") {
        return res.status(404).json({
          error: "Active source not found for your account."
        });
      }

      if (!source.permission_confirmed) {
        return res.status(403).json({
          error: "You must have permission to process this video."
        });
      }

      videoProcessor.ensureDirectories();

      const uploadId = randomUUID();
      const contentType = req.get("content-type")?.split(";")[0].trim();

      const extension = {
        "video/mp4": ".mp4",
        "video/quicktime": ".mov",
        "video/webm": ".webm"
      }[contentType];

      if (!extension) {
        return res.status(415).json({
          error: "Unsupported video format."
        });
      }

      inputPath = path.join(
        videoProcessor.UPLOAD_DIR,
        `${uploadId}${extension}`
      );

      await fs.promises.writeFile(inputPath, req.body, {
        flag: "wx",
        mode: 0o600
      });

      const { data: job, error: jobError } = await supabase
        .from("clipping_jobs")
        .insert({
          user_id: req.user.id,
          source_id: source.id,
          target_platforms: ["tiktok"],
          status: "processing"
        })
        .select("id")
        .single();

      if (jobError) {
        console.error("Render job creation failed:", jobError.message);

        return res.status(500).json({
          error: "Could not create the rendering job."
        });
      }

      jobId = job.id;

      const rendered = await videoProcessor.renderClip({
        inputPath,
        startSeconds,
        durationSeconds,
        aspectRatio
      });

      const { data: clip, error: clipError } = await supabase
        .from("clips")
        .insert({
          id: rendered.id,
          user_id: req.user.id,
          job_id: jobId,
          title: source.title || "Generated clip",
          start_seconds: startSeconds,
          end_seconds: startSeconds + durationSeconds,
          video_url: `/api/clips/${rendered.id}/download`,
          caption_text: "",
          status: "ready"
        })
        .select(
          "id, job_id, title, start_seconds, end_seconds, video_url, status, created_at"
        )
        .single();

      if (clipError) {
        await fs.promises.rm(rendered.outputPath, { force: true });

        throw new Error("Could not save the generated clip record.");
      }

      await supabase
        .from("clipping_jobs")
        .update({ status: "completed", error_message: null })
        .eq("id", jobId)
        .eq("user_id", req.user.id);

      return res.status(201).json({
        message: "Video rendered successfully.",
        job_id: jobId,
        clip,
        download_url: clip.video_url,
        note: "The generated MP4 is stored on the server's temporary filesystem. Download it before the service restarts or its temporary files are lost."
      });
    } catch (error) {
      console.error("Video rendering failed:", error.message);

      if (jobId) {
        await supabase
          .from("clipping_jobs")
          .update({
            status: "failed",
            error_message: "Video rendering failed."
          })
          .eq("id", jobId)
          .eq("user_id", req.user.id);
      }

      return res.status(500).json({
        error: "Video rendering failed. Check the server logs."
      });
    } finally {
      if (inputPath) {
        await fs.promises.rm(inputPath, { force: true }).catch(() => {});
      }
    }
  }
);

// Download only a clip belonging to the authenticated user.
app.get(
  "/api/clips/:id/download",
  requireUser,
  async (req, res) => {
    const clipId = req.params.id;

    if (!validUuid(clipId)) {
      return res.status(400).json({
        error: "Invalid clip ID."
      });
    }

    try {
      const { data: clip, error } = await supabase
        .from("clips")
        .select("id, title, video_url, status")
        .eq("id", clipId)
        .eq("user_id", req.user.id)
        .maybeSingle();

      if (error) {
        console.error("Clip download lookup failed:", error.message);

        return res.status(500).json({
          error: "Could not retrieve the clip."
        });
      }

      if (
        !clip ||
        clip.status !== "ready" ||
        clip.video_url !== `/api/clips/${clipId}/download`
      ) {
        return res.status(404).json({
          error: "Ready clip not found for your account."
        });
      }

      const outputPath = path.join(
        videoProcessor.OUTPUT_DIR,
        `${clipId}.mp4`
      );

      if (!fs.existsSync(outputPath)) {
        return res.status(410).json({
          error: "This temporary video file is no longer available. Render the clip again."
        });
      }

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="clip-${clipId}.mp4"`
      );
      res.setHeader("X-Content-Type-Options", "nosniff");

      return res.sendFile(outputPath);
    } catch (error) {
      console.error("Clip download failed:", error.message);

      if (!res.headersSent) {
        return res.status(500).json({
          error: "Could not download the clip."
        });
      }
    }
  }
);
            
// -------------------- START SERVER --------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ClipForge AI running on port ${PORT}`);
});
