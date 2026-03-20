const { s3Client } = require('../config/awsConfig');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');

const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'ott-community-media';

async function getPresignedUploadUrl({ keyPrefix, contentType }) {
  const key = `${keyPrefix || 'uploads'}/${uuidv4()}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: contentType || 'application/octet-stream'
  });

  const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

  return {
    uploadUrl: url,
    key,
    bucket: BUCKET_NAME
  };
}

module.exports = {
  getPresignedUploadUrl
};
