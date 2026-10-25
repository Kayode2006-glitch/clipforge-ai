
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { spawn } = require("child_process");

const MEDIA_ROOT = path.resolve(
  process.env.CLIPFORGE_MEDIA_DIR ||
    path.join(os.tmpdir(), "clipforge-ai")
);

const UPLOAD_DIR = path.join(MEDIA_ROOT, "uploads");
const OUTPUT_DIR = path.join(MEDIA_ROOT, "clips");

const MAX_CLIP_SECONDS = 180;

function ensureDirectories() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function isInsideDirectory(filePath, directory) {
  const relative = path.relative(
    path.resolve(directory),
    path.resolve(filePath)
  );

  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function renderClip({
  inputPath,
  startSeconds = 0,
  durationSeconds = 30,
  aspectRatio = "9:16"
}) {
  return new Promise((resolve, reject) => {
    try {
      ensureDirectories();

      const source = path.resolve(inputPath);

      if (!isInsideDirectory(source, UPLOAD_DIR)) {
        return reject(
          new Error("Video source must be inside the authorized uploads directory.")
        );
      }

      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
        return reject(new Error("Source video file was not found."));
      }

      if (
        !Number.isFinite(startSeconds) ||
        startSeconds < 0 ||
        startSeconds > 86400
      ) {
        return reject(new Error("Invalid clip start time."));
      }

      if (
        !Number.isFinite(durationSeconds) ||
        durationSeconds <= 0 ||
        durationSeconds > MAX_CLIP_SECONDS
      ) {
        return reject(
          new Error("Clip duration must be between 1 and 180 seconds.")
        );
      }

      const dimensions = {
        "9:16": [1080, 1920],
        "16:9": [1920, 1080],
        "1:1": [1080, 1080],
        "4:5": [1080, 1350]
      };

      if (!Object.hasOwn(dimensions, aspectRatio)) {
        return reject(new Error("Unsupported output aspect ratio."));
      }

      const [width, height] = dimensions[aspectRatio];
      const outputPath = path.join(
        OUTPUT_DIR,
        `${randomUUID()}.mp4`
      );

      const filter =
        `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height}`;

      const args = [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-ss", String(startSeconds),
        "-i", source,
        "-t", String(durationSeconds),
        "-map", "0:v:0",
        "-map", "0:a?",
        "-vf", filter,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-max_muxing_queue_size", "1024",
        outputPath
      ];

      const ffmpeg = spawn(
        process.env.FFMPEG_PATH || "ffmpeg",
        args,
        { stdio: ["ignore", "ignore", "pipe"] }
      );

      let errorOutput = "";
      let settled = false;

      const timeout = setTimeout(() => {
        ffmpeg.kill("SIGKILL");
      }, 10 * 60 * 1000);

      function fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);

        if (fs.existsSync(outputPath)) {
          fs.rmSync(outputPath, { force: true });
        }

        reject(error);
      }

      ffmpeg.stderr.on("data", chunk => {
        if (errorOutput.length < 12000) {
          errorOutput += chunk.toString();
        }
      });

      ffmpeg.on("error", error => {
        fail(new Error(`Could not start FFmpeg: ${error.message}`));
      });

      ffmpeg.on("close", code => {
        if (settled) return;

        if (code !== 0) {
          return fail(
            new Error(
              `Video rendering failed: ${errorOutput.slice(-1500)}`
            )
          );
        }

        if (
          !fs.existsSync(outputPath) ||
          fs.statSync(outputPath).size === 0
        ) {
          return fail(new Error("FFmpeg produced no output video."));
        }

        settled = true;
        clearTimeout(timeout);

        resolve({
          id: path.basename(outputPath, ".mp4"),
          outputPath,
          downloadName: `${path.basename(outputPath)}`,
          aspectRatio,
          width,
          height,
          durationSeconds
        });
      });
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = {
  renderClip,
  ensureDirectories,
  UPLOAD_DIR,
  OUTPUT_DIR,
  MAX_CLIP_SECONDS
};
          
