const jwt = require('jsonwebtoken');
require('dotenv').config();

const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxNzc0MDk4NzM3MzI1IiwidXNlcm5hbWUiOiJBZG1pbiIsInR5cCI6ImFjY2VzcyIsImlhdCI6MTc3NTM5MzU0MiwiZXhwIjoxNzc1Mzk0NDQyfQ.Qg-lRC_uAG9-fQRcaFUQ2c40Lgf-y-uts1WwhvVphCs";

try {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  console.log("✅ VALID TOKEN");
  console.log(decoded);
} catch (err) {
  console.log("❌ ERROR:", err.message);
}