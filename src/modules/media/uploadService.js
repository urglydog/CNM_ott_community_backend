const { s3Client } = require("../../config/awsConfig");
const { GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { randomUUID } = require("crypto");

const BUCKET_NAME = process.env.S3_BUCKET_NAME || "ott-community-media";
const AWS_REGION = process.env.AWS_REGION || "ap-southeast-2";

function buildPublicUrl(key, bucket) {
  const customBase =
    process.env.S3_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_S3_PUBLIC_BASE_URL;
  const normalizedBase = String(customBase || "").trim();

  if (normalizedBase) {
    if (/^https?:\/\//i.test(normalizedBase)) {
      return `${normalizedBase.replace(/\/$/, "")}/${key}`;
    }

    // Cho phép cấu hình nhanh bằng tên bucket thuần: "my-bucket"
    if (/^[a-z0-9.-]+$/i.test(normalizedBase) && !normalizedBase.includes("/")) {
      return `https://${normalizedBase}.s3.${AWS_REGION}.amazonaws.com/${key}`;
    }

    return `https://${normalizedBase.replace(/\/$/, "")}/${key}`;
  }
  return `https://${bucket}.s3.${AWS_REGION}.amazonaws.com/${key}`;
}

async function getPresignedUploadUrl({ keyPrefix, contentType }) {
  const key = `${keyPrefix || "uploads"}/${randomUUID()}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: contentType || "application/octet-stream",
  });

  const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

  return {
    uploadUrl: url,
    key,
    bucket: BUCKET_NAME,
  };
}

function extractKeyFromS3Url(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    const pathname = decodeURIComponent(parsed.pathname || "");
    const key = pathname.replace(/^\//, "");
    return key || null;
  } catch {
    return null;
  }
}

async function getPresignedViewUrl({ key, url }) {
  const resolvedKey = String(key || "").trim() || extractKeyFromS3Url(url);
  if (!resolvedKey) {
    throw new Error("Thiếu key ảnh đại diện");
  }

  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: resolvedKey,
  });

  const viewUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  return {
    key: resolvedKey,
    bucket: BUCKET_NAME,
    viewUrl,
  };
}

async function uploadBufferDirect({ keyPrefix, contentType, buffer }) {
  const key = `${keyPrefix || "uploads"}/${randomUUID()}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType || "application/octet-stream",
    }),
  );

  return {
    key,
    bucket: BUCKET_NAME,
    url: buildPublicUrl(key, BUCKET_NAME),
  };
}

module.exports = {
  getPresignedUploadUrl,
  uploadBufferDirect,
  getPresignedViewUrl,
};
