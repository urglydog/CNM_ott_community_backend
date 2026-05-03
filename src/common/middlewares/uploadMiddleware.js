const multer = require("multer");

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/m4a",
  "audio/aac",
  "audio/x-m4a"
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const storage = multer.memoryStorage();

function fileFilter(req, file, cb) {
  if (!file || !ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return cb(
      new Error("Only images, pdf, docx, txt, and audio files are allowed"),
    );
  }
  return cb(null, true);
}
//thu coi

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter,
});

module.exports = upload;
