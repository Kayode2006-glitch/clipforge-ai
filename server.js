
require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.json({
    name: "ClipForge AI",
    status: "online",
    message: "Your AI clipping platform backend is running.",
    version: "1.0.0"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "ClipForge AI API",
    timestamp: new Date().toISOString()
  });
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
