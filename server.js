require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { execFile } = require("child_process");
const { promisify } = require("util");

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

// This secret protects the diagnostic endpoint.
// Configure it in Render as CLIPFORGE_DIAGNOSTIC_TOKEN.
// Do not use your Supabase or ScrapeCreators key for this value.
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

function requireDatabase(req, res, next) {
if (!supabase) {
return res.status(503).json({
error: "Database is not configured."
});
}

return next();
}

// Authenticate users through Supabase Auth.
// Never accept a user ID supplied by the browser as proof of identity.
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

// Protect the diagnostic endpoint with a dedicated secret.
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

// Serve the ClipForge dashboard.
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

// Service and database health check.
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

// Protected FFmpeg availability diagnostic.
// It runs one fixed version command, with a short timeout.
// It never accepts executable names or arguments from the request.
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
    note: "FFmpeg is available. This does not yet confirm that the server has sufficient resources to render videos."
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

  console.error("FFmpeg diagnostic failed:", error.code || "unknown");

  return res.status(500).json({
    error: "Could not complete the FFmpeg diagnostic."
  });
}

}
);

app.get("/api", (req, res) => {
res.json({
name: "ClipForge AI API",
version: "1.5.0",
endpoints: [
"GET /",
"GET /api/health",
"GET /api/discover?topic=football",
"GET /api/diagnostics/ffmpeg (diagnostic token required)",
"POST /api/sources (sign-in required)",
"GET /api/sources (sign-in required)",
"POST /api/jobs (sign-in required)",
"GET /api/jobs (sign-in required)",
"GET /api/jobs/:id (sign-in required)"
]
});
});

// Public read-only discovery endpoint.
// Provider credentials remain on the server.
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

try {
const searchUrl = new URL(
"https://api.scrapecreators.com/v1/youtube/search"
);

searchUrl.searchParams.set("query", topic);

// "recent" temporarily maps to relevance until the provider's
// supported recent-sort parameter has been confirmed.
const providerSort =
  sortBy === "recent" ? "relevance" : sortBy;

searchUrl.searchParams.set("sortBy", providerSort);

if (uploadDate !== "all") {
  searchUrl.searchParams.set("uploadDate", uploadDate);
}

searchUrl.searchParams.set("type", type);
searchUrl.searchParams.set("region", region);

const continuationToken =
  typeof req.query.continuationToken === "string"
    ? req.query.continuationToken
    : "";

if (continuationToken && continuationToken.length <= 2000) {
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

  if (response.status === 401) {
    return res.status(502).json({
      error: "The discovery provider rejected its server credentials. Check the Render environment variable."
    });
  }

  if (response.status === 402) {
    return res.status(502).json({
      error: "The discovery provider reports insufficient credits."
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

const results = collections
  .filter(item => item && typeof item === "object")
  .map(item => {
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

    return {
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
      views:
        item.viewCount ??
        item.view_count ??
        item.views ??
        null,
      duration:
        item.duration ??
        item.lengthText ??
        null,
      published:
        item.publishedTime ||
        item.published_time ||
        item.publishedAt ||
        item.published_at ||
        null,
      content_type:
        item.type ||
        (type === "shorts" ? "shorts" : "video")
    };
  })
  .filter(item => {
    if (!item.url || !validHttpUrl(item.url)) {
      return false;
    }

    const parsedUrl = new URL(item.url);

    if (
      ![
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "youtu.be",
        "www.youtu.be",
        "www.youtube-nocookie.com"
      ].includes(parsedUrl.hostname)
    ) {
      return false;
    }

    const identity = item.video_id || item.url;

    if (seen.has(identity)) {
      return false;
    }

    seen.add(identity);
    return true;
  });

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
  note: "These are discovery results only. Confirm usage rights before registering or processing a video."
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

// Register an authorized video source for the signed-in user.
app.post("/api/sources", requireUser, async (req, res) => {
const { title, source_url, permission_confirmed } = req.body || {};

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

// List only sources belonging to the signed-in user.
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

return res.json({ sources: data });

} catch (error) {
console.error("Source listing error:", error.message);

return res.status(500).json({
  error: "Could not retrieve content sources."
});

}
});

// Create a clipping job only for a source owned by this user.
app.post("/api/jobs", requireUser, async (req, res) => {
const { source_id, target_platforms } = req.body || {};

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
  message: "Clipping job queued. Processing is not yet implemented.",
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
.select("id, source_id, status, target_platforms, error_message, created_at, updated_at")
.eq("user_id", req.user.id)
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
});

// Get a job and only its clips belonging to the signed-in user.
app.get("/api/jobs/:id", requireUser, async (req, res) => {
if (!validUuid(req.params.id)) {
return res.status(400).json({
error: "Invalid job ID."
});
}

try {
const { data: job, error: jobError } = await supabase
.from("clipping_jobs")
.select("id, source_id, status, target_platforms, error_message, created_at, updated_at")
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
  .select("id, title, start_seconds, end_seconds, video_url, caption_text, status, created_at")
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

app.listen(PORT, "0.0.0.0", () => {
console.log("ClipForge AI running on port ${PORT}");
});
