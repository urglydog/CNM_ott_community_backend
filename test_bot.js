const http = require("http");

const postData = JSON.stringify({
  message: "chính sách zalo là gì",
});

const options = {
  hostname: "localhost",
  port: 4000,
  path: "/api/v1/bot/chat",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(postData),
  },
};

const req = http.request(options, (res) => {
  let data = "";
  res.on("data", (chunk) => {
    data += chunk;
  });
  res.on("end", () => {
    console.log("Response:", data);
  });
});

req.on("error", (e) => {
  console.error(`problem with request: ${e.message}`);
});

req.write(postData);
req.end();
